// ============================================================
// POST /api/plaid-link-token
// Authorization: Bearer <PLAID_SYNC_SECRET>
//
// First step of connecting a real bank account: creates a short-lived
// Plaid "link_token" that the browser hands to Plaid's own Link widget
// (a hosted, Plaid-controlled UI — this app never sees or touches actual
// bank credentials, only Plaid does). See api/plaid-exchange-token.js for
// what happens after the user finishes connecting in that widget.
//
// PLAID_SYNC_SECRET is the same abuse-prevention-only pattern as
// NOTES_EMBED_SECRET/GOOGLE_SYNC_SECRET — served to the browser via
// /api/config, so it isn't a real secret once shipped; it exists so a
// stranger can't spam Plaid API calls, not to protect confidentiality.
//
// Required env vars:
//   PLAID_CLIENT_ID, PLAID_SECRET   from plaid.com/dashboard
//   PLAID_ENV                      'sandbox' (default), 'development', or
//                                  'production' — Plaid only lets you
//                                  connect REAL banks in production after
//                                  their own review/approval process;
//                                  sandbox uses fake test banks so the
//                                  whole flow can be built and tried
//                                  without waiting on that.
//   PLAID_SYNC_SECRET              any random string, also served via
//                                  /api/config as window.DASH_PLAID_SYNC_SECRET
// ============================================================

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  if (env === 'production') return 'https://production.plaid.com';
  if (env === 'development') return 'https://development.plaid.com';
  return 'https://sandbox.plaid.com';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const secret = process.env.PLAID_SYNC_SECRET;
    if (!secret) return res.status(500).json({ error: 'server not configured (missing PLAID_SYNC_SECRET)' });
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

    const clientId = process.env.PLAID_CLIENT_ID;
    const plaidSecret = process.env.PLAID_SECRET;
    if (!clientId || !plaidSecret) return res.status(500).json({ error: 'PLAID_CLIENT_ID / PLAID_SECRET not configured' });

    const r = await fetch(plaidBaseUrl() + '/link/token/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        secret: plaidSecret,
        client_name: 'Dashboard',
        // A single fixed id is fine — this is a single-user personal
        // dashboard, not a multi-tenant product with real distinct users.
        user: { client_user_id: 'dashboard-user' },
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      }),
    });
    const json = await r.json();
    if (!r.ok || !json.link_token) return res.status(200).json({ ok: false, error: (json && json.error_message) || 'Plaid link/token/create failed' });
    return res.status(200).json({ ok: true, linkToken: json.link_token });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}

export { plaidBaseUrl };
