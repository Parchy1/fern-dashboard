// ============================================================
// POST /api/plaid-sync-transactions
// Authorization: Bearer <PLAID_SYNC_SECRET>
//
// Pulls new transactions from the connected bank via Plaid's cursor-based
// /transactions/sync endpoint and returns them as SUGGESTIONS — nothing
// gets written to your actual Purchases list or account balances here.
// finance.html shows each one with an "Add to Purchases" / "Dismiss"
// button, the exact same review-before-logging pattern already used for
// Gmail-scanned receipts, since a bank feed can be miscategorized,
// duplicated, or include something you don't want tracked as a purchase
// (a transfer between your own accounts, for instance).
//
// Only transactions with a POSITIVE amount are surfaced — in Plaid's
// convention that's money leaving the account (an actual purchase),
// while negative amounts are refunds/deposits/incoming transfers, which
// aren't purchases. Transfer/income categories are excluded outright for
// the same reason (see EXCLUDED_PLAID_CATEGORIES below).
//
// The sync cursor (Plaid's own pagination bookmark) is stored alongside
// the access_token in the plaid_items table so each call only fetches
// what's genuinely new since last time, not the whole transaction
// history again.
//
// Required env vars: same as plaid-exchange-token.js.
// ============================================================

import { plaidBaseUrl } from './plaid-link-token.js';

// Best-guess mapping from Plaid's personal_finance_category.primary enum
// to this app's own 8 purchase categories (see PURCHASE_CATS in
// finance.html) — approximate by nature, same "best guess if unclear"
// tone as the Gmail-receipt AI parser's category mapping.
const PLAID_CATEGORY_MAP = {
  FOOD_AND_DRINK: 'food',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'shopping',
  RENT_AND_UTILITIES: 'bills',
  BANK_FEES: 'bills',
  LOAN_PAYMENTS: 'bills',
  TRANSPORTATION: 'transport',
  MEDICAL: 'health',
  PERSONAL_CARE: 'health',
  ENTERTAINMENT: 'entertainment',
  TRAVEL: 'travel',
  GENERAL_SERVICES: 'other',
  GOVERNMENT_AND_NON_PROFIT: 'other',
};
// Not purchases at all — money moving between your own accounts or coming
// in, not something spent. Excluded rather than mis-bucketed into "other".
const EXCLUDED_PLAID_CATEGORIES = ['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT'];
const PUR_CCY_KEYS = ['USD', 'DOP'];

export function mapPlaidTransaction(txn) {
  if (!txn || !(Number(txn.amount) > 0)) return null;
  const primary = txn.personal_finance_category && txn.personal_finance_category.primary;
  if (EXCLUDED_PLAID_CATEGORIES.includes(primary)) return null;
  const currency = PUR_CCY_KEYS.includes(txn.iso_currency_code) ? txn.iso_currency_code : 'USD';
  return {
    plaidId: txn.transaction_id,
    merchant: String(txn.merchant_name || txn.name || '(unknown)').slice(0, 80),
    amount: Number(txn.amount),
    currency,
    category: PLAID_CATEGORY_MAP[primary] || 'other',
    date: txn.date,
  };
}

async function fetchPlaidItem(supabaseUrl, serviceKey) {
  const r = await fetch(supabaseUrl + '/rest/v1/plaid_items?id=eq.1&select=*', {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!r.ok) throw new Error('Supabase read failed: ' + r.status + ' ' + (await r.text()));
  const rows = await r.json();
  return rows && rows[0];
}

async function writeCursor(supabaseUrl, serviceKey, cursor) {
  const r = await fetch(supabaseUrl + '/rest/v1/plaid_items?id=eq.1', {
    method: 'PATCH',
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('Supabase cursor update failed: ' + r.status + ' ' + (await r.text()));
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
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' });

    const item = await fetchPlaidItem(supabaseUrl, serviceKey);
    if (!item || !item.access_token) return res.status(200).json({ ok: false, error: 'no bank connected yet' });

    const suggestions = [];
    let cursor = item.cursor || undefined;
    let hasMore = true;
    // Plaid recommends looping until has_more is false to fully catch up in
    // one call, rather than only reading a single page and leaving the rest
    // stranded until the next manual sync click.
    while (hasMore) {
      const r = await fetch(plaidBaseUrl() + '/transactions/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, secret: plaidSecret, access_token: item.access_token, cursor }),
      });
      const json = await r.json();
      if (!r.ok) return res.status(200).json({ ok: false, error: (json && json.error_message) || 'Plaid transactions/sync failed' });
      (json.added || []).forEach(txn => {
        const mapped = mapPlaidTransaction(txn);
        if (mapped) suggestions.push(mapped);
      });
      cursor = json.next_cursor;
      hasMore = !!json.has_more;
    }

    await writeCursor(supabaseUrl, serviceKey, cursor);
    return res.status(200).json({ ok: true, suggestions, institutionName: item.institution_name || null });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
