// ============================================================
// POST /api/telegram-webhook
//
// Personal assistant over Telegram. Telegram calls this endpoint with an
// "update" object every time you message your bot. It reads the same
// Supabase app_state rows the dashboard itself reads/writes, hands them to
// Claude as context alongside a set of tools that can actually change your
// data (log a purchase, add/complete a to-do, log water, mark a supplement
// taken, mark today's workout done), then replies back to you in Telegram.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN      from @BotFather
//   TELEGRAM_WEBHOOK_SECRET any random string you make up — locks this
//                           endpoint so only real Telegram requests get in
//                           (verified against the X-Telegram-Bot-Api-Secret-
//                           Token header Telegram sends on every webhook
//                           call once registered via /api/telegram-set-webhook)
//   ANTHROPIC_API_KEY       server-side key (separate from the one saved in
//                           Nova's browser localStorage — this runs with no
//                           browser involved)
//   SUPABASE_URL, SUPABASE_ANON_KEY   same ones the dashboard already uses
//
// Optional:
//   TELEGRAM_CHAT_ID        restricts the bot to only your chat. Until this
//                           is set, the FIRST message from anyone gets a
//                           reply with their chat id (and nothing else —
//                           no data access, no Claude call) so you can copy
//                           it into Vercel. Once set, every other chat id is
//                           silently ignored.
//   REMINDER_TIMEZONE       IANA tz name, default 'America/New_York' — used
//                           for the same 6am-boundary / plain-date keys the
//                           dashboard itself uses, so writes land under the
//                           date the browser would compute.
//   SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//                           if all three are set (alongside a connected
//                           Google account — see google.html / SETUP.md),
//                           today's Calendar events, Gmail unread summary,
//                           and recent Drive files are read from the
//                           locked-down google_tokens table (see
//                           api/google-token-sync.js) and added to context.
//                           Missing/expired/disconnected Google just means
//                           that context is silently omitted, never an error.
//
// Every write tool below follows the same pattern the dashboard's own
// sync.js does: Supabase's app_state row is a full-object replace, not a
// per-field merge, so each tool reads the current row, merges its change
// into a copy of that object, and writes the whole thing back — dropping
// this step would silently wipe every OTHER key sharing that row.
// ============================================================

// Read fresh from process.env on every call rather than caching at module
// load time — matches send-reminders.js's convention, and means a test (or
// a future env-var rotation) doesn't need a fresh process/cold start to see
// the current value.
function tz() { return process.env.REMINDER_TIMEZONE || 'America/New_York'; }
const NW_CATS = ['cash', 'bank', 'stocks', 'crypto', 'other'];
const PUR_CCY_KEYS = ['CHF', 'USD', 'EUR', 'GBP', 'DOP'];
const KNOWN_AUTO_SOURCES = ['gym', 'reading', 'stretch_am', 'stretch_pm', 'business', 'water', 'supplements', 'peak_morning'];

