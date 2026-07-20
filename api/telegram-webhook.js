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

// ---------- date helpers (must match the dashboard's own conventions) ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function tzNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: tz() })); }
// Plain calendar date — used by po-water.html (water logs) and gym.html (workout-done).
function plainDateKey() {
  const d = tzNow();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
// 6am-boundary date — used by main.html (goals:<key>) and health.html (stack:taken:<key>).
function activeDateKey() {
  const d = tzNow();
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// ---------- Supabase app_state row helpers ----------
async function readRow(key) {
  const url = process.env.SUPABASE_URL + '/rest/v1/app_state?key=eq.' + encodeURIComponent(key) + '&select=data';
  const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY } });
  if (!r.ok) throw new Error('Supabase read failed for "' + key + '": ' + r.status);
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || {};
}
async function writeRow(key, data) {
  const url = process.env.SUPABASE_URL + '/rest/v1/app_state?on_conflict=key';
  const r = await fetch(url, {
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
async function patchRow(key, mutate) {
  const data = await readRow(key);
  const result = await mutate(data);
  await writeRow(key, data);
  return result;
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
    description: 'Add a new to-do to today\'s list on the Main tab.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
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
  const key = 'goals:' + activeDateKey();
  return patchRow('goals', (goals) => {
    const list = goals[key] || [];
    list.push({ text: args.text, done: false });
    goals[key] = list;
    return { ok: true };
  });
}

async function execMarkTodoDone(args) {
  const key = 'goals:' + activeDateKey();
  return patchRow('goals', (goals) => {
    const list = goals[key] || [];
    const target = String(args.text).toLowerCase();
    let idx = list.findIndex(g => String(g.text).toLowerCase() === target);
    if (idx < 0) idx = list.findIndex(g => String(g.text).toLowerCase().includes(target) || target.includes(String(g.text).toLowerCase()));
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
};

// ---------- context for Claude (read-only, all best-effort) ----------
async function buildContext() {
  const keys = ['goals', 'health', 'po-coach', 'finance', 'business', 'reading'];
  const rows = await Promise.all(keys.map(k => readRow(k).catch(() => ({}))));
  const context = {};
  keys.forEach((k, i) => { context[k] = rows[i]; });
  return context;
}

const SYS = 'You are the user\'s personal assistant, reachable over Telegram, wired directly into their personal dashboard. '
  + 'You can see their to-dos/recurring habits, water/supplement tracking, gym workout status, finances (net worth, '
  + 'purchases, subscriptions), side-hustle business data, and reading habit — passed below as JSON from the same '
  + 'database the dashboard itself reads and writes. You also have tools to actually log a purchase, add/complete a '
  + 'to-do, log water, mark a supplement taken, or mark today\'s workout done — use them whenever the user is clearly '
  + 'asking you to DO one of those things (e.g. "log a $20 grocery run", "mark gym done", "I took my creatine"), not '
  + 'just when they ask a question about their data. Be direct, concise, and conversational — this is a text chat, not '
  + 'a report. If a tool call fails or finds no match, say so plainly instead of pretending it worked. '
  + 'Note: Calendar/Gmail/Drive data isn\'t available here yet (those tokens live only in the browser, not synced) — '
  + 'say so if asked about them rather than guessing.\n\nCurrent dashboard data:\n';

async function callClaude(apiKey, context, userText) {
  const messages = [{ role: 'user', content: userText }];
  let lastText = '';
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
    const textBlocks = json.content.filter(b => b.type === 'text').map(b => b.text);
    lastText = textBlocks.join('\n') || lastText;
    const toolUses = json.content.filter(b => b.type === 'tool_use');
    if (json.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return lastText || '(no response)';
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
  return lastText || "Something went wrong — I looped too many times without finishing. Try rephrasing?";
}

async function tgSend(token, chatId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
  });
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
    const message = update.message;
    if (!message || typeof message.text !== 'string') return res.status(200).json({ ok: true, skipped: 'no text message' });

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

    const context = await buildContext();
    const reply = await callClaude(anthropicKey, context, message.text);
    await tgSend(botToken, chatId, reply);
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
export { buildContext, callClaude, TOOL_EXECUTORS, activeDateKey, plainDateKey };
