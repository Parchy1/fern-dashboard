import handler, { plainDateKey } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function mockRes() {
  const res = { _status: null, _body: null };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  res.send = (b) => { res._body = b; return res; };
  return res;
}

// Fake Supabase app_state table. Also tracks whether Claude/Telegram were
// ever hit, so "the bot did nothing at all" is a real assertion, not just
// an inference from the HTTP status.
function makeFakeSupabase(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  const calls = { anthropic: 0, sendMessage: 0 };
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('/rest/v1/app_state')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
        return { ok: true, json: async () => [{ data: rows[key] || {} }] };
      }
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        return { ok: true, json: async () => ({}) };
      }
    }
    if (u.includes('api.anthropic.com')) {
      calls.anthropic++;
      return { ok: true, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Morning! Here is your day.' }] }) };
    }
    if (u.includes('sendMessage')) {
      calls.sendMessage++;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    throw new Error('unexpected fetch: ' + u);
  }
  return { rows, calls, fetchStub };
}

(async () => {
  const origFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
  process.env.TELEGRAM_CHAT_ID = '555';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';
  const headers = { 'x-telegram-bot-api-secret-token': 'shh-secret' };

  // ---- before any wake phrase today: fully silent, zero API calls ----
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { update_id: 1, message: { chat: { id: 555 }, text: 'log a $5 coffee' } } }, res);
    assertEq(res._status, 200, 'a dormant-day message still gets a 200 (no Telegram retry storm)');
    assertTrue(!!res._body && res._body.dormant === true, 'the response is flagged dormant so this is distinguishable from real processing');
    assertEq(fake.calls.anthropic, 0, 'no Claude call is made before the wake phrase');
    assertEq(fake.calls.sendMessage, 0, 'no reply is sent before the wake phrase — fully silent, per the chosen "max savings" behavior');
  }

  // ---- a slash command before the wake phrase is ALSO gated (the "Everything" scope) ----
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { update_id: 2, message: { chat: { id: 555 }, text: '/today' } } }, res);
    assertTrue(res._body.dormant === true, '/today is gated the same as free-form chat before the wake phrase, not treated as a cheap exempt command');
    assertEq(fake.calls.sendMessage, 0, 'no /today summary is sent before the wake phrase');
  }

  // ---- an unrelated message that merely contains "morning" does not activate ----
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { update_id: 3, message: { chat: { id: 555 }, text: 'remind me tomorrow morning about the meeting' } } }, res);
    assertTrue(res._body.dormant === true, 'a message that merely mentions "morning" mid-sentence does not activate the day');
    assertEq(fake.rows.telegram_session, undefined, 'no session row is written for a non-wake-phrase message');
  }

  // ---- "good morning" activates AND is itself processed normally (a real reply, not silence) ----
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { update_id: 4, message: { chat: { id: 555 }, text: 'Good morning!' } } }, res);
    assertEq(res._status, 200, 'the wake-phrase message itself succeeds');
    assertTrue(!res._body.dormant, 'the wake-phrase message is NOT reported dormant — it gets real processing');
    assertEq(fake.calls.anthropic, 1, 'saying the wake phrase reaches Claude and gets a real reply, not just a silent unlock');
    assertEq(fake.calls.sendMessage, 1, 'a real reply is sent back for the wake-phrase message');
    assertEq(fake.rows.telegram_session.dateKey, plainDateKey(), 'activating the day writes a session row for today\'s date key');
  }

  // ---- once activated, later messages that day are processed normally, no re-greeting needed ----
  {
    const fake = makeFakeSupabase({ telegram_session: { dateKey: plainDateKey() } });
    global.fetch = fake.fetchStub;
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { update_id: 5, message: { chat: { id: 555 }, text: 'log a $5 coffee' } } }, res);
    assertTrue(!res._body.dormant, 'a normal message later the same day is processed once the day is already activated');
    assertEq(fake.calls.anthropic, 1, 'the already-activated day reaches Claude normally');
  }

  // ---- a session activated on a PRIOR day does not carry over — must re-greet ----
  {
    const fake = makeFakeSupabase({ telegram_session: { dateKey: '2020-01-01' } });
    global.fetch = fake.fetchStub;
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { update_id: 6, message: { chat: { id: 555 }, text: 'log a $5 coffee' } } }, res);
    assertTrue(res._body.dormant === true, 'a session activated on an old date does not activate today — the gate resets daily');
    assertEq(fake.calls.anthropic, 0, 'no Claude call happens on a stale/expired session');
  }

  // ---- other accepted wake-phrase forms ----
  for (const phrase of ['gm', 'GM', 'morning', 'good morning, let\'s go', 'Good Morning.']) {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { update_id: 100 + phrase.length, message: { chat: { id: 555 }, text: phrase } } }, res);
    assertTrue(!res._body.dormant, JSON.stringify(phrase) + ' is recognized as a valid wake phrase');
  }

  // ---- a callback_query (button tap) is NOT gated by the daily-activation check ----
  {
    const fake = makeFakeSupabase({});
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('answerCallbackQuery') || u.includes('editMessageReplyMarkup') || u.includes('editMessageText')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      return fake.fetchStub(url, opts);
    };
    const res = mockRes();
    // An unresolvable/expired callback still proves the request reached
    // callback-handling code (not the dormant short-circuit) — a genuinely
    // gated request would come back {dormant:true} instead of this shape.
    await handler({ method: 'POST', headers, body: { callback_query: { id: 'cb1', data: 'sched-ok:whatever', message: { chat: { id: 555 }, message_id: 1, text: 'Reminder' } } } }, res);
    assertTrue(!res._body || res._body.dormant !== true, 'a callback_query is handled on its own path, unaffected by the daily-activation gate');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