// ---------- date helpers (must match the dashboard's own conventions) ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function tzNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: tz() })); }
function nowHM() { const d = tzNow(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
// Plain calendar date — used by po-water.html (water logs) and gym.html (workout-done).
function plainDateKey() {
  const d = tzNow();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
// 6am-boundary date — used by main.html (goals:<key>, habits:log) and health.html (stack:taken:<key>).
function activeDateKey() {
  const d = tzNow();
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
// Same 6am-boundary "today" as activeDateKey(), but as a Date — needed to
// check a recurring item's weekday, matching main.html's getActiveDateObj().
function activeDateObj() {
  const d = tzNow();
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return d;
}
// Mirrors main.html's isRecurScheduledToday() — whether a recur:defs entry
// is scheduled for the active (6am-boundary) day.
function isRecurScheduledToday(def) {
  if (def.freq === 'daily') return true;
  if (def.freq === 'days') return Array.isArray(def.days) && def.days.indexOf(activeDateObj().getDay()) !== -1;
  return false;
}
// Consecutive days ending at `anchorDate` (or the day before it, if
// anchorDate itself isn't done yet — so an unlogged "today" doesn't read as
// streak-broken before the day is even over). Mirrors the exact "forgiving"
// streak rule already used by main.html's habit streaks, gym.html's
// bodyweight-log streak, and gym.html's stretch-routine streaks —
// isDoneOnDate is whatever day-key convention (plain or 6am-boundary) the
// caller's anchorDate already matches.
function computeStreak(anchorDate, isDoneOnDate) {
  const cursor = new Date(anchorDate);
  const keyOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  if (!isDoneOnDate(keyOf(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (isDoneOnDate(keyOf(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}
// Plain UTC calendar-date slice — used by reading.html's session log
// (new Date().toISOString().slice(0,10)), a third, distinct convention from
// the two above. Deliberately NOT timezone-adjusted, to match exactly.
function utcDateSlice() { return new Date().toISOString().slice(0, 10); }

function fuzzyFind(list, needle, keyFn) {
  const target = String(needle).toLowerCase();
  let hit = list.find(x => String(keyFn(x)).toLowerCase() === target);
  if (!hit) hit = list.find(x => String(keyFn(x)).toLowerCase().includes(target) || target.includes(String(keyFn(x)).toLowerCase()));
  return hit || null;
}

// ---------- Supabase app_state row helpers ----------
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
// Retries a transient failure (network blip, 429 rate limit, 5xx) up to
// maxRetries extra times with a short linear backoff, since this previously
// had zero resilience — a single dropped connection mid-chat would surface
// as "something broke on my end" instead of quietly succeeding on retry.
// Does NOT retry other 4xx statuses (bad request/auth/etc.) — retrying those
// can't help and would only delay a real error from surfacing.
async function fetchWithRetry(url, opts, maxRetries) {
  maxRetries = maxRetries == null ? 3 : maxRetries;
  for (let attempt = 0; ; attempt++) {
    let res, err;
    try { res = await fetch(url, opts); } catch (e) { err = e; }
    const retryable = err || (res && (res.status === 429 || res.status >= 500));
    if (!retryable || attempt >= maxRetries) {
      if (err) throw err;
      return res;
    }
    await sleep(300 * (attempt + 1));
  }
}
async function readRow(key) {
  const url = process.env.SUPABASE_URL + '/rest/v1/app_state?key=eq.' + encodeURIComponent(key) + '&select=data';
  const r = await fetchWithRetry(url, { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY } });
  if (!r.ok) throw new Error('Supabase read failed for "' + key + '": ' + r.status);
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || {};
}
async function writeRow(key, data) {
  const url = process.env.SUPABASE_URL + '/rest/v1/app_state?on_conflict=key';
  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('Supabase write failed for "' + key + '": ' + r.status + ' ' + (await r.text()));
}
// Read-modify-write in one step: `mutate` receives the row's current data
// object (safe to mutate directly) and its return value (if any) is passed
// back to the caller as the tool result.
// Friendly labels for the undo-confirmation reply — purely cosmetic, falls
// back to the raw key for anything not listed here.
const ROW_LABELS = {
  goals: 'to-dos/habits/recurring items', health: 'health/supplements/food log', 'po-coach': 'gym/fitness data',
  finance: 'finance', business: 'business', reading: 'reading', peak: 'Peak', caffeine: 'caffeine/nicotine', notes: 'notes',
};
// Read-modify-write in one step: `mutate` receives the row's current data
// object (safe to mutate directly) and its return value (if any) is passed
// back to the caller as the tool result. Also transparently snapshots the
// pre-mutation state into a dedicated 'last_action' row (skipped when the
// call didn't actually change anything, i.e. result.ok === false) so
// undo_last_action can revert ANY tool's most recent write without every
// executor having to wire up undo support individually.
async function patchRow(key, mutate) {
  const data = await readRow(key);
  const before = JSON.parse(JSON.stringify(data));
  const result = await mutate(data);
  await writeRow(key, data);
  if (!result || result.ok !== false) {
    await writeRow('last_action', { row: key, before, description: ROW_LABELS[key] || key, ts: Date.now() });
  }
  return result;
}
async function execUndoLastAction() {
  const last = await readRow('last_action');
  if (!last || !last.row) return { ok: false, reason: 'nothing to undo' };
  await writeRow(last.row, last.before);
  await writeRow('last_action', {});
  return { ok: true, undone: last.description || last.row };
}

// ---------- conversation memory (its own row, separate from dashboard data) ----------
// Keeps the last MAX_HISTORY_MESSAGES plain user/assistant text turns so the
// assistant has real short-term memory across separate Telegram messages,
// instead of starting from a blank slate every time. Deliberately stores
// only the final human-readable text of each turn — not the intermediate
// tool_use/tool_result scaffolding from callClaude()'s own internal loop,
// which is only ever meaningful within a single request.
const HISTORY_KEY = 'telegram-memory';
const MAX_HISTORY_MESSAGES = 20;
async function loadHistory() {
  const data = await readRow(HISTORY_KEY);
  return Array.isArray(data.history) ? data.history : [];
}
async function saveHistory(history) {
  await writeRow(HISTORY_KEY, { history: history.slice(-MAX_HISTORY_MESSAGES) });
}

// ---------- API usage/cost tracking (its own row, separate from dashboard data) ----------
// Anthropic's per-call `usage` (input/output token counts) is cheap to read
// off every response but otherwise invisible unless you're watching the
// console.anthropic.com dashboard — this persists a running total plus a
// day-bucketed breakdown so the assistant can just answer "how much have I
// spent on you this month" from context, same as any other read-only data.
// Cost is an ESTIMATE from configurable per-token prices, not a real billing
// figure — Anthropic's actual pricing can change, and this has no way to
// know that on its own, so the defaults below may drift out of date.
const USAGE_KEY = 'telegram-usage';
const USAGE_HISTORY_DAYS = 90; // days of daily breakdown kept before pruning — plenty for "this month"-scale questions without the row growing forever
// Read fresh from process.env on every call, same reasoning as tz() above —
// these are USD per 1M tokens, configurable since Anthropic's real pricing
// can change and this has no way to know that on its own.
function inputPricePerMTok() { return Number(process.env.ANTHROPIC_INPUT_PRICE_PER_MTOK) || 3; }
function outputPricePerMTok() { return Number(process.env.ANTHROPIC_OUTPUT_PRICE_PER_MTOK) || 15; }

function estimateCostUSD(inputTokens, outputTokens) {
  return (inputTokens / 1e6) * inputPricePerMTok() + (outputTokens / 1e6) * outputPricePerMTok();
}
function round2(n) { return Math.round(n * 100) / 100; }

async function recordApiUsage(usage) {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return;
  const data = await readRow(USAGE_KEY);
  const byDate = data.byDate || {};
  const today = plainDateKey();
  const day = byDate[today] || { inputTokens: 0, outputTokens: 0, calls: 0 };
  day.inputTokens += usage.inputTokens;
  day.outputTokens += usage.outputTokens;
  day.calls += 1;
  byDate[today] = day;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - USAGE_HISTORY_DAYS);
  Object.keys(byDate).forEach((k) => { if (new Date(k + 'T00:00:00') < cutoff) delete byDate[k]; });
  await writeRow(USAGE_KEY, {
    byDate,
    totalInputTokens: (data.totalInputTokens || 0) + usage.inputTokens,
    totalOutputTokens: (data.totalOutputTokens || 0) + usage.outputTokens,
    totalCalls: (data.totalCalls || 0) + 1,
  });
}

// Summarizes the persisted usage row into the shape handed to Claude as
// context — today / last 30 days / all-time, each as a call count plus an
// estimated USD cost, rather than exposing raw token counts the model would
// have to do its own arithmetic on.
function summarizeApiUsage(data) {
  if (!data || !data.totalCalls) return null;
  const byDate = data.byDate || {};
  const today = byDate[plainDateKey()] || { inputTokens: 0, outputTokens: 0, calls: 0 };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const last30 = Object.keys(byDate).reduce((acc, k) => {
    if (new Date(k + 'T00:00:00') >= cutoff) {
      acc.inputTokens += byDate[k].inputTokens; acc.outputTokens += byDate[k].outputTokens; acc.calls += byDate[k].calls;
    }
    return acc;
  }, { inputTokens: 0, outputTokens: 0, calls: 0 });
  return {
    today: { calls: today.calls, estimatedCostUSD: round2(estimateCostUSD(today.inputTokens, today.outputTokens)) },
    last30Days: { calls: last30.calls, estimatedCostUSD: round2(estimateCostUSD(last30.inputTokens, last30.outputTokens)) },
    allTime: { calls: data.totalCalls, estimatedCostUSD: round2(estimateCostUSD(data.totalInputTokens || 0, data.totalOutputTokens || 0)) },
  };
}

async function fetchExchangeRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CHF');
    const data = await res.json();
    if (data && data.rates) {
      return { CHF: 1, USD: data.rates.USD || 1, EUR: data.rates.EUR || 1, GBP: data.rates.GBP || 1, DOP: data.rates.DOP || 1 };
    }
  } catch (e) {}
  return { CHF: 1, USD: 1, EUR: 1, GBP: 1, DOP: 1 };
}

// ============================================================
// Tools — each maps 1:1 to something the dashboard's own UI already does.
// ============================================================
const TOOLS = [
  {
    name: 'log_purchase',
    description: 'Log a purchase in the Finance tab\'s Purchases list. If from_account matches a real Net Worth account by name, that account is deducted immediately (same as picking "From account" in the dashboard). If it doesn\'t match anything, the purchase is still logged with no account link.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What was bought, e.g. "Groceries"' },
        amount: { type: 'number', description: 'Amount in the given currency (not CHF-converted — that happens automatically)' },
        currency: { type: 'string', enum: PUR_CCY_KEYS, description: 'Defaults to USD if unsure' },
        category: { type: 'string', description: 'Free-text category, e.g. "food", "shopping" — defaults to "other"' },
        from_account: { type: 'string', description: 'Optional: name of a real Net Worth account (e.g. "Checking", "Cash") to deduct from. Omit if not mentioned.' },
      },
      required: ['name', 'amount'],
    },
  },
  {
    name: 'add_todo',
    description: 'Add a new to-do. Defaults to today\'s list on the Main tab. For a one-off future reminder — e.g. "remind me to renew my passport in 3 months" or "remind me to call the dentist next Tuesday" — set date to that day instead (compute the actual calendar date yourself from what the user said); it\'ll show up on the Schedule/Calendar view for that day and get reminded on its own, exactly like something added there directly. Do NOT use add_recurring_item for a single future reminder — that\'s only for things that repeat.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        date: { type: 'string', description: 'Optional, YYYY-MM-DD. Omit for today. Set this for a one-off reminder on a specific future (or past) day.' },
        time: { type: 'string', description: 'Optional 24h HH:MM — only set this if the user wants a reminder at a specific time that day.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'mark_todo_done',
    description: 'Mark an existing to-do on today\'s list as done, matched by text (exact or partial match).',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'The to-do text, or close to it' } }, required: ['text'] },
  },
  {
    name: 'log_water',
    description: 'Log water intake for today (one "serving" in whatever unit — bottle/glass/oz — is configured on the Water tracker).',
    input_schema: { type: 'object', properties: { count: { type: 'number', description: 'How many servings to add, default 1' } }, required: [] },
  },
  {
    name: 'mark_supplement_taken',
    description: 'Mark a supplement/item in the daily stack as taken today, matched by name (exact or partial match).',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'mark_gym_done',
    description: 'Mark today\'s workout as done on the Gym tab.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'log_workout_set',
    description: 'Log one set (weight + reps) for a specific exercise in the current workout program, matched by name. Defaults to right now, but can backdate to fix a missed or accidentally-deleted log from an earlier day.',
    input_schema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', description: 'Exercise name, e.g. "Bench Press"' },
        weight: { type: 'number', description: 'Weight used (in whatever unit the program is configured for)' },
        reps: { type: 'number' },
        date: { type: 'string', description: 'Optional, YYYY-MM-DD — only set this if the user is logging/restoring a set for a past day (e.g. "put back the set I deleted from July 10th"). Omit entirely to log for right now.' },
      },
      required: ['exercise', 'weight', 'reps'],
    },
  },
  {
    name: 'mark_exercise_done',
    description: 'Mark a specific exercise as done for today\'s workout, without necessarily logging a set.',
    input_schema: { type: 'object', properties: { exercise: { type: 'string' } }, required: ['exercise'] },
  },
  {
    name: 'log_cardio_session',
    description: 'Log a cardio session (treadmill, bike, run, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        duration_min: { type: 'number' },
        speed_mph: { type: 'number' },
        incline: { type: 'number' },
        distance_mi: { type: 'number' },
        avg_hr: { type: 'number' },
        peak_hr: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['duration_min'],
    },
  },
  {
    name: 'mark_stretch_done',
    description: 'Mark a stretch routine (AM or PM) done for today — either one specific item, or the whole routine if no item is named.',
    input_schema: {
      type: 'object',
      properties: {
        routine: { type: 'string', enum: ['am', 'pm'] },
        item: { type: 'string', description: 'Optional: a specific stretch item name. Omit to mark the entire routine done.' },
      },
      required: ['routine'],
    },
  },
  {
    name: 'log_body_weight',
    description: 'Log today\'s body weight on the Gym tab\'s weight tracker (updates today\'s entry if one already exists).',
    input_schema: { type: 'object', properties: { weight: { type: 'number' } }, required: ['weight'] },
  },
  {
    name: 'log_affiliate_commit',
    description: 'Mark a side-hustle affiliate commitment as done for today, matched by its label.',
    input_schema: { type: 'object', properties: { commitment: { type: 'string' } }, required: ['commitment'] },
  },
  {
    name: 'log_affiliate_revenue',
    description: 'Log affiliate revenue earned today on the Business tab.',
    input_schema: {
      type: 'object',
      properties: { amount: { type: 'number' }, note: { type: 'string' } },
      required: ['amount'],
    },
  },
  {
    name: 'log_editing_delivery',
    description: 'Log one completed deliverable for an editing client today, matched by client name (capped at that client\'s daily target).',
    input_schema: { type: 'object', properties: { client: { type: 'string' } }, required: ['client'] },
  },
  {
    name: 'log_editing_payment',
    description: 'Log a payment received from an editing client, matched by name — also marks that client as paid.',
    input_schema: {
      type: 'object',
      properties: { client: { type: 'string' }, amount: { type: 'number' } },
      required: ['client', 'amount'],
    },
  },
  {
    name: 'log_reading_session',
    description: 'Update reading progress for a book/item (matched by title) and log today\'s session.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        current_page: { type: 'number', description: 'Optional: the page you\'re now on. Omit if not mentioned.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_book',
    description: 'Add a new book/course/article/video to the Reading tab.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['book', 'course', 'article', 'video'] },
        author: { type: 'string' },
        total_pages: { type: 'number' },
      },
      required: ['title'],
    },
  },
  {
    name: 'mark_habit_done',
    description: 'Mark a daily habit (Main tab\'s Daily Habits list — separate from the to-do list) as done for today, matched by name.',
    input_schema: { type: 'object', properties: { habit: { type: 'string' } }, required: ['habit'] },
  },
  {
    name: 'adjust_net_worth_account',
    description: 'Set or adjust the balance of a real Net Worth account. Creates the account if no account by that name exists yet in that category.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: NW_CATS },
        account: { type: 'string', description: 'Account name, e.g. "Checking"' },
        amount: { type: 'number' },
        mode: { type: 'string', enum: ['set', 'add'], description: '"set" replaces the balance outright; "add" adds (or, if negative, subtracts) amount to/from the current balance. Defaults to "add".' },
      },
      required: ['category', 'account', 'amount'],
    },
  },
  {
    name: 'add_subscription',
    description: 'Add a recurring subscription to the Finance tab.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string', enum: PUR_CCY_KEYS },
        period: { type: 'string', enum: ['monthly', 'yearly', 'weekly'] },
        renewal_date: { type: 'string', description: 'Optional, YYYY-MM-DD' },
        from_account: { type: 'string', description: 'Optional: a real Net Worth account name to link for auto-deduction' },
      },
      required: ['name', 'amount'],
    },
  },
  {
    name: 'cancel_subscription',
    description: 'Remove a subscription from the Finance tab, matched by name.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'add_debt',
    description: 'Add a debt/loan (e.g. a credit card balance, car loan, student loan) to the Finance tab\'s debt tracker and payoff calculator. Separate from net worth accounts and subscriptions — this is specifically for money owed, not money held.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        balance: { type: 'number' },
        currency: { type: 'string', enum: PUR_CCY_KEYS },
        apr: { type: 'number', description: 'Annual interest rate as a percentage, e.g. 22.99 for 22.99% — if mentioned' },
        min_payment: { type: 'number', description: 'The minimum monthly payment, if mentioned' },
      },
      required: ['name', 'balance'],
    },
  },
  {
    name: 'add_wishlist_item',
    description: 'Add an item to the Finance tab\'s wishlist.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', enum: PUR_CCY_KEYS } },
      required: ['name', 'amount'],
    },
  },
  {
    name: 'add_order',
    description: 'Add an incoming order to the Finance tab. If from_account matches a real Net Worth account, it\'s deducted immediately (same as the dashboard\'s own add-with-account behavior); otherwise it\'s just tracked with no account link yet.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string', enum: PUR_CCY_KEYS },
        from_account: { type: 'string' },
        expected_date: { type: 'string', description: 'Optional, YYYY-MM-DD expected arrival date (cosmetic only)' },
      },
      required: ['name', 'amount'],
    },
  },
  {
    name: 'log_bedtime',
    description: 'Marks that the user is going to bed right now, so the next morning check-in can compute REAL sleep duration automatically instead of the user having to remember/estimate a number. Call this whenever the user says something like "going to bed", "heading to sleep", "night" — no other fields needed. Only pass `at` when backfilling a specific past time the user mentioned (e.g. "I went to bed at 11:30 last night, forgot to tell you") — compute the actual ISO datetime yourself, same as add_todo\'s date field; omit it for "right now".',
    input_schema: {
      type: 'object',
      properties: {
        at: { type: 'string', description: 'ISO 8601 datetime, only for backfilling a specific past bedtime. Omit to use the current moment.' },
      },
      required: [],
    },
  },
  {
    name: 'log_morning_checkin',
    description: 'Log this morning\'s check-in on the Peak tab: wake time, resting heart rate, sleep hours, and/or sleep quality. Only include fields the user actually mentioned — omit the rest. If a bedtime was tracked earlier via log_bedtime and sleep_hours isn\'t explicitly given, sleep hours (and wake time) are computed automatically from the real elapsed time — more accurate than an estimate, so DON\'T pass sleep_hours yourself in that case unless the user states an exact number that should override it. Call this on any wake-up signal — "good morning", "just woke up", "I\'m up" — even with zero other details, since that alone is enough to close out a tracked night\'s sleep.',
    input_schema: {
      type: 'object',
      properties: {
        wake_time: { type: 'string', description: '24h HH:MM the user woke up, if explicitly mentioned. Omit to use the current moment when a bedtime was being tracked.' },
        rhr: { type: 'number', description: 'Resting heart rate, if mentioned' },
        sleep_hours: { type: 'number', description: 'Only pass this if the user stated an exact number themselves — otherwise omit and let a tracked bedtime compute it.' },
        sleep_quality: { type: 'number', description: '1-5 rating of sleep quality, if mentioned (e.g. "sleep was a 5" -> 5)' },
      },
      required: [],
    },
  },
  {
    name: 'log_feeling_checkin',
    description: 'Log a feeling/stress check-in on the Peak tab. Unlike most other logging tools, this is meant to be called MULTIPLE times a day — each check-in is its own entry, not a once-daily thing.',
    input_schema: {
      type: 'object',
      properties: {
        feeling: { type: 'number', description: '1-5 mood/energy rating (1=very low, 5=great), if mentioned' },
        stress: { type: 'number', description: '1-5 stress rating (1=very calm, 5=very stressed), if mentioned' },
        note: { type: 'string', description: 'Optional short context, e.g. "big deadline today"' },
      },
      required: [],
    },
  },
  {
    name: 'add_recurring_item',
    description: 'Create a new recurring item on the Main tab\'s Recurring Items list (e.g. a daily reminder to do something). If the item corresponds to something this assistant can auto-detect as done (a Peak morning check-in, a gym day, a reading session, water, supplements, AM/PM stretch routines, or side-hustle activity), set auto_source so it self-completes instead of needing a manual checkbox.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        freq: { type: 'string', enum: ['daily', 'days'], description: 'Defaults to "daily" if not specified' },
        days: { type: 'array', items: { type: 'number' }, description: 'Only used when freq is "days" — 0=Sunday through 6=Saturday' },
        time: { type: 'string', description: 'Optional 24h HH:MM this should be reminded about' },
        auto_source: { type: 'string', enum: KNOWN_AUTO_SOURCES, description: 'Optional — see description above' },
        note: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'log_food_entry',
    description: 'Log a meal/food/drink entry on the Health tab\'s calorie tracker. There is no food database here — estimate calories/protein/carbs/fat yourself from general nutrition knowledge (a careful home-cook/restaurant-portion estimate), the same way the dashboard\'s own AI photo-estimate feature works, unless the user gives you exact numbers.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What was eaten/drunk, e.g. "Chicken burrito bowl"' },
        calories: { type: 'number' },
        protein: { type: 'number', description: 'Grams, estimate if not given' },
        carbs: { type: 'number', description: 'Grams, estimate if not given' },
        fat: { type: 'number', description: 'Grams, estimate if not given' },
      },
      required: ['name', 'calories'],
    },
  },
  {
    name: 'log_caffeine',
    description: 'Log a caffeine intake entry on the Caffeine tab. There is no lookup table here — use your own general knowledge of typical caffeine content for the named drink/product (matching the dashboard\'s own preset amounts, e.g. Red Bull 8.4oz ≈ 80mg, Monster 16oz ≈ 160mg, an espresso shot ≈ 64mg, an 8oz brewed coffee ≈ 95mg, a 200mg pre-workout scoop) unless the user states an exact amount.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Red Bull (8.4 oz)"' },
        mg: { type: 'number', description: 'Milligrams of caffeine — estimate from general knowledge if not given exactly' },
      },
      required: ['name', 'mg'],
    },
  },
  {
    name: 'log_nicotine',
    description: 'Log a nicotine intake entry (pouch/vape/etc.) on the Caffeine tab. Estimate mg from general knowledge if not given exactly (e.g. a standard Zyn pouch is 3, 6, or 9mg).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Zyn 6mg (Wintergreen)"' },
        mg: { type: 'number' },
      },
      required: ['name', 'mg'],
    },
  },
  {
    name: 'add_note',
    description: 'Add a new note on the Notes tab — for anything the user wants jotted down/remembered that doesn\'t fit a to-do or another tracker.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional short title' },
        body: { type: 'string' },
      },
      required: ['body'],
    },
  },
  {
    name: 'undo_last_action',
    description: 'Reverts the single most recent change made by any tool call in this chat (whichever one that was) back to exactly how it was before — e.g. "undo that", "oops, undo", "that was wrong, undo it". Only one level of undo is kept — it reverts the very last write, not a specific earlier one. Use this instead of trying to manually construct the opposite change yourself. Does NOT cover the Google Calendar tools below — those write to a real external account, not the dashboard\'s own data, so there\'s nothing here to revert them.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_calendar_event',
    description: 'Creates a REAL event on the user\'s actual Google Calendar (not the dashboard\'s own Schedule/Calendar to-do list — use add_todo for that instead). Only available if Google is connected. Compute actual ISO dates/times yourself from what the user said, same as add_todo\'s date field.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 datetime (e.g. "2026-08-03T14:00:00-04:00") for a timed event, or a plain YYYY-MM-DD for an all-day event.' },
        end: { type: 'string', description: 'Same format as start. For a timed event with no explicit end mentioned, default to 1 hour after start.' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'Modifies an existing REAL Google Calendar event (e.g. "move my 3pm to 4pm", "rename the dentist thing to dentist - cleaning"). Needs event_id — get it from today\'s Calendar context if it\'s there, otherwise call list_calendar_events first to find it. Only the fields provided are changed; anything omitted is left as-is.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        title: { type: 'string' },
        start: { type: 'string', description: 'Same format as create_calendar_event\'s start. Omit if not changing.' },
        end: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'Permanently cancels/deletes a REAL Google Calendar event (e.g. "cancel the dentist thing", "delete my 3pm"). Needs event_id — get it from today\'s Calendar context if it\'s there, otherwise call list_calendar_events first to find it. This cannot be undone — if there\'s real ambiguity about which event is meant, confirm with the user before calling this rather than guessing.',
    input_schema: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
  },
  {
    name: 'list_calendar_events',
    description: 'Looks up real Google Calendar events (with their event_id) in a date range beyond just today — needed before update_calendar_event/delete_calendar_event can target something not already shown in today\'s context.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      required: ['start_date', 'end_date'],
    },
  },
];

