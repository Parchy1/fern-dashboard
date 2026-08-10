// ============================================================
// POST /api/apple-health-ingest         (Authorization: Bearer <APPLE_HEALTH_SECRET>)
// POST /api/ring-ingest                 (Authorization: Bearer <RING_INGEST_SECRET>)
//   — /api/ring-ingest is a vercel.json rewrite to this same file with
//     ?device=ring appended. Both external URLs are stable; only the
//     underlying function is shared, the same way /api/whoop-callback,
//     /api/whoop-refresh, and /api/whoop-data already all rewrite into
//     api/whoop.js. This keeps the project under Vercel Hobby's 12
//     serverless-function cap instead of adding a 13th file.
//
// Apple doesn't expose a public web API for HealthKit the way WHOOP does
// OAuth, and cheap BLE rings like the Colmi R02 have no cloud API at all —
// there's no "connect" flow a website can hook into for either. The only
// way to get this data out is something that runs near the device itself:
// an iOS Shortcuts automation for Apple Health, a background script on a
// nearby computer for the ring (see scripts/ring-sync/). Both POST here on
// a schedule; this writes straight into the same Supabase app_state table
// everything else uses (under the 'apple_health' or 'ring_health' key,
// depending on device), so health.html can just read it like any other
// synced row — this endpoint never talks to the browser, only to Supabase.
//
// Body (device=apple_health, the default): any subset of these fields, all
// optional numbers — steps, activeEnergyKcal, exerciseMinutes, standHours,
// restingHeartRate, sleepHours, weightKg
// Body (device=ring): any subset of — heartRate, steps, spo2, sleepHours,
// stress, battery
// Optional either way: date (YYYY-MM-DD) — defaults to "today" in the
// device's configured timezone. Unrecognized fields are ignored rather
// than rejected, so the sender can POST a superset without breaking.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY   (same ones the dashboard already uses)
//   APPLE_HEALTH_SECRET               shared secret for device=apple_health
//   RING_INGEST_SECRET                shared secret for device=ring
// Optional:
//   APPLE_HEALTH_TIMEZONE             IANA tz, default 'America/New_York'
//   RING_TIMEZONE                     IANA tz, default 'America/New_York'
// ============================================================

const FIELDS = ['steps', 'activeEnergyKcal', 'exerciseMinutes', 'standHours', 'restingHeartRate', 'sleepHours', 'weightKg'];
const RING_FIELDS = ['heartRate', 'steps', 'spo2', 'sleepHours', 'stress', 'battery'];
const HISTORY_MAX_DAYS = 60;

function todayInTz(tz) {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const y = local.getFullYear(), m = String(local.getMonth() + 1).padStart(2, '0'), d = String(local.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

async function fetchRow(supabaseUrl, supabaseKey, key) {
  const url = supabaseUrl + '/rest/v1/app_state?key=eq.' + encodeURIComponent(key) + '&select=data';
  const r = await fetch(url, { headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey } });
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || null;
}

async function writeRow(supabaseUrl, supabaseKey, key, data) {
  const r = await fetch(supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: 'Bearer ' + supabaseKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('supabase write failed: ' + r.status + ' ' + (await r.text()));
}

// Exported separately so the merge/prune logic can be unit tested without
// going through req/res or a real Supabase call.
export function buildNextState(existing, incomingSnapshot, date) {
  const history = (existing && existing.history && typeof existing.history === 'object') ? { ...existing.history } : {};
  history[date] = { ...(history[date] || {}), ...incomingSnapshot };
  const dates = Object.keys(history).sort();
  while (dates.length > HISTORY_MAX_DAYS) { delete history[dates.shift()]; }
  // "latest" is the fullest known picture of the most recent calendar day in
  // history (by date, not by POST order) — a day's fields usually arrive
  // across several separate Shortcut runs (steps/energy every few hours,
  // sleep once in the morning), so this must be the accumulated merge, not
  // just whatever this one POST happened to carry. Using the max date key
  // (rather than always the just-POSTed date) also keeps a backfill POST
  // for a past day from clobbering "latest" with stale data.
  const latestDate = dates[dates.length - 1];
  return {
    latest: { ...history[latestDate], date: latestDate, receivedAt: new Date().toISOString() },
    history,
  };
}

export function extractSnapshot(body) {
  const snapshot = {};
  for (const f of FIELDS) {
    const v = body && body[f];
    if (typeof v === 'number' && !isNaN(v)) snapshot[f] = v;
  }
  return snapshot;
}

// Same shape as extractSnapshot, kept as its own export (rather than
// generalizing extractSnapshot to take a fields list) so the existing
// apple-health tests/call sites are untouched — this is purely additive.
export function extractRingSnapshot(body) {
  const snapshot = {};
  for (const f of RING_FIELDS) {
    const v = body && body[f];
    if (typeof v === 'number' && !isNaN(v)) snapshot[f] = v;
  }
  return snapshot;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const isRing = req.query && req.query.device === 'ring';
    const secretEnvVar = isRing ? 'RING_INGEST_SECRET' : 'APPLE_HEALTH_SECRET';
    const secret = process.env[secretEnvVar];
    if (!secret) return res.status(500).json({ error: 'server not configured (missing ' + secretEnvVar + ')' });
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const fields = isRing ? RING_FIELDS : FIELDS;
    const snapshot = isRing ? extractRingSnapshot(body) : extractSnapshot(body);
    if (!Object.keys(snapshot).length) {
      return res.status(400).json({ error: 'no recognized numeric fields in body', accepted: fields });
    }

    const tz = process.env[isRing ? 'RING_TIMEZONE' : 'APPLE_HEALTH_TIMEZONE'] || 'America/New_York';
    const date = (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : todayInTz(tz);

    const stateKey = isRing ? 'ring_health' : 'apple_health';
    const existing = await fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, stateKey);
    const nextState = buildNextState(existing, snapshot, date);
    await writeRow(SUPABASE_URL, SUPABASE_ANON_KEY, stateKey, nextState);

    return res.status(200).json({ ok: true, date, fields: Object.keys(snapshot) });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
