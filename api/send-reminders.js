// ============================================================
// GET/POST /api/send-reminders
//
// Triggered by a scheduler hitting this URL (see .github/workflows/
// reminders.yml — GitHub Actions, not Vercel Cron: Vercel's Hobby plan only
// allows cron schedules that fire once a day each, which can't do true
// hourly, and Actions on a public repo is free at any frequency). Checks
// whether the current time, converted to REMINDER_TIMEZONE, matches one of
// REMINDER_HOURS_LOCAL; if so, reads today's recurring items straight from
// Supabase (the same rows the dashboard itself reads and writes — this
// function never talks to the browser, only to Supabase and the delivery
// provider) and texts a digest of whatever's still undone. Each undone item
// gets its own hand-written, deterministic-but-varied one-liner keyed off
// the item's name (gym/water/reading/stretch/etc. each have their own
// phrase pool, with a generic fallback for anything unmatched — see
// categorizeItem/PHRASES/composeMessage below), on top of a rotating
// opening line, so repeated sends through the day read like different
// messages instead of the same template every time. Sends nothing if it's
// not a configured hour, or if everything's already done.
//
// The workflow's schedule is fixed UTC clock times, so — same as any fixed-
// UTC cron — it drifts an hour for ~2 weeks around DST changes (mid-March
// and early November) until nudged; see SETUP.md.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY   (same ones the dashboard already uses)
//
// Delivery — configure ONE of these three (checked in this priority order,
// so Telegram wins over Twilio wins over the email gateway if more than
// one happens to be configured):
//   Telegram (free, preferred — see api/telegram-webhook.js for the
//   two-way assistant this doubles up with):
//     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   Twilio (paid, reliable):
//     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//     TWILIO_FROM_NUMBER                your Twilio number, e.g. +15551234567
//     TWILIO_TO_NUMBER                  your personal phone, e.g. +15559876543
//   Email-to-SMS carrier gateway (free, via Resend):
//     RESEND_API_KEY                    from resend.com
//     SMS_GATEWAY_TO                    your phone's carrier gateway address,
//                                        e.g. 5551234567@vtext.com (Verizon)
//     RESEND_FROM                       optional, default 'onboarding@resend.dev'
//
// Optional:
//   REMINDER_TIMEZONE     IANA tz name, default 'America/New_York'
//   REMINDER_HOURS_LOCAL  comma-separated 24h hours to check, default '14,20'.
//                         Set this to every hour you want texts during (e.g.
//                         '8,9,10,11,12,13,14,15,16,17,18,19,20,21,22' for
//                         hourly 8am-10pm) — it's the actual gate on how
//                         often you get texted, independent of how often
//                         the workflow pings this endpoint.
//   CRON_SECRET           if set, requests must carry
//                         Authorization: Bearer <CRON_SECRET> — Vercel
//                         sends this automatically on cron-triggered
//                         requests when CRON_SECRET is set as an env var.
//                         Strongly recommended so this endpoint can't be
//                         hit by randoms to spam your phone / burn your quota.
// ============================================================

function currentHourInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(new Date());
  const h = parts.find(p => p.type === 'hour').value;
  return Number(h) % 24;
}

// Varies the opening line across sends (same undone list otherwise reads
// identically every time it repeats through the day) — deterministic by
// date+hour rather than random, so a given run is reproducible if re-sent.
const INTROS = [
  'Still todo today:',
  "Yo — still haven't done:",
  "Don't forget:",
  'Reminder, still open:',
  'Knock these out:',
  'Still waiting on you for:',
  'Hey, still undone:',
  'Circling back — still todo:',
];
function pickIntro(dateKey, hour) {
  const day = Number(dateKey.slice(-2)) || 0;
  return INTROS[(day + hour) % INTROS.length];
}