async function execLogPurchase(args) {
  const currency = PUR_CCY_KEYS.includes(args.currency) ? args.currency : 'USD';
  const rates = await fetchExchangeRates();
  const rate = rates[currency] || 1;
  const amountCHF = Number(args.amount) / rate;
  return patchRow('finance', (finance) => {
    let fromCat = null, fromAccount = null;
    if (args.from_account) {
      for (const cat of NW_CATS) {
        const items = finance['nw:' + cat] || [];
        const idx = items.findIndex(i => String(i.name).toLowerCase() === String(args.from_account).toLowerCase());
        if (idx >= 0) {
          items[idx].amount = (Number(items[idx].amount) || 0) - amountCHF;
          finance['nw:' + cat] = items;
          fromCat = cat;
          fromAccount = items[idx].name;
          const activity = finance['nw:activity'] || [];
          activity.push({ ts: Date.now(), cat, name: items[idx].name, delta: -amountCHF, kind: 'purchase' });
          if (activity.length > 50) activity.splice(0, activity.length - 50);
          finance['nw:activity'] = activity;
          break;
        }
      }
    }
    const purchases = finance['purchases'] || [];
    purchases.push({
      id: 'p_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
      name: args.name,
      amount: amountCHF,
      entered_amount: Number(args.amount),
      entered_currency: currency,
      category: args.category || 'other',
      fromCat, fromAccount,
      date: plainDateKey(),
      ts: Date.now(),
    });
    finance['purchases'] = purchases;
    return { ok: true, fromAccount: fromAccount || null, amountCHF: Math.round(amountCHF * 100) / 100 };
  });
}

async function execAddTodo(args) {
  let dateKey = activeDateKey();
  if (args.date != null) {
    // A plain calendar date, same convention as calendar.html's cursorDate —
    // deliberately NOT run through the 6am-boundary activeDateKey() logic,
    // since that's only meant to define "today," not an arbitrary target day.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date) || isNaN(new Date(args.date + 'T00:00:00').getTime())) {
      return { ok: false, reason: 'could not understand date "' + args.date + '"' };
    }
    dateKey = args.date;
  }
  const key = 'goals:' + dateKey;
  return patchRow('goals', (goals) => {
    const list = goals[key] || [];
    const entry = { text: args.text, done: false };
    if (args.time) entry.time = args.time;
    list.push(entry);
    goals[key] = list;
    return { ok: true, date: dateKey };
  });
}

