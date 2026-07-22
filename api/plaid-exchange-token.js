// ============================================================
// POST /api/plaid-exchange-token
// Authorization: Bearer <PLAID_SYNC_SECRET>
// Body: { publicToken, institutionName }
//
// Second step of connecting a bank: Plaid Link (running in the browser)
// hands back a short-lived public_token on success — this exchanges it
// for a long-lived access_token, which is the actual credential capable
// of reading real transaction data. That access_token is stored in a
// DEDICATED Supabase table (plaid_items) with Row Level Security enabled
// and NO policies granted to the anon key — only the service_role key
// (used here only, never shipped to the browser) can read or write it.
// Same deliberate split as google_tokens/api/google-token-sync.js: the
// app_state table's anon key is public (embedded in the site's JS), an
// acceptable trade-off for to-do text but not for a live credential that
// can read your actual bank transactions.
//
// One-time setup (run once in the Supabase SQL editor):
//   create table if not exists plaid_items (
//     id int primary key default 1,
//     access_token text, item_id text, institution_name text, cursor text,
//     updated_at timestamptz default now()
//   );
//   alter table plaid_items enable row level security;
//   -- No policies added on purpose — blocks the anon key entirely.
//
// Required env vars:
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV   same as plaid-link-token.js
//   PLAID_SYNC_SECRET                          same as plaid-link-token.js
//   SUPABASE_URL                               same one already used everywhere
//   SUPABASE_SERVICE_ROLE_KEY                  from Supabase → Settings → API
//                                               — NOT the anon key, server-side only
// ============================================================

import { plaidBaseUrl } from './plaid-link-token.js';

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
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
    if (!body || typeof body !== 'object') body = {};
    const publicToken = typeof body.publicToken === 'string' ? body.publicToken : '';
    if (!publicToken) return res.status(400).json({ ok: false, error: 'missing "publicToken"' });
    const institutionName = typeof body.institutionName === 'string' ? body.institutionName.slice(0, 120) : '';

    const exchangeRes = await fetch(plaidBaseUrl() + '/item/public_token/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret: plaidSecret, public_token: publicToken }),
    });
    const exchangeJson = await exchangeRes.json();
    if (!exchangeRes.ok || !exchangeJson.access_token) {
      return res.status(200).json({ ok: false, error: (exchangeJson && exchangeJson.error_message) || 'Plaid item/public_token/exchange failed' });
    }

    const writeRes = await fetch(supabaseUrl + '/rest/v1/plaid_items?on_conflict=id', {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      // A fresh connection always starts a fresh sync cursor — any previously
      // stored cursor belonged to a different item/access_token and would be
      // meaningless (or rejected by Plaid) against this new one.
      body: JSON.stringify({
        id: 1,
        access_token: exchangeJson.access_token,
        item_id: exchangeJson.item_id,
        institution_name: institutionName || null,
        cursor: null,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!writeRes.ok) return res.status(500).json({ ok: false, error: 'Supabase write failed: ' + writeRes.status + ' ' + (await writeRes.text()) });

    return res.status(200).json({ ok: true, institutionName: institutionName || null });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