// ---------- Per-item phrasing ----------
// Recurring item names are whatever the user typed into main.html's
// Recurring Items settings, not a fixed enum — so this matches on keywords
// rather than exact names, with a generic pool as the fallback for anything
// that doesn't match (custom items, one-off to-dos). Each item gets its own
// deterministic-but-varied line instead of one flat comma list, so what
// changes each send is tied to what's actually still undone, not just a
// generic rotating header.
function categorizeItem(name) {
  const n = String(name).toLowerCase();
  if (/side ?hustle|\bhustle\b|business|affiliate|editing client/.test(n)) return 'sideHustle';
  if (/\bgym\b|workout|\blift/.test(n)) return 'gym';
  if (/water|hydrat/.test(n)) return 'water';
  if (/\bread(ing)?\b|\bbook/.test(n)) return 'reading';
  if (/stretch|mobility|\byoga\b/.test(n)) return 'stretch';
  if (/skin ?care/.test(n)) return 'skincare';
  if (/\bclean|\btidy|\broom\b/.test(n)) return 'cleaning';
  if (/supplement|vitamin/.test(n)) return 'supplements';
  if (/\bsleep\b|bed ?time/.test(n)) return 'sleep';
  if (/\bmed(s|ication)?\b|\bpill/.test(n)) return 'meds';
  if (/\bwork\b/.test(n)) return 'work';
  return 'generic';
}
const PHRASES = {
  gym: [
    n => n + ' — the weights aren\'t lifting themselves',
    n => 'Still no ' + n.toLowerCase() + ' today',
    n => n + ': future you is currently disappointed',
    n => 'Your gym bag is still zipped shut (' + n + ')',
    n => n + ' — bench press beats bench sitting',
    n => 'Zero reps logged for ' + n + ' today',
  ],
  water: [
    n => n + ' — hydrate or diedrate',
    n => 'Still haven\'t hit ' + n.toLowerCase() + ' today',
    n => n + ': your cells are filing a complaint',
    n => 'That water bottle isn\'t drinking itself (' + n + ')',
    n => n + ' — go take a sip right now',
  ],
  reading: [
    n => n + ' — that bookmark hasn\'t moved',
    n => 'Zero pages today for ' + n,
    n => n + ' is still waiting on the nightstand',
    n => 'Still haven\'t cracked ' + n.toLowerCase() + ' open today',
    n => n + ' — even one page counts',
  ],
  stretch: [
    n => n + ' — your hips will remember this',
    n => 'Still haven\'t stretched (' + n + ')',
    n => n + ': five minutes, that\'s it',
    n => 'Everything\'s still tight — ' + n,
    n => n + ' — don\'t skip it two days running',
  ],
  skincare: [
    n => n + ' — skip it and regret it in the mirror later',
    n => 'Still haven\'t done ' + n.toLowerCase(),
    n => n + ': quick one, don\'t skip',
    n => 'Still waiting on ' + n.toLowerCase() + ' today',
  ],
  cleaning: [
    n => n + ' — the mess isn\'t cleaning itself',
    n => 'Still haven\'t done ' + n.toLowerCase(),
    n => n + ': five minutes and it\'s done',
    n => 'Still a mess in there — ' + n,
  ],
  supplements: [
    n => n + ' — still sitting in the bottle',
    n => 'Haven\'t taken ' + n.toLowerCase() + ' yet',
    n => n + ': quick one, don\'t forget',
    n => 'Still untouched today (' + n + ')',
  ],
  sleep: [
    n => n + ' — still owe yourself this one',
    n => 'Haven\'t logged ' + n.toLowerCase() + ' yet',
  ],
  meds: [
    n => n + ' — don\'t forget this one',
    n => 'Still haven\'t taken ' + n.toLowerCase(),
    n => n + ': this one actually matters, don\'t skip',
  ],
  sideHustle: [
    n => n + ' — still nothing logged today',
    n => 'Haven\'t touched ' + n.toLowerCase() + ' yet',
    n => n + ': even 15 minutes moves it forward',
    n => 'Still no progress on ' + n.toLowerCase() + ' today',
    n => n + ' — the money\'s not making itself',
  ],
  work: [
    n => n + ' — still not clocked in',
    n => 'Haven\'t started ' + n.toLowerCase() + ' yet',
    n => n + ': still on the clock to start',
  ],
  generic: [
    n => n + ' — still undone',
    n => 'Haven\'t gotten to ' + n.toLowerCase() + ' yet',
    n => n + ' is still sitting there',
    n => 'Still need to knock out ' + n.toLowerCase(),
    n => n + ' — waiting on you',
    n => 'Still open: ' + n.toLowerCase(),
  ],
};
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
// Exported for direct testing. dateKey/hour (not real randomness) drive the
// phrase choice so the same undone list at the same date+hour always
// composes the same message — a re-send after a transient failure won't
// read as a different, confusing text.
export function composeMessage(undone, dateKey, hour) {
  const intro = pickIntro(dateKey, hour);
  const lines = undone.map(name => {
    const pool = PHRASES[categorizeItem(name)] || PHRASES.generic;
    const seed = hashStr(dateKey + '|' + hour + '|' + name);
    return '- ' + pool[seed % pool.length](name);
  });
  return intro + '\n' + lines.join('\n');
}