async function execMarkTodoDone(args) {
  const key = 'goals:' + activeDateKey();
  return patchRow('goals', (goals) => {
    const list = goals[key] || [];
    const target = String(args.text).toLowerCase();
    let idx = list.findIndex(g => String(g.text).toLowerCase() === target);
    if (idx < 0) idx = list.findIndex(g => String(g.text).toLowerCase().includes(target) || target.includes(String(g.text).toLowerCase()));
    if (idx < 0) {
      // Not in today's materialized to-do list yet. Recurring items (Main
      // tab's Recurring Items) normally only get added to this list
      // client-side, by main.html's injectRecurringToday(), when the Main
      // tab is opened — so if the user hasn't opened it yet today, a
      // recurring item like "Skin care (AM)" won't be here at all even
      // though it's scheduled for today. Fall back to matching against the
      // recurring-item definitions directly and materialize it the same
      // way main.html would, so this works regardless of whether the
      // dashboard's been opened yet today.
      const defs = goals['recur:defs'] || [];
      const def = fuzzyFind(defs, args.text, d => d.name);
      if (def && isRecurScheduledToday(def) && !list.some(g => g.text === def.name)) {
        const entry = { text: def.name, done: false };
        if (def.time) entry.time = def.time;
        list.push(entry);
        idx = list.length - 1;
      }
    }
    if (idx < 0) return { ok: false, reason: 'no matching to-do found today for "' + args.text + '"' };
    list[idx].done = true;
    list[idx].doneAt = Date.now();
    goals[key] = list;
    return { ok: true, matched: list[idx].text };
  });
}

async function execLogWater(args) {
  return patchRow('health', (health) => {
    const w = health['po_water_v1'] || {};
    w.logs = w.logs || {};
    const key = plainDateKey();
    const inc = Number(args.count) || 1;
    w.logs[key] = (w.logs[key] || 0) + inc;
    health['po_water_v1'] = w;
    return { ok: true, todayCount: w.logs[key] };
  });
}

async function execMarkSupplementTaken(args) {
  return patchRow('health', (health) => {
    const items = health['stack:items'] || [];
    const target = String(args.name).toLowerCase();
    let item = items.find(i => String(i.name).toLowerCase() === target);
    if (!item) item = items.find(i => String(i.name).toLowerCase().includes(target) || target.includes(String(i.name).toLowerCase()));
    if (!item) return { ok: false, reason: 'no supplement found matching "' + args.name + '"' };
    const takenKey = 'stack:taken:' + activeDateKey();
    const taken = health[takenKey] || {};
    taken[item.id] = Date.now();
    health[takenKey] = taken;
    return { ok: true, matched: item.name };
  });
}

async function execMarkGymDone() {
  return patchRow('po-coach', (pc) => {
    const done = pc['po_coach_workout_done'] || {};
    done[plainDateKey()] = new Date().toISOString();
    pc['po_coach_workout_done'] = done;
    const streak = computeStreak(tzNow(), (k) => !!done[k]);
    return { ok: true, streak };
  });
}

// ---------- Gym: sets, per-exercise done, cardio, stretch, body weight ----------
async function execLogWorkoutSet(args) {
  return patchRow('po-coach', (pc) => {
    const state = pc['po_coach_v1'];
    const exercises = (state && state.exercises) || [];
    const ex = fuzzyFind(exercises, args.exercise, e => e.name);
    if (!ex) return { ok: false, reason: 'no exercise found matching "' + args.exercise + '"' };
    const when = args.date ? new Date(args.date + 'T12:00:00') : new Date();
    if (isNaN(when.getTime())) return { ok: false, reason: 'could not understand date "' + args.date + '"' };
    state.logs = state.logs || {};
    const arr = state.logs[ex.id] || [];
    const entry = { weight: Number(args.weight) || 0, reps: Number(args.reps) || 0, date: when.toISOString() };
    // gym.html's history/sparkline/best-set logic all assume this array is
    // in chronological (push) order, so a backdated set must be inserted
    // at its correct position rather than just appended at the end.
    let insertAt = arr.length;
    for (let i = 0; i < arr.length; i++) {
      if (new Date(arr[i].date).getTime() > when.getTime()) { insertAt = i; break; }
    }
    arr.splice(insertAt, 0, entry);
    state.logs[ex.id] = arr;
    pc['po_coach_v1'] = state;
    return { ok: true, matched: ex.name, date: when.toISOString().slice(0, 10) };
  });
}

async function execMarkExerciseDone(args) {
  return patchRow('po-coach', (pc) => {
    const state = pc['po_coach_v1'];
    const exercises = (state && state.exercises) || [];
    const ex = fuzzyFind(exercises, args.exercise, e => e.name);
    if (!ex) return { ok: false, reason: 'no exercise found matching "' + args.exercise + '"' };
    const exDone = pc['po_coach_ex_done'] || {};
    const key = plainDateKey();
    exDone[key] = exDone[key] || {};
    exDone[key][ex.id] = true;
    pc['po_coach_ex_done'] = exDone;
    return { ok: true, matched: ex.name };
  });
}

async function execLogCardioSession(args) {
  return patchRow('po-coach', (pc) => {
    const sessions = pc['cardio:sessions'] || [];
    sessions.push({
      id: 'cd' + Date.now() + Math.floor(Math.random() * 1000),
      ts: Date.now(),
      dateKey: plainDateKey(),
      durationMin: Number(args.duration_min) || 0,
      speedMph: args.speed_mph != null ? Number(args.speed_mph) : null,
      incline: args.incline != null ? Number(args.incline) : 0,
      distanceMi: args.distance_mi != null ? Number(args.distance_mi) : null,
      avgHr: args.avg_hr != null ? Number(args.avg_hr) : null,
      peakHr: args.peak_hr != null ? Number(args.peak_hr) : null,
      notes: args.notes || '',
      // Calorie/zone estimation reuses gym.html's own formula, which this
      // server-side tool doesn't replicate — left null rather than guessed;
      // the dashboard's own UI still computes/displays these normally for
      // sessions logged there.
      calories: null, calorieMethod: null, zone: null,
    });
    pc['cardio:sessions'] = sessions;
    return { ok: true };
  });
}

async function execMarkStretchDone(args) {
  const routineKey = args.routine === 'pm' ? 'stretch:pm:items' : 'stretch:am:items';
  return patchRow('po-coach', (pc) => {
    const items = pc[routineKey] || [];
    if (!items.length) return { ok: false, reason: 'no stretch items configured for ' + (args.routine === 'pm' ? 'PM' : 'AM') };
    const log = pc['stretch:log'] || {};
    const key = plainDateKey();
    const matched = [];
    if (args.item) {
      const item = fuzzyFind(items, args.item, i => i.name);
      if (!item) return { ok: false, reason: 'no stretch item found matching "' + args.item + '"' };
      log[item.id] = log[item.id] || {};
      log[item.id][key] = true;
      matched.push(item.name);
    } else {
      items.forEach(item => {
        log[item.id] = log[item.id] || {};
        log[item.id][key] = true;
        matched.push(item.name);
      });
    }
    pc['stretch:log'] = log;
    // Routine streak (not per-item) — mirrors gym.html's own
    // routineDoneOnDay(): only counts a day where every item in the
    // routine, not just the one(s) just marked, was checked off.
    const streak = computeStreak(tzNow(), (k) => items.every(item => !!(log[item.id] && log[item.id][k])));
    return { ok: true, matched, streak };
  });
}

async function execLogBodyWeight(args) {
  return patchRow('po-coach', (pc) => {
    const entries = pc['po_coach_weights'] || [];
    const key = plainDateKey();
    const existing = entries.find(e => e.dateKey === key);
    if (existing) existing.weight = Number(args.weight);
    else {
      entries.push({ dateKey: key, weight: Number(args.weight) });
      entries.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    }
    pc['po_coach_weights'] = entries;
    return { ok: true };
  });
}

// ---------- Business: affiliate commitments/revenue, editing deliveries/payments ----------
async function execLogAffiliateCommit(args) {
  return patchRow('business', (biz) => {
    const commitments = biz['biz:affiliate:commitments'] || [];
    const c = fuzzyFind(commitments, args.commitment, x => x.label);
    if (!c) return { ok: false, reason: 'no affiliate commitment found matching "' + args.commitment + '"' };
    const log = biz['biz:affiliate:commitLog'] || {};
    log[c.id] = log[c.id] || {};
    log[c.id][activeDateKey()] = true;
    biz['biz:affiliate:commitLog'] = log;
    return { ok: true, matched: c.label };
  });
}

async function execLogAffiliateRevenue(args) {
  return patchRow('business', (biz) => {
    const arr = biz['biz:affiliate:revenue'] || [];
    arr.push({
      id: 'rev_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      date: activeDateKey(), amount: Number(args.amount) || 0, note: args.note || '', ts: Date.now(),
    });
    biz['biz:affiliate:revenue'] = arr;
    return { ok: true };
  });
}

async function execLogEditingDelivery(args) {
  return patchRow('business', (biz) => {
    const clients = biz['biz:editing:clients'] || [];
    const client = fuzzyFind(clients, args.client, c => c.name);
    if (!client) return { ok: false, reason: 'no editing client found matching "' + args.client + '"' };
    const delivery = biz['biz:editing:deliveryLog'] || {};
    const key = activeDateKey();
    delivery[client.id] = delivery[client.id] || {};
    const cap = client.dailyDeliverables || Infinity;
    delivery[client.id][key] = Math.min(cap, (delivery[client.id][key] || 0) + 1);
    biz['biz:editing:deliveryLog'] = delivery;
    return { ok: true, matched: client.name, countToday: delivery[client.id][key] };
  });
}

async function execLogEditingPayment(args) {
  return patchRow('business', (biz) => {
    const clients = biz['biz:editing:clients'] || [];
    const client = fuzzyFind(clients, args.client, c => c.name);
    if (!client) return { ok: false, reason: 'no editing client found matching "' + args.client + '"' };
    const payments = biz['biz:editing:payments'] || [];
    payments.push({
      id: 'pay_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      clientId: client.id, date: activeDateKey(), amount: Number(args.amount) || 0, ts: Date.now(),
    });
    biz['biz:editing:payments'] = payments;
    // Mirrors business.html's own "Log payment" button — marking a payment
    // also flips that client's paymentStatus, in the same row.
    client.paymentStatus = 'paid';
    biz['biz:editing:clients'] = clients;
    return { ok: true, matched: client.name };
  });
}

