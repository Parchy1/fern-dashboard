// ============================================================
// GET /api/config  →  returns a tiny JS file that sets the
// public Supabase config on `window` from Vercel env vars:
//   SUPABASE_URL        (your project URL)
//   SUPABASE_ANON_KEY   (the public anon / publishable key)
//   GOOGLE_SYNC_SECRET  (see api/google-token-sync.js)
//
// Loaded via <script src="/api/config"></script> in the <head>
// BEFORE sync.js / topbar.js. If the env vars aren't set (or the
// site is opened locally), it sets empty strings and the pages
// fall back to whatever default is hardcoded in the JS.
//
// These are PUBLIC values (they ship to the browser anyway), so
// it's fine to expose them — this just lets people configure the
// app with env vars instead of editing files. GOOGLE_SYNC_SECRET is
// no exception: it only gates a write-only endpoint against casual
// abuse, it isn't what protects the stored Google tokens' confidentiality
// (that's the google_tokens table having no anon-key policies at all —
// see api/google-token-sync.js).
// ============================================================
export default function handler(req, res) {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  const googleSyncSecret = process.env.GOOGLE_SYNC_SECRET || '';
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(
    'window.DASH_SUPABASE_URL=' + JSON.stringify(url) + ';' +
    'window.DASH_SUPABASE_KEY=' + JSON.stringify(key) + ';' +
    'window.DASH_GOOGLE_SYNC_SECRET=' + JSON.stringify(googleSyncSecret) + ';'
  );
}
