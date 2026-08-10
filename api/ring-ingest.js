// ============================================================
// POST /api/ring-ingest
// Authorization: Bearer <RING_INGEST_SECRET>
//
// The Colmi R02 (and similar cheap BLE rings) has no cloud service or
// public API of its own — unlike WHOOP's OAuth, there's no "connect" flow
// a website can hook into, and unlike Apple Health there's no phone-native
// Shortcuts integration either. The only way in is a reverse-engineered
// Bluetooth LE protocol, readable only by something physically near the
// ring (a laptop, a Pi). A background script on that machine polls the
// ring on a schedule and POSTs whatever it read here — this writes it
// straight into the same Supabase app_state table everything else uses
// (under the 'ring_health' key), so health.html can read it exactly like
// the Apple Health card. This endpoint never talks to the browser or the
// ring directly, only to Supabase.
//
// Body: any subset of these fields, all optional numbers —
//   heartRate, steps, spo2, sleepHours, stress, battery
// Optional: date (YYYY-MM-DD) — defaults to "today" in RING_TIMEZONE.
// Unrecognized fields are ignored rather than rejected, so the sync
// script can send a superset without breaking.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY   (same ones the dashboard already uses)
//   RING_INGEST_SECRET                shared secret — set this in the
//                                     Mac-side sync script's config too
// Optional:
//   RING_TIMEZONE                     IANA tz, default 'America/New_York'
// ============================================================

const FIELDS = ['heartRate', 'steps', 'spo2', 'sleepHours', 'stress', 'battery'];
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
// going through req/res or a real Supabase call. Identical shape to
// apple-health-ingest.js's buildNextState on purpose — same merge
// semantics (same-day fields accumulate across multiple POSTs a day apart,
// "latest" is the fullest known picture of the most recent day, not
// necessarily this POST's fields).
export function buildNextState(existing, incomingSnapshot, date) {
  const history = (existing && existing.history && typeof existing.history === 'object') ? { ...existing.history } : {};
  history[date] = { ...(history[date] || {}), ...incomingSnapshot };
  const dates = Object.keys(history).sort();
  while (dates.length > HISTORY_MAX_DAYS) { delete history[dates.shift()]; }
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const secret = process.env.RING_INGEST_SECRET;
    if (!secret) return res.status(500).json({ error: 'server not configured (missing RING_INGEST_SECRET)' });
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const snapshot = extractSnapshot(body);
    if (!Object.keys(snapshot).length) {
      return res.status(400).json({ error: 'no recognized numeric fields in body', accepted: FIELDS });
    }

    const tz = process.env.RING_TIMEZONE || 'America/New_York';
    const date = (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : todayInTz(tz);

    const existing = await fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'ring_health');
    const nextState = buildNextState(existing, snapshot, date);
    await writeRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'ring_health', nextState);

    return res.status(200).json({ ok: true, date, fields: Object.keys(snapshot) });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