// ---------- Reading ----------
async function execLogReadingSession(args) {
  return patchRow('reading', (reading) => {
    const items = reading['reading:items'] || [];
    const item = fuzzyFind(items, args.title, i => i.title);
    if (!item) return { ok: false, reason: 'no book/item found matching "' + args.title + '"' };
    if (args.current_page != null) {
      item.currentPage = Number(args.current_page);
      if (item.totalPages) item.progress = Math.round((item.currentPage / item.totalPages) * 100);
    }
    if (item.status === 'want') item.status = 'progress';
    item.updatedAt = Date.now();
    const todayKey = utcDateSlice();
    const sessions = Array.isArray(item.sessions) ? item.sessions : [];
    const idx = sessions.findIndex(s => s.date === todayKey);
    const entry = { date: todayKey, page: item.currentPage || 0, ts: Date.now() };
    if (idx >= 0) sessions[idx] = entry; else sessions.push(entry);
    item.sessions = sessions;
    reading['reading:items'] = items;
    return { ok: true, matched: item.title, currentPage: item.currentPage };
  });
}

async function execAddBook(args) {
  return patchRow('reading', (reading) => {
    const items = reading['reading:items'] || [];
    items.push({
      id: 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      title: args.title,
      type: ['book', 'course', 'article', 'video'].includes(args.type) ? args.type : 'book',
      status: 'want', author: args.author || '', link: '', progress: 0, rating: 0, notes: '',
      currentPage: 0, totalPages: Number(args.total_pages) || 0, sessions: [], updatedAt: Date.now(),
    });
    reading['reading:items'] = items;
    return { ok: true };
  });
}

// ---------- Daily habits (separate from the to-do/goals list) ----------
async function execMarkHabitDone(args) {
  return patchRow('goals', (goals) => {
    const defs = goals['habits:defs'] || [];
    const def = fuzzyFind(defs, args.habit, d => d.name);
    if (!def) return { ok: false, reason: 'no habit found matching "' + args.habit + '"' };
    const log = goals['habits:log'] || {};
    log[def.id] = log[def.id] || {};
    log[def.id][activeDateKey()] = true;
    goals['habits:log'] = log;
    const habitLog = log[def.id];
    const streak = computeStreak(activeDateObj(), (k) => !!habitLog[k]);
    return { ok: true, matched: def.name, streak };
  });
}

// ---------- Finance: net worth adjustments, subscriptions, orders, wishlist ----------
async function execAdjustNetWorthAccount(args) {
  if (!NW_CATS.includes(args.category)) return { ok: false, reason: 'category must be one of: ' + NW_CATS.join(', ') };
  return patchRow('finance', (finance) => {
    const items = finance['nw:' + args.category] || [];
    let idx = items.findIndex(i => String(i.name).toLowerCase() === String(args.account).toLowerCase());
    if (idx < 0) { items.push({ name: args.account, amount: 0 }); idx = items.length - 1; }
    const prev = Number(items[idx].amount) || 0;
    const next = args.mode === 'set' ? Number(args.amount) : prev + Number(args.amount);
    items[idx].amount = next;
    finance['nw:' + args.category] = items;
    const activity = finance['nw:activity'] || [];
    activity.push({ ts: Date.now(), cat: args.category, name: items[idx].name, delta: next - prev, kind: 'edit' });
    if (activity.length > 50) activity.splice(0, activity.length - 50);
    finance['nw:activity'] = activity;
    return { ok: true, account: items[idx].name, newAmount: Math.round(next * 100) / 100 };
  });
}

async function execAddSubscription(args) {
  const currency = PUR_CCY_KEYS.includes(args.currency) ? args.currency : 'USD';
  const rates = await fetchExchangeRates();
  const rate = rates[currency] || 1;
  const amountCHF = Number(args.amount) / rate;
  return patchRow('finance', (finance) => {
    let fromCat = null, fromAccount = null;
    if (args.from_account) {
      for (const cat of NW_CATS) {
        const items = finance['nw:' + cat] || [];
        const hit = fuzzyFind(items, args.from_account, i => i.name);
        if (hit) { fromCat = cat; fromAccount = hit.name; break; }
      }
    }
    const subs = finance['subs'] || [];
    subs.push({
      name: args.name, amount: amountCHF,
      period: ['monthly', 'yearly', 'weekly'].includes(args.period) ? args.period : 'monthly',
      renewal: args.renewal_date || null, entered_amount: Number(args.amount), entered_currency: currency,
      fromCat, fromAccount, autoDeduct: !!(args.renewal_date && fromCat), lastDeductedAt: null,
      // Seeds finance.html's price-creep tracking baseline — see priceCreepInfo() there.
      priceHistory: [{ amountCHF, enteredAmount: Number(args.amount), enteredCurrency: currency, ts: Date.now() }],
    });
    finance['subs'] = subs;
    return { ok: true, fromAccount };
  });
}

async function execCancelSubscription(args) {
  return patchRow('finance', (finance) => {
    const subs = finance['subs'] || [];
    const hit = fuzzyFind(subs, args.name, s => s.name);
    if (!hit) return { ok: false, reason: 'no subscription found matching "' + args.name + '"' };
    finance['subs'] = subs.filter(s => s !== hit);
    return { ok: true, removed: hit.name };
  });
}

// finance.html's Debts tab — a separate top-level total from net worth
// accounts on purpose (see the comment there), so this writes to its own
// 'debts' key rather than any nw:<cat> row.
async function execAddDebt(args) {
  const currency = PUR_CCY_KEYS.includes(args.currency) ? args.currency : 'USD';
  const rates = await fetchExchangeRates();
  const rate = rates[currency] || 1;
  const balanceCHF = Number(args.balance) / rate;
  return patchRow('finance', (finance) => {
    const debts = finance['debts'] || [];
    debts.push({
      name: args.name, balance: balanceCHF,
      entered_balance: Number(args.balance), entered_currency: currency,
      apr: args.apr != null ? Number(args.apr) : 0,
      minPayment: args.min_payment != null ? Number(args.min_payment) / rate : 0,
      ts: Date.now(),
    });
    finance['debts'] = debts;
    return { ok: true };
  });
}

async function execAddWishlistItem(args) {
  const currency = PUR_CCY_KEYS.includes(args.currency) ? args.currency : 'USD';
  const rates = await fetchExchangeRates();
  const rate = rates[currency] || 1;
  const amountCHF = Number(args.amount) / rate;
  return patchRow('finance', (finance) => {
    const list = finance['wishlist'] || [];
    list.push({ name: args.name, amount: amountCHF, ts: Date.now(), entered_amount: Number(args.amount), entered_currency: currency });
    finance['wishlist'] = list;
    return { ok: true };
  });
}

async function execAddOrder(args) {
  const currency = PUR_CCY_KEYS.includes(args.currency) ? args.currency : 'USD';
  const rates = await fetchExchangeRates();
  const rate = rates[currency] || 1;
  const amountCHF = Number(args.amount) / rate;
  return patchRow('finance', (finance) => {
    let fromCat = null, fromAccount = null, deductedAt = null;
    if (args.from_account) {
      for (const cat of NW_CATS) {
        const items = finance['nw:' + cat] || [];
        const idx = items.findIndex(i => String(i.name).toLowerCase() === String(args.from_account).toLowerCase());
        if (idx >= 0) {
          items[idx].amount = (Number(items[idx].amount) || 0) - amountCHF;
          finance['nw:' + cat] = items;
          fromCat = cat; fromAccount = items[idx].name; deductedAt = Date.now();
          const activity = finance['nw:activity'] || [];
          activity.push({ ts: Date.now(), cat, name: items[idx].name, delta: -amountCHF, kind: 'order' });
          finance['nw:activity'] = activity;
          break;
        }
      }
    }
    const orders = finance['incoming_orders'] || [];
    orders.push({
      id: 'o_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
      name: args.name, amount: amountCHF, entered_amount: Number(args.amount), entered_currency: currency,
      fromCat: fromCat || 'bank', fromAccount, date: args.expected_date || null, ts: Date.now(),
      deductedAt, pctAtDeduction: null, deductedFrom: fromCat ? { cat: fromCat, name: fromAccount } : null,
    });
    finance['incoming_orders'] = orders;
    return { ok: true, deducted: !!deductedAt };
  });
}

function clamp15(n) { return Math.max(1, Math.min(5, Math.round(Number(n)))); }

// ---------- Peak (morning check-in, feeling/stress check-ins) ----------
// peak.html uses a plain calendar date (no 6am boundary) for both stores —
// same convention as plainDateKey().

// A single flat "pending bedtime" marker (not date-keyed — you can only be
// in bed once at a time) rather than a per-night row, so log_bedtime doesn't
// need to guess which morning it belongs to; that's resolved later, whenever
// log_morning_checkin actually closes it out.
async function execLogBedtime(args) {
  return patchRow('peak', (peak) => {
    let ts = Date.now();
    if (args.at != null) {
      const parsed = new Date(args.at).getTime();
      if (isNaN(parsed)) return { ok: false, reason: 'could not understand the time "' + args.at + '"' };
      ts = parsed;
    }
    peak['peak:pendingBedtime'] = { ts };
    return { ok: true, ts };
  });
}

// Beyond this many tracked hours, a pending bedtime is almost certainly
// stale (a wake-up was never logged — a nap that got interrupted, a night
// the user forgot to text back) rather than a real night's sleep. Ignored
// rather than silently logging a bogus 30-hour "sleep".
const MAX_TRACKED_SLEEP_HOURS = 16;

async function execLogMorningCheckin(args) {
  return patchRow('peak', (peak) => {
    const morning = peak['peak:morning'] || {};
    const key = plainDateKey();
    const existing = morning[key] || {};
    const pending = peak['peak:pendingBedtime'];
    let sleepHours = args.sleep_hours != null ? Number(args.sleep_hours) : null;
    let trackedFromBedtime = false;
    if (sleepHours == null && pending && pending.ts) {
      const elapsedHours = (Date.now() - pending.ts) / 3600000;
      if (elapsedHours > 0 && elapsedHours <= MAX_TRACKED_SLEEP_HOURS) {
        sleepHours = Math.round(elapsedHours * 10) / 10;
        trackedFromBedtime = true;
      }
    }
    if (sleepHours == null) sleepHours = existing.sleepHours || null;
    const entry = {
      wakeTime: args.wake_time != null ? args.wake_time : (trackedFromBedtime ? nowHM() : (existing.wakeTime || '')),
      rhr: args.rhr != null ? Number(args.rhr) : (existing.rhr || null),
      sleepHours,
      sleepQuality: args.sleep_quality != null ? clamp15(args.sleep_quality) : (existing.sleepQuality || null),
      ts: Date.now(),
    };
    morning[key] = entry;
    peak['peak:morning'] = morning;
    // Cleared whenever a check-in is logged, whether or not it was actually
    // used above — a stale/rejected pending bedtime shouldn't linger and
    // confuse a LATER night's tracking.
    if (pending) delete peak['peak:pendingBedtime'];
    return { ok: true, entry, trackedFromBedtime };
  });
}

