// ============================================================
// POST /api/google-token-sync
//
// Write-only endpoint: google.html calls this every time it saves a fresh
// Google OAuth token (initial connect or a refresh), so the Telegram
// assistant (api/telegram-webhook.js — runs server-side, no browser
// involved) has a copy to work with.
//
// Tokens are stored in a DEDICATED Supabase table (google_tokens) with Row
// Level Security enabled and NO policies granted to the public anon key —
// only the service_role key (used here only, never shipped to the browser)
// can read or write it. This is deliberately separate from the app_state
// table everything else syncs through: that table's anon key is public
// (embedded in the site's JS), which is an acceptable trade-off for to-do
// text or workout logs but not for a live Google credential that can read
// actual Gmail/Calendar/Drive content.
//
// One-time setup (run once in the Supabase SQL editor):
//   create table if not exists google_tokens (
//     id int primary key default 1,
//     access text, refresh text, expires bigint,
//     updated_at timestamptz default now()
//   );
//   alter table google_tokens enable row level security;
//   -- No policies added on purpose — this blocks the anon key entirely;
//   -- only the service_role key (which bypasses RLS) can touch this table.
//
// Required env vars:
//   SUPABASE_URL                same one already used everywhere
//   SUPABASE_SERVICE_ROLE_KEY   from Supabase → Settings → API → "service_role"
//                               secret key — NOT the anon key. Keep this
//                               server-side only; never expose it to a page.
//   GOOGLE_SYNC_SECRET          any random string — must match what's
//                               served to the browser via /api/config as
//                               window.DASH_GOOGLE_SYNC_SECRET. This just
//                               gates the write (abuse prevention); it
//                               doesn't protect confidentiality on its own
//                               — that comes from the table having no anon
//                               policies at all, so even a garbage write
//                               here can never be read back by anyone
//                               without the service_role key.
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.GOOGLE_SYNC_SECRET;
  if (!secret) return res.status(500).json({ error: 'GOOGLE_SYNC_SECRET not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' });

  const { access, refresh, expires } = req.body || {};
  if (!access) return res.status(400).json({ error: 'missing access token' });

  const r = await fetch(supabaseUrl + '/rest/v1/google_tokens?on_conflict=id', {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ id: 1, access, refresh: refresh || '', expires: expires || null, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) return res.status(500).json({ error: 'write failed: ' + r.status + ' ' + (await r.text()) });
  return res.status(200).json({ ok: true });
}
