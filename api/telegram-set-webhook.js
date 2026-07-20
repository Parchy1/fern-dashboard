// ============================================================
// GET /api/telegram-set-webhook?secret=<TELEGRAM_WEBHOOK_SECRET>
//
// One-time setup helper: registers this deployment's /api/telegram-webhook
// URL with Telegram as your bot's webhook, using the live request host (so
// it always matches wherever this actually got deployed) and the same
// TELEGRAM_WEBHOOK_SECRET already set in Vercel — Telegram then includes
// that secret on every future webhook call, which telegram-webhook.js
// checks before doing anything else.
//
// Visit this URL once (in your own browser, while logged into nothing in
// particular — it's just a GET) after TELEGRAM_BOT_TOKEN and
// TELEGRAM_WEBHOOK_SECRET are both set in Vercel and deployed. Re-run it
// any time the deployment URL changes.
//
// Required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// ============================================================
export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET not configured' });

  const provided = (req.query && req.query.secret) || '';
  if (provided !== secret) return res.status(401).json({ error: 'unauthorized — visit this URL with ?secret=<your TELEGRAM_WEBHOOK_SECRET>' });

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const webhookUrl = proto + '://' + host + '/api/telegram-webhook';

  const setRes = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
  });
  const json = await setRes.json();
  return res.status(setRes.ok ? 200 : 500).json(Object.assign({ webhookUrl }, json));
}