async function execLogFeelingCheckin(args) {
  if (args.feeling == null && args.stress == null) return { ok: false, reason: 'need at least a feeling or stress rating to log a check-in' };
  return patchRow('peak', (peak) => {
    const list = peak['peak:checkins'] || [];
    list.push({
      id: 'ck' + Date.now() + Math.floor(Math.random() * 1000), ts: Date.now(), dateKey: plainDateKey(),
      feeling: args.feeling != null ? clamp15(args.feeling) : null,
      stress: args.stress != null ? clamp15(args.stress) : null,
      note: args.note || '',
    });
    peak['peak:checkins'] = list;
    return { ok: true };
  });
}

// ---------- Generic recurring-item creation (Main tab's Recurring Items) ----------
async function execAddRecurringItem(args) {
  return patchRow('goals', (goals) => {
    const defs = goals['recur:defs'] || [];
    if (defs.some(d => String(d.name).toLowerCase() === String(args.name).toLowerCase())) {
      return { ok: false, reason: 'a recurring item named "' + args.name + '" already exists' };
    }
    const freq = args.freq === 'days' ? 'days' : 'daily';
    const days = freq === 'days' && Array.isArray(args.days) ? args.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : null;
    defs.push({
      id: 'rc' + Date.now() + Math.floor(Math.random() * 1000),
      name: args.name, freq, days,
      autoSource: KNOWN_AUTO_SOURCES.includes(args.auto_source) ? args.auto_source : null,
      note: args.note || '', time: args.time || null,
    });
    goals['recur:defs'] = defs;
    return { ok: true };
  });
}

// ---------- Health tab: food/calorie log ----------
// Mirrors health.html's manual-entry path exactly (single-item entry, no
// photo) — cal:entries uses a plain calendar date, same as plainDateKey().
async function execLogFoodEntry(args) {
  return patchRow('health', (health) => {
    const arr = health['cal:entries'] || [];
    const calories = Number(args.calories) || 0;
    const protein = Number(args.protein) || 0;
    const carbs = Number(args.carbs) || 0;
    const fat = Number(args.fat) || 0;
    arr.push({
      id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      dateKey: plainDateKey(), photo: null,
      items: [{ name: args.name, calories, protein, carbs, fat }],
      calories, protein, carbs, fat, ts: Date.now(),
    });
    health['cal:entries'] = arr;
    return { ok: true };
  });
}

// ---------- Caffeine tab: caffeine/nicotine logs ----------
// caffeine.html has a large hardcoded preset drink database purely for its
// own search UI — rather than duplicate (and have to keep in sync with)
// that list here, Claude supplies mg itself from general knowledge (see the
// tool descriptions), same philosophy as food-calorie estimation above.
function classifyCaffeineEmoji(name) {
  const n = String(name || '').toLowerCase();
  if (/energy|red ?bull|monster|rockstar|bang|reign|celsius|alani|prime|c4|ghost|nos\b|5-hour/.test(n)) return '⚡';
  if (/tea|matcha/.test(n)) return '🍵';
  if (/chocolate|cocoa/.test(n)) return '🍫';
  if (/pill|pre-?workout|supplement/.test(n)) return '💊';
  if (/soda|coke|pepsi|dew|dr pepper|root beer/.test(n)) return '🥤';
  return '☕';
}
async function execLogCaffeine(args) {
  return patchRow('caffeine', (pc) => {
    const logs = pc['caf:logs'] || [];
    logs.push({
      id: 'c' + Date.now() + Math.floor(Math.random() * 1000),
      n: args.name, mg: Math.round(Number(args.mg) || 0), e: classifyCaffeineEmoji(args.name), ts: Date.now(),
    });
    pc['caf:logs'] = logs;
    return { ok: true };
  });
}
async function execLogNicotine(args) {
  return patchRow('caffeine', (pc) => {
    const logs = pc['nic:logs'] || [];
    logs.push({
      id: 'n' + Date.now() + Math.floor(Math.random() * 1000),
      n: args.name, mg: Math.round(Number(args.mg) || 0), e: '🟣', ts: Date.now(),
    });
    pc['nic:logs'] = logs;
    return { ok: true };
  });
}

// ---------- Google Calendar (real external account — not app_state) ----------
// Unlike every other tool here, these write to the user's actual Google
// Calendar, not a Supabase app_state row — so no patchRow, no undo_last_action
// coverage (there's nothing to snapshot-and-restore against a live external
// API the same way), and a much smaller blast radius on purpose: only the
// fields the caller actually provides get sent (a real PATCH, not a
// read-merge-write of the whole event), so a partial update can't
// accidentally blank out fields it didn't mean to touch.
function calendarEventPayload(args) {
  const payload = {};
  if (args.title != null) payload.summary = args.title;
  if (args.description != null) payload.description = args.description;
  if (args.location != null) payload.location = args.location;
  if (args.start != null) payload.start = /^\d{4}-\d{2}-\d{2}$/.test(args.start) ? { date: args.start } : { dateTime: args.start };
  if (args.end != null) payload.end = /^\d{4}-\d{2}-\d{2}$/.test(args.end) ? { date: args.end } : { dateTime: args.end };
  return payload;
}
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GOOGLE_NOT_CONNECTED = 'Google Calendar isn\'t connected (or the connection has expired) — connect it from the Google tab first.';

async function execCreateCalendarEvent(args) {
  if (!args.title || !args.start || !args.end) return { ok: false, reason: 'title, start, and end are all required to create an event' };
  const tokens = await getValidGoogleTokens();
  if (!tokens) return { ok: false, reason: GOOGLE_NOT_CONNECTED };
  const ev = await gWrite(CALENDAR_EVENTS_URL, tokens.access, 'POST', calendarEventPayload(args));
  return { ok: true, id: ev.id, title: ev.summary, htmlLink: ev.htmlLink };
}

async function execUpdateCalendarEvent(args) {
  if (!args.event_id) return { ok: false, reason: 'event_id is required — use list_calendar_events first if you don\'t already have it from today\'s context' };
  const payload = calendarEventPayload(args);
  if (!Object.keys(payload).length) return { ok: false, reason: 'nothing to update — provide at least one of title/start/end/description/location' };
  const tokens = await getValidGoogleTokens();
  if (!tokens) return { ok: false, reason: GOOGLE_NOT_CONNECTED };
  const ev = await gWrite(CALENDAR_EVENTS_URL + '/' + encodeURIComponent(args.event_id), tokens.access, 'PATCH', payload);
  return { ok: true, id: ev.id, title: ev.summary };
}

async function execDeleteCalendarEvent(args) {
  if (!args.event_id) return { ok: false, reason: 'event_id is required — use list_calendar_events first if you don\'t already have it from today\'s context' };
  const tokens = await getValidGoogleTokens();
  if (!tokens) return { ok: false, reason: GOOGLE_NOT_CONNECTED };
  await gWrite(CALENDAR_EVENTS_URL + '/' + encodeURIComponent(args.event_id), tokens.access, 'DELETE');
  return { ok: true, deleted: args.event_id };
}

async function execListCalendarEvents(args) {
  if (!args.start_date || !args.end_date) return { ok: false, reason: 'start_date and end_date (YYYY-MM-DD) are both required' };
  const tokens = await getValidGoogleTokens();
  if (!tokens) return { ok: false, reason: GOOGLE_NOT_CONNECTED };
  const timeMin = new Date(args.start_date + 'T00:00:00').toISOString();
  const timeMax = new Date(args.end_date + 'T23:59:59').toISOString();
  const url = CALENDAR_EVENTS_URL
    + '?timeMin=' + encodeURIComponent(timeMin) + '&timeMax=' + encodeURIComponent(timeMax)
    + '&singleEvents=true&orderBy=startTime&maxResults=25';
  const data = await gFetch(url, tokens.access);
  const events = ((data && data.items) || []).map(ev => ({
    id: ev.id,
    title: ev.summary || '(no title)',
    start: (ev.start && (ev.start.dateTime || ev.start.date)) || null,
    end: (ev.end && (ev.end.dateTime || ev.end.date)) || null,
  }));
  return { ok: true, events };
}

// ---------- Notes tab ----------
async function execAddNote(args) {
  return patchRow('notes', (n) => {
    const arr = n['notes:items'] || [];
    arr.push({
      id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      title: args.title || '', body: args.body, updatedAt: Date.now(),
    });
    n['notes:items'] = arr;
    return { ok: true };
  });
}

const TOOL_EXECUTORS = {
  log_purchase: execLogPurchase,
  add_todo: execAddTodo,
  mark_todo_done: execMarkTodoDone,
  log_water: execLogWater,
  mark_supplement_taken: execMarkSupplementTaken,
  mark_gym_done: execMarkGymDone,
  log_workout_set: execLogWorkoutSet,
  mark_exercise_done: execMarkExerciseDone,
  log_cardio_session: execLogCardioSession,
  mark_stretch_done: execMarkStretchDone,
  log_body_weight: execLogBodyWeight,
  log_affiliate_commit: execLogAffiliateCommit,
  log_affiliate_revenue: execLogAffiliateRevenue,
  log_editing_delivery: execLogEditingDelivery,
  log_editing_payment: execLogEditingPayment,
  log_reading_session: execLogReadingSession,
  add_book: execAddBook,
  mark_habit_done: execMarkHabitDone,
  adjust_net_worth_account: execAdjustNetWorthAccount,
  add_subscription: execAddSubscription,
  cancel_subscription: execCancelSubscription,
  add_debt: execAddDebt,
  add_wishlist_item: execAddWishlistItem,
  add_order: execAddOrder,
  log_bedtime: execLogBedtime,
  log_morning_checkin: execLogMorningCheckin,
  log_feeling_checkin: execLogFeelingCheckin,
  add_recurring_item: execAddRecurringItem,
  log_food_entry: execLogFoodEntry,
  log_caffeine: execLogCaffeine,
  log_nicotine: execLogNicotine,
  add_note: execAddNote,
  undo_last_action: execUndoLastAction,
  create_calendar_event: execCreateCalendarEvent,
  update_calendar_event: execUpdateCalendarEvent,
  delete_calendar_event: execDeleteCalendarEvent,
  list_calendar_events: execListCalendarEvents,
};

