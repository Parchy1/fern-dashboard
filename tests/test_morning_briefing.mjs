import handler, { shouldSendMorningBriefing, composeMorningBriefing } from '../api/send-reminders.js';

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
  return res;
}

// Same Date-freezing trick used in test_reminder_engine.mjs — avoids any
// midnight-boundary flakiness around the real clock.
function freezeClockAt(hour, minute) {
  const OrigDate = global.Date;
  const real = new OrigDate();
  const fixedMs = OrigDate.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), hour, minute, 0, 0);
  class FrozenDate extends OrigDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  global.Date = FrozenDate;
  return () => { global.Date = OrigDate; };
}

(async () => {
  const origFetch = global.fetch;

  // ==================== shouldSendMorningBriefing (pure) ====================
  {
    assertEq(shouldSendMorningBriefing(6 * 60, 7 * 60, 23 * 60, null), false, 'not due before the briefing time');
    assertEq(shouldSendMorningBriefing(7 * 60, 7 * 60, 23 * 60, null), true, 'due exactly at the briefing time');
    assertEq(shouldSendMorningBriefing(9 * 60, 7 * 60, 23 * 60, null), true, 'due any time after the briefing time, same day');
    assertEq(shouldSendMorningBriefing(9 * 60, 7 * 60, 23 * 60, true), false, 'not due again once already sent today');
    assertEq(shouldSendMorningBriefing(23 * 60, 7 * 60, 23 * 60, null), false, 'not due once bedtime has arrived, even if never sent');
  }

  // ==================== composeMorningBriefing (pure) ====================
  {
    const empty = composeMorningBriefing([], null, 0);
    assertTrue(empty.includes('clean slate'), 'an empty today-list gets a distinct "nothing today" line');

    const withItems = composeMorningBriefing(['Gym', 'Read 20 pages'], null, 0);
    assertTrue(withItems.includes('- Gym') && withItems.includes('- Read 20 pages'), 'lists every undone item today');
    assertTrue(!withItems.includes('sleep'), 'no sleep line at all when sleepQuality is null');

    const poorSleep = composeMorningBriefing(['Gym'], 2, 0);
    assertTrue(poorSleep.includes('2/5') && poorSleep.toLowerCase().includes('rough one'), 'a poor logged sleep quality gets an explicit callout');

    const goodSleep = composeMorningBriefing(['Gym'], 4, 0);
    assertTrue(goodSleep.includes('4/5') && !goodSleep.toLowerCase().includes('rough one'), 'a decent sleep quality is mentioned without the "rough one" callout');

    const withSubs = composeMorningBriefing([], null, 1);
    assertTrue(withSubs.includes('1 subscription renewal') && !withSubs.includes('renewals'), 'singular phrasing for exactly one upcoming renewal');
    const withMultiSubs = composeMorningBriefing([], null, 3);
    assertTrue(withMultiSubs.includes('3 subscription renewals'), 'plural phrasing for multiple upcoming renewals');
    const noSubs = composeMorningBriefing([], null, 0);
    assertTrue(!noSubs.toLowerCase().includes('renewal'), 'no renewal line at all when nothing is due');
  }

  // ==================== full handler integration ====================
  {
    const unfreeze = freezeClockAt(8, 0); // 08:00 UTC — past the default 07:00 briefing time, well before bedtime
    try {
      process.env.TELEGRAM_BOT_TOKEN = 'tok'; process.env.TELEGRAM_CHAT_ID = '123';
      process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon';
      process.env.REMINDER_TIMEZONE = 'UTC';
      process.env.BEDTIME_LOCAL = '23:59';
      delete process.env.MORNING_BRIEFING_TIME; // exercise the 07:00 default
      delete process.env.CRON_SECRET;

      let sentText = null;
      let writtenState = null;
      const rows = {
        goals: { 'recur:defs': [{ name: 'Gym', freq: 'daily' }] },
        peak: { 'peak:morning': {} },
      };
      global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/rest/v1/app_state')) {
          if (!opts || !opts.method) {
            const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
            return { ok: true, json: async () => [{ data: rows[key] || null }] };
          }
          const body = JSON.parse(opts.body);
          rows[body.key] = body.data;
          if (body.key === 'reminder_state') writtenState = body.data;
          return { ok: true, json: async () => ({}) };
        }
        if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
        throw new Error('unexpected fetch: ' + u);
      };

      const res = mockRes();
      await handler({ headers: {} }, res);
      assertEq(res._status, 200, 'full handler returns 200');
      assertEq(res._body.sent, true, 'full handler sends the morning briefing once its time has arrived');
      assertTrue(!!sentText && sentText.includes('Gym'), 'the briefing message lists the undone recurring item for today');
      assertTrue(res._body.results.some(r => r.name === '__morning_briefing__'), 'result is tagged distinctly as the morning briefing');
      assertTrue(!!writtenState && Object.values(writtenState)[0].__morning_briefing__ === true, 'the sent flag is persisted so it does not repeat');

      // A second tick the same day must NOT resend.
      const res2 = mockRes();
      sentText = null;
      await handler({ headers: {} }, res2);
      assertEq(res2._body.sent, false, 'a second tick the same day does not resend the briefing');
      assertEq(sentText, null, 'no message was actually sent the second time');
    } finally {
      unfreeze();
    }
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