// Mirrors the dashboard's own day-key conventions (6 AM boundary for
// goals/business, plain calendar date for gym/water/supplements/stretch),
// computed in the recipient's timezone rather than the server's.
function dateKeyInTz(tz, sixAmBoundary) {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  if (sixAmBoundary && local.getHours() < 6) local.setDate(local.getDate() - 1);
  const y = local.getFullYear(), m = String(local.getMonth() + 1).padStart(2, '0'), d = String(local.getDate()).padStart(2, '0');
  return { key: y + '-' + m + '-' + d, dow: local.getDay() };
}

async function fetchRow(supabaseUrl, supabaseKey, key) {
  const url = supabaseUrl + '/rest/v1/app_state?key=eq.' + encodeURIComponent(key) + '&select=data';
  const r = await fetch(url, { headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey } });
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || null;
}

function waterDoneToday(healthData, todayPlain) {
  const w = healthData && healthData['po_water_v1'];
  if (!w || !w.profile || !w.profile.weightKg) return false;
  const p = w.profile;
  const wKg = w.weightUnit === 'lb' ? p.weightKg / 2.20462 : p.weightKg;
  const base = wKg * 35, exercise = (p.activityHrsPerWeek || 0) / 7 * 500, caffeine = Math.max(0, (w.caffeineMgPerDay || 0) - 200) * 1.5;
  let adjust = 0; if (p.sex === 'm') adjust += 200; if ((p.age || 0) >= 50) adjust += 100;
  const totalMl = base + exercise + caffeine + adjust;
  let unitMl = 1; if (w.unit === 'bottle') unitMl = w.bottleMl || 500; else if (w.unit === 'glass') unitMl = w.glassMl || 250; else if (w.unit === 'oz') unitMl = 30;
  const targetUnits = Math.ceil(totalMl / unitMl);
  const count = (w.logs && w.logs[todayPlain]) || 0;
  return targetUnits > 0 && count >= targetUnits;
}

function isScheduledToday(def, dow) {
  if (def.freq === 'daily') return true;
  if (def.freq === 'days') return Array.isArray(def.days) && def.days.indexOf(dow) !== -1;
  return false;
}

function sourceDoneToday(autoSource, ctx) {
  const { gymData, readingData, businessData, healthData, todayPlain, todayKey6am, utcToday } = ctx;
  if (autoSource === 'gym') {
    const doneDays = gymData && gymData['po_coach_workout_done'];
    return !!(doneDays && doneDays[todayPlain]);
  }
  if (autoSource === 'reading') {
    const items = readingData && readingData['reading:items'];
    return Array.isArray(items) && items.some(it => Array.isArray(it.sessions) && it.sessions.some(s => s.date === utcToday));
  }
  if (autoSource === 'stretch_am' || autoSource === 'stretch_pm') {
    const items = gymData && gymData[autoSource === 'stretch_am' ? 'stretch:am:items' : 'stretch:pm:items'];
    const log = (gymData && gymData['stretch:log']) || {};
    if (!Array.isArray(items) || !items.length) return false;
    return items.every(it => log[it.id] && log[it.id][todayPlain]);
  }
  if (autoSource === 'business') {
    const commitLog = (businessData && businessData['biz:affiliate:commitLog']) || {};
    const delivery = (businessData && businessData['biz:editing:deliveryLog']) || {};
    const revenue = (businessData && businessData['biz:affiliate:revenue']) || [];
    const payments = (businessData && businessData['biz:editing:payments']) || [];
    const anyCommit = Object.keys(commitLog).some(cid => commitLog[cid] && commitLog[cid][todayKey6am]);
    const anyDelivery = Object.keys(delivery).some(cid => (delivery[cid] || {})[todayKey6am] > 0);
    const anyRevenue = revenue.some(r => r.date === todayKey6am) || payments.some(p => p.date === todayKey6am);
    return anyCommit || anyDelivery || anyRevenue;
  }
  if (autoSource === 'water') return waterDoneToday(healthData, todayPlain);
  if (autoSource === 'supplements') {
    const items = healthData && healthData['stack:items'];
    const taken = (healthData && healthData['stack:taken:' + todayKey6am]) || {};
    if (!Array.isArray(items) || !items.length) return false;
    return items.every(it => taken[it.id]);
  }
  return false;
}