// ---------- Google Calendar/Gmail/Drive (read-only context, separate locked-down table) ----------
// Deliberately NOT using readRow/writeRow above — those hit the app_state
// table with the public anon key, fine for to-do text but not for a live
// Google credential. This table (google_tokens) has no anon-key policies
// at all; only the service_role key (below) can touch it. See
// api/google-token-sync.js for the write side and the one-time SQL setup.
async function readGoogleTokens() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !process.env.SUPABASE_URL) return null;
  const url = process.env.SUPABASE_URL + '/rest/v1/google_tokens?id=eq.1&select=access,refresh,expires';
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } });
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0]) || null;
}
async function writeGoogleTokens(tokens) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !process.env.SUPABASE_URL) return;
  await fetch(process.env.SUPABASE_URL + '/rest/v1/google_tokens?on_conflict=id', {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(Object.assign({ id: 1 }, tokens, { updated_at: new Date().toISOString() })),
  });
}
// Google doesn't re-issue a refresh_token on a plain refresh — the caller
// keeps reusing the original one, same as google.html's own refreshTok().
async function refreshGoogleToken(refresh) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  const json = await r.json();
  if (!json.access_token) throw new Error('google refresh failed: ' + JSON.stringify(json));
  return { access: json.access_token, expires: Date.now() + (json.expires_in || 3500) * 1000 };
}
async function gFetch(url, accessToken) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
  if (!r.ok) throw new Error('Google ' + r.status + ': ' + (await r.text()));
  return r.json();
}
// POST/PATCH/DELETE counterpart to gFetch, used by the calendar write tools
// below. DELETE responses have no body (204 No Content), unlike everything
// else this hits.
async function gWrite(url, accessToken, method, body) {
  const r = await fetch(url, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + accessToken, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error('Google ' + r.status + ': ' + (await r.text()));
  if (r.status === 204) return null;
  return r.json();
}
// Shared by buildContext (read-only summary) and the calendar write tools
// (which need a live token independent of, and possibly called well after,
// that one-time context build within the same request).
async function getValidGoogleTokens() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
  let tokens = await readGoogleTokens();
  if (!tokens || !tokens.access) return null;
  if (tokens.expires && Date.now() > Number(tokens.expires) - 60000) {
    if (!tokens.refresh) return null;
    const refreshed = await refreshGoogleToken(tokens.refresh);
    tokens = { access: refreshed.access, refresh: tokens.refresh, expires: refreshed.expires };
    await writeGoogleTokens(tokens);
  }
  return tokens;
}
// Mirrors google.html's loadCalendar/loadGmail/loadDrive, minus any DOM
// rendering — same summarized shape (titles/subjects/filenames only, no
// event descriptions, email bodies, or file contents) that already gets
// cached into 'google:snapshot' for Nova.
async function buildGoogleContext() {
  try {
    const tokens = await getValidGoogleTokens();
    if (!tokens) return null;

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86400000);
    const calUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
      + '?timeMin=' + encodeURIComponent(startOfDay.toISOString())
      + '&timeMax=' + encodeURIComponent(endOfDay.toISOString())
      + '&singleEvents=true&orderBy=startTime&maxResults=10';
    const [calData, labelData, driveData] = await Promise.all([
      gFetch(calUrl, tokens.access).catch(() => ({ items: [] })),
      gFetch('https://gmail.googleapis.com/gmail/v1/users/me/labels/UNREAD', tokens.access).catch(() => ({ messagesUnread: 0 })),
      gFetch('https://www.googleapis.com/drive/v3/files?orderBy=modifiedTime desc&pageSize=5&fields=' + encodeURIComponent('files(id,name,modifiedTime)'), tokens.access).catch(() => ({ files: [] })),
    ]);

    const calendarEventsToday = ((calData && calData.items) || []).map(ev => ({
      id: ev.id,
      title: ev.summary || '(no title)',
      time: ev.start && ev.start.dateTime ? new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'All day',
    }));

    const gmailUnreadCount = (labelData && labelData.messagesUnread) || 0;
    let gmailRecentSubjects = [];
    if (gmailUnreadCount) {
      const listData = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5', tokens.access).catch(() => null);
      const ids = ((listData && listData.messages) || []).map(m => m.id);
      const metas = await Promise.all(ids.map(id =>
        gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From', tokens.access).catch(() => null)
      ));
      gmailRecentSubjects = metas.filter(Boolean).map(m => {
        const headers = (m.payload && m.payload.headers) || [];
        const subject = (headers.find(h => h.name === 'Subject') || {}).value || '(no subject)';
        const from = (headers.find(h => h.name === 'From') || {}).value || '';
        return { subject, from: from.replace(/<.*>/, '').trim() || from };
      });
    }

    const driveRecentFiles = ((driveData && driveData.files) || []).map(f => ({ name: f.name || '(untitled)', modified: f.modifiedTime || null }));

    return { calendarEventsToday, gmailUnreadCount, gmailRecentSubjects, driveRecentFiles };
  } catch (e) {
    return null;
  }
}

// ---------- context for Claude (read-only, all best-effort) ----------
async function buildContext() {
  const keys = ['goals', 'health', 'po-coach', 'finance', 'business', 'reading', 'peak', 'caffeine', 'notes'];
  const rows = await Promise.all(keys.map(k => readRow(k).catch(() => ({}))));
  const context = {};
  keys.forEach((k, i) => { context[k] = rows[i]; });
  const google = await buildGoogleContext();
  if (google) context.google = google;
  const usage = summarizeApiUsage(await readRow(USAGE_KEY).catch(() => null));
  if (usage) context.apiUsage = usage;
  return context;
}

const SYS = 'You are the user\'s personal assistant, reachable over Telegram, wired directly into essentially their '
  + 'whole personal dashboard — to-dos, recurring items and daily habits, gym (workout program/sets, cardio, stretch '
  + 'routines, body weight), water/supplements, finances (net worth accounts, purchases, subscriptions, incoming '
  + 'orders, wishlist), side-hustle business (affiliate commitments/revenue, editing clients/deliveries/payments), '
  + 'reading, Peak (a morning check-in of wake time/resting heart rate/sleep hours/sleep quality, plus feeling/'
  + 'stress check-ins logged any number of times through the day), the calorie/macro food log, caffeine/nicotine '
  + 'intake, and free-form notes — passed below as JSON from the same database the dashboard itself reads and writes. '
  + 'You also have tools to actually change most of that: log a purchase, add/complete a to-do (add_todo can also set '
  + 'a one-off reminder for a specific future day — e.g. "remind me to renew my passport in 3 months" — by computing '
  + 'the actual calendar date yourself and passing it as date; that\'s different from add_recurring_item, which is '
  + 'only for things that repeat), mark a habit done, '
  + 'log water/a supplement, log a workout set or mark an exercise/gym day/stretch routine done, log a cardio session '
  + 'or body weight, log affiliate/editing business activity, log a reading session or add a book, adjust a net worth '
  + 'account balance, add/cancel a subscription/order/wishlist item, add a debt (loan, credit card balance — its own '
  + 'tracker with a payoff calculator, separate from net worth accounts), log a Peak morning check-in or a feeling/stress '
  + 'check-in (this one can happen several times a day — don\'t treat it as already-done just because one happened '
  + 'earlier), track real sleep with log_bedtime (call it the moment the user says "going to bed"/"heading to '
  + 'sleep") so the next log_morning_checkin — triggered by any wake-up signal, even a bare "good morning", no '
  + 'other details needed — computes actual sleep hours/wake time from that instead of an estimate, '
  + 'create a brand-new recurring item on the to-do list\'s Recurring Items section (set auto_source to '
  + 'peak_morning/gym/reading/stretch_am/stretch_pm/business/water/supplements when the new item corresponds to one '
  + 'of those, so it self-completes instead of needing a manual checkbox), log a food/meal entry, log caffeine or '
  + 'nicotine intake, add a note, and undo the single most recent change any tool made (e.g. "undo that", "oops, '
  + 'wrong exercise, undo") via undo_last_action — don\'t try to manually reverse a mistake yourself (e.g. by '
  + 'guessing at the opposite log_purchase amount), always use that tool instead, since it reverts the exact prior '
  + 'state rather than an approximation. There is no hardcoded food or drink database behind any of those three — '
  + 'estimate calories/macros/mg yourself from general knowledge (a careful, realistic estimate, the same way the '
  + 'dashboard\'s own AI photo-estimate feature works) unless the user gives exact numbers; don\'t ask for numbers '
  + 'they clearly expect you to just know or estimate (e.g. "a Red Bull" -> ~80mg caffeine for the 8.4oz can, "2 '
  + 'scrambled eggs" -> a reasonable calorie/protein estimate) — only ask if the item is too ambiguous to estimate at '
  + 'all. The user can also just send a photo of food or a drink instead of typing it — identify what\'s in the '
  + 'photo yourself and log it with log_food_entry (or log_caffeine/log_nicotine if that\'s clearly what it is) the '
  + 'same estimate-don\'t-ask-for-exact-numbers way, mentioning what you logged in your reply so they can correct you '
  + 'if the estimate\'s off. Only ask a follow-up question first if the photo genuinely doesn\'t show a food/drink '
  + 'item or is too unclear to identify at all. mark_gym_done, mark_habit_done, and mark_stretch_done each return a streak (consecutive days), matching the '
  + '🔥 streak counters already shown on the Main/Gym tabs — mention it in your reply when it\'s genuinely notable '
  + '(2+ days), but don\'t bother calling it out for a 0 or 1. Use a tool whenever the user is clearly asking you to DO one of those things (e.g. "log a $20 grocery run", '
  + '"mark gym done", "sleep was a 5, stress at 1, just woke up", "add a recurring reminder for X", "track this Red '
  + 'Bull", "note that the landlord called"), not just when they ask a question about their data. Names (exercises, '
  + 'clients, books, habits, accounts, subscriptions) are matched loosely — exact or partial — so don\'t worry about '
  + 'getting a name exactly right before calling a tool. Be direct, concise, and conversational — this is a text '
  + 'chat, not a report. If a tool call fails or finds no match, say so plainly instead of pretending it worked. '
  + 'If a "google" key is present in the data, it has today\'s Calendar events (each with an id), Gmail unread '
  + 'count/subjects, and recent Drive files — use it when relevant. If it\'s absent, Google either isn\'t connected '
  + 'or the tokens have expired — say so rather than guessing at calendar/email/file content, and don\'t attempt '
  + 'the calendar tools below in that case (they\'ll just report the same thing). You can create/reschedule/cancel '
  + 'REAL events on the user\'s actual Google Calendar via create_calendar_event/update_calendar_event/'
  + 'delete_calendar_event — this is a genuinely different, higher-stakes thing than add_todo (which only ever '
  + 'touches the dashboard\'s own to-do list), so be careful: compute real ISO dates yourself the same way you do '
  + 'for add_todo\'s date field, and if it\'s not clear which real event the user means (update/delete need an '
  + 'event_id — pull it from today\'s Calendar context, or call list_calendar_events to search a wider range), ask '
  + 'rather than guess, since a wrong delete/update can\'t be undone the way dashboard changes can via '
  + 'undo_last_action. If an "apiUsage" key is present, it\'s YOUR OWN estimated Anthropic API cost/call count — '
  + 'today, last 30 days, and all-time — answer questions like "how much have I spent on you this month" directly '
  + 'from it; the cost figures are estimates from configured per-token prices, not a real invoice, so say "roughly" '
  + 'rather than stating them as exact.'
  + '\n\nCurrent dashboard data:\n';

// userContent is either a plain string (a normal text message) or an array
// of Anthropic content blocks (an image block + a text block, for a photo
// message) — Claude's Messages API accepts either shape for a turn's
// content, so no branching is needed here beyond passing it straight through.
// Returns { text, usage } rather than a bare string — usage accumulates
// input/output tokens across every iteration of the loop below (a single
// user message can cost several Anthropic calls when tool use is involved),
// so the caller gets one true total for the whole exchange, not just the
// final round-trip.
async function callClaude(apiKey, context, userContent, priorHistory) {
  const messages = (priorHistory || []).concat([{ role: 'user', content: userContent }]);
  let lastText = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (let iter = 0; iter < 4; iter++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: SYS + JSON.stringify(context),
        tools: TOOLS,
        messages,
      }),
    });
    if (!res.ok) throw new Error('Anthropic API error: ' + res.status + ' ' + (await res.text()));
    const json = await res.json();
    if (json.usage) {
      usage.inputTokens += json.usage.input_tokens || 0;
      usage.outputTokens += json.usage.output_tokens || 0;
    }
    const textBlocks = json.content.filter(b => b.type === 'text').map(b => b.text);
    lastText = textBlocks.join('\n') || lastText;
    const toolUses = json.content.filter(b => b.type === 'tool_use');
    if (json.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { text: lastText || '(no response)', usage };
    }
    messages.push({ role: 'assistant', content: json.content });
    const toolResults = [];
    for (const tu of toolUses) {
      let resultPayload;
      try {
        const executor = TOOL_EXECUTORS[tu.name];
        resultPayload = executor ? await executor(tu.input || {}) : { ok: false, reason: 'unknown tool "' + tu.name + '"' };
      } catch (e) {
        resultPayload = { ok: false, reason: e && e.message ? e.message : String(e) };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(resultPayload) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { text: lastText || "Something went wrong — I looped too many times without finishing. Try rephrasing?", usage };
}

async function tgSend(token, chatId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
  });
}

// Telegram sends a compressed photo as `photo`: the same image at several
// resolutions (ascending by size), not a single file — picking the largest
// gives Claude's vision model the most detail, and Telegram's own
// compression keeps even that well under Anthropic's per-image size limits.
// A two-step fetch: getFile resolves the file_id to a file_path, which then
// has to be downloaded from a *different* Telegram host (api.telegram.org/
// file/..., not .../bot...) to get the actual bytes.
async function downloadTelegramPhoto(token, photoSizes) {
  const largest = photoSizes.reduce((a, b) => ((b.file_size || 0) > (a.file_size || 0) ? b : a), photoSizes[0]);
  const fileRes = await fetch('https://api.telegram.org/bot' + token + '/getFile?file_id=' + encodeURIComponent(largest.file_id));
  const fileJson = await fileRes.json();
  if (!fileRes.ok || !fileJson.ok || !fileJson.result || !fileJson.result.file_path) {
    throw new Error('Telegram getFile failed: ' + JSON.stringify(fileJson));
  }
  const filePath = fileJson.result.file_path;
  const bytesRes = await fetch('https://api.telegram.org/file/bot' + token + '/' + filePath);
  if (!bytesRes.ok) throw new Error('Telegram file download failed: HTTP ' + bytesRes.status);
  const base64 = Buffer.from(await bytesRes.arrayBuffer()).toString('base64');
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return { base64, mediaType };
}

// Answers a callback_query — required so Telegram clears the tappable
// button's loading spinner on the user's client. `text` (optional, shows as
// a small toast) is capped well under Telegram's 200-char limit.
async function tgAnswerCallback(token, callbackQueryId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text ? String(text).slice(0, 180) : undefined }),
  });
}

// Strips the inline keyboard off an already-sent message once its button's
// action has been handled, so a second tap can't double-fire the same tool.
async function tgClearKeyboard(token, chatId, messageId) {
  await fetch('https://api.telegram.org/bot' + token + '/editMessageReplyMarkup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });
}

async function tgEditText(token, chatId, messageId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000) }),
  });
}

// A tapped inline-keyboard button skips the Claude tool-use loop entirely —
// it's a direct, deterministic action (currently just "mark this done"), so
// there's no ambiguity to resolve and no reason to pay for an LLM round
// trip. callback_data is a small routing tag: "done:<name>" reuses
// execMarkTodoDone's existing fuzzy-match-and-materialize logic, the exact
// same path a typed "mark X done" message already goes through.
async function handleCallbackQuery(botToken, callback, res) {
  const data = String(callback.data || '');
  const chatId = callback.message && callback.message.chat && callback.message.chat.id;
  const messageId = callback.message && callback.message.message_id;

  if (!data.startsWith('done:')) {
    try { await tgAnswerCallback(botToken, callback.id); } catch (e) {}
    return res.status(200).json({ ok: true, callback: true, ignored: 'unknown callback data' });
  }

  const text = data.slice(5);
  let result;
  try {
    result = await execMarkTodoDone({ text });
  } catch (e) {
    result = { ok: false, reason: e && e.message ? e.message : String(e) };
  }

  try { await tgAnswerCallback(botToken, callback.id, result.ok ? 'Marked done ✅' : (result.reason || 'Could not mark done')); } catch (e) {}
  if (result.ok && chatId && messageId) {
    try { await tgClearKeyboard(botToken, chatId, messageId); } catch (e) {}
    const origText = callback.message && typeof callback.message.text === 'string' ? callback.message.text : '';
    try { await tgEditText(botToken, chatId, messageId, (origText ? origText + '\n\n' : '') + '✅ Marked done'); } catch (e) {}
  }

  return res.status(200).json({ ok: true, callback: true, result });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const configuredChatId = process.env.TELEGRAM_CHAT_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!botToken || !webhookSecret) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET not configured' });
  if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) return res.status(401).json({ error: 'bad secret token' });

  // Always 200 immediately-ish so Telegram doesn't retry-storm us on slow
  // Claude/Supabase calls — but we still await everything below before
  // responding, since there's no reliable "fire and forget" on Vercel's
  // serverless functions (the process can be frozen the instant we respond).
  try {
    const update = req.body || {};

    if (update.callback_query) {
      const cbChatId = update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.id;
      // Mirrors the plain-message flow below: silently ignore anything not
      // from the one authorized chat, and do nothing (including no data
      // access) until initial setup (TELEGRAM_CHAT_ID) is complete.
      if (!configuredChatId || String(cbChatId) !== String(configuredChatId)) {
        return res.status(200).json({ ok: true, ignored: 'callback chat id not authorized' });
      }
      return handleCallbackQuery(botToken, update.callback_query, res);
    }

    const message = update.message;
    const hasPhoto = !!(message && Array.isArray(message.photo) && message.photo.length);
    if (!message || (typeof message.text !== 'string' && !hasPhoto)) return res.status(200).json({ ok: true, skipped: 'no text message' });

    const chatId = message.chat && message.chat.id;

    if (!configuredChatId) {
      // First-contact setup flow: tell whoever messaged the bot their chat
      // id so it can be locked down, and do nothing else — no data access,
      // no Claude call, until TELEGRAM_CHAT_ID is actually set.
      await tgSend(botToken, chatId, 'Setup: your chat ID is ' + chatId + ' — add this as TELEGRAM_CHAT_ID in Vercel\'s environment variables, then redeploy, to finish setup.');
      return res.status(200).json({ ok: true, setup: true, chatId });
    }
    if (String(chatId) !== String(configuredChatId)) {
      return res.status(200).json({ ok: true, ignored: 'chat id not authorized' });
    }
    if (!anthropicKey) {
      await tgSend(botToken, chatId, "ANTHROPIC_API_KEY isn't set on the server yet — add it in Vercel's environment variables.");
      return res.status(200).json({ ok: true, error: 'no anthropic key' });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      await tgSend(botToken, chatId, "SUPABASE_URL / SUPABASE_ANON_KEY aren't set on the server yet.");
      return res.status(200).json({ ok: true, error: 'no supabase config' });
    }

    const [context, history] = await Promise.all([buildContext(), loadHistory().catch(() => [])]);

    // A photo (e.g. a plate of food) is sent to Claude as a vision content
    // block instead of plain text — same "estimate from general knowledge,
    // no hardcoded food database" approach the SYS prompt already directs
    // for typed food descriptions, just fed an image instead of words.
    // History only ever stores a short placeholder for the turn, never the
    // image itself — keeps the memory row small and avoids re-sending a
    // multi-hundred-KB base64 blob (and re-spending the tokens on it) on
    // every subsequent, unrelated message for the rest of the conversation.
    let userContent, historyUserEntry;
    if (hasPhoto) {
      let image;
      try {
        image = await downloadTelegramPhoto(botToken, message.photo);
      } catch (e) {
        await tgSend(botToken, chatId, "Couldn't download that photo from Telegram: " + (e && e.message ? e.message : String(e)));
        return res.status(200).json({ ok: true, error: 'photo download failed' });
      }
      const caption = typeof message.caption === 'string' ? message.caption : '';
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: caption || 'What food/drink is this? Log it.' },
      ];
      historyUserEntry = '(sent a photo' + (caption ? ': ' + caption : '') + ')';
    } else {
      userContent = message.text;
      historyUserEntry = message.text;
    }

    const { text: reply, usage } = await callClaude(anthropicKey, context, userContent, history);
    await tgSend(botToken, chatId, reply);
    // Awaited (not fire-and-forget) — this function can be frozen the
    // instant we respond, same reasoning as the comment above.
    await saveHistory(history.concat([
      { role: 'user', content: historyUserEntry },
      { role: 'assistant', content: reply },
    ])).catch(() => {});
    await recordApiUsage(usage).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    try {
      const chatId = req.body && req.body.message && req.body.message.chat && req.body.message.chat.id;
      if (chatId) await tgSend(botToken, chatId, "Something broke on my end: " + (e && e.message ? e.message : String(e)));
    } catch (e2) {}
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}

// Exported for direct testing without going through req/res.
export { buildContext, buildGoogleContext, callClaude, TOOL_EXECUTORS, activeDateKey, plainDateKey };