// ---------- Delivery: Telegram, Twilio SMS, or free email-to-SMS carrier gateway ----------
// Prefers Telegram if configured, then Twilio, then falls back to emailing
// your carrier's SMS gateway address (e.g. 5551234567@vtext.com) via Resend.
// Either way this returns a small result object; the caller doesn't need to
// know which path was used.
async function sendViaTelegram(body) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error('telegram send failed: ' + JSON.stringify(json));
  return { method: 'telegram', id: json.result && json.result.message_id };
}

async function sendViaTwilio(body) {
  const twSid = process.env.TWILIO_ACCOUNT_SID, twToken = process.env.TWILIO_AUTH_TOKEN;
  const twFrom = process.env.TWILIO_FROM_NUMBER, twTo = process.env.TWILIO_TO_NUMBER;
  const twRes = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + twSid + '/Messages.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(twSid + ':' + twToken).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: twTo, From: twFrom, Body: body }).toString(),
  });
  const twJson = await twRes.json();
  if (!twRes.ok) throw new Error('twilio send failed: ' + JSON.stringify(twJson));
  return { method: 'twilio', id: twJson.sid };
}

async function sendViaEmailGateway(body) {
  const resendKey = process.env.RESEND_API_KEY;
  const gatewayTo = process.env.SMS_GATEWAY_TO; // full address, e.g. 5551234567@vtext.com
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
    // Blank subject on purpose — some carriers prepend the subject to the
    // delivered text, which would duplicate content. Keep the body short;
    // long messages get truncated or split oddly by carrier gateways.
    body: JSON.stringify({ from, to: [gatewayTo], subject: '', text: body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('resend send failed: ' + JSON.stringify(json));
  return { method: 'email-gateway', id: json.id };
}

export async function sendReminder(body) {
  const tgConfigured = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
  const twConfigured = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER && process.env.TWILIO_TO_NUMBER;
  const emailConfigured = process.env.RESEND_API_KEY && process.env.SMS_GATEWAY_TO;
  if (tgConfigured) return sendViaTelegram(body);
  if (twConfigured) return sendViaTwilio(body);
  if (emailConfigured) return sendViaEmailGateway(body);
  throw new Error('no delivery method configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, the TWILIO_* vars, or RESEND_API_KEY + SMS_GATEWAY_TO');
}

// Exported separately from the HTTP handler so it can be exercised
// directly in tests without going through req/res or real network calls.
export async function computeUndone(fetchers) {
  const { goalsData, healthData, gymData, businessData, readingData, todayKey6am, todayPlain, dow, utcToday } = fetchers;
  const defs = (goalsData && goalsData['recur:defs']) || [];
  const existingGoals = (goalsData && goalsData['goals:' + todayKey6am]) || [];
  const existingByText = {};
  existingGoals.forEach(g => { existingByText[g.text] = g; });

  const ctx = { gymData, readingData, businessData, healthData, todayPlain, todayKey6am, utcToday };
  const undone = [];
  defs.forEach(def => {
    if (!isScheduledToday(def, dow)) return;
    const existing = existingByText[def.name];
    let done = existing ? !!existing.done : false;
    if (!done && def.autoSource) done = sourceDoneToday(def.autoSource, ctx);
    if (!done) undone.push(def.name);
  });
  return undone;
}

export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'unauthorized' });
    }

    const tz = process.env.REMINDER_TIMEZONE || 'America/New_York';
    const hours = (process.env.REMINDER_HOURS_LOCAL || '14,20').split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
    const nowHour = currentHourInTz(tz);
    if (hours.indexOf(nowHour) === -1) {
      return res.status(200).json({ sent: false, skipped: true, reason: 'not a configured hour', nowHour, hours });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });

    const [goalsData, healthData, gymData, businessData, readingData] = await Promise.all([
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'goals'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'health'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'po-coach'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'business'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'reading'),
    ]);

    const { key: todayKey6am, dow } = dateKeyInTz(tz, true);
    const { key: todayPlain } = dateKeyInTz(tz, false);
    const utcToday = new Date().toISOString().slice(0, 10);

    const undone = await computeUndone({ goalsData, healthData, gymData, businessData, readingData, todayKey6am, todayPlain, dow, utcToday });

    if (!undone.length) {
      return res.status(200).json({ sent: false, reason: 'nothing undone' });
    }

    const body = composeMessage(undone, todayPlain, nowHour);
    let result;
    try {
      result = await sendReminder(body);
    } catch (e) {
      return res.status(502).json({ error: 'send failed', detail: e && e.message ? e.message : String(e) });
    }

    return res.status(200).json({ sent: true, undone, method: result.method, id: result.id });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
