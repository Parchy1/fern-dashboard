import handler, {
  shouldSendMorningBriefing, composeMorningBriefing,
  computeCaffeineSleepInsight, computeGymCheckinInsight, computeActionableInsight,
} from '../api/send-reminders.js';

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

  // ==================== correlation insight functions (pure) ====================
  {
    function mkTs(y, m, d, h) { return new Date(y, m - 1, d, h, 0, 0).getTime(); }
    function dk(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }

    // ---- caffeine/sleep ----
    {
      const cafLogs = [];
      const morning = {};
      // 6 days with late (>=2pm) caffeine the day before -> worse sleep next morning
      for (let i = 0; i < 6; i++) {
        const day = 1 + i;
        cafLogs.push({ ts: mkTs(2026, 1, day, 15) }); // 3pm
        morning[dk(2026, 1, day + 1)] = { sleepQuality: 2 };
      }
      // 6 days with no late caffeine -> better sleep next morning
      for (let i = 0; i < 6; i++) {
        const day = 20 + i;
        morning[dk(2026, 1, day + 1)] = { sleepQuality: 4 };
      }
      const insight = computeCaffeineSleepInsight({ 'caf:logs': cafLogs }, { 'peak:morning': morning });
      assertTrue(!!insight, 'enough samples on both sides produces a caffeine/sleep insight');
      assertEq(insight.avgWith, 2, 'average sleep quality after late caffeine');
      assertEq(insight.avgWithout, 4, 'average sleep quality without late caffeine');

      const tooFew = computeCaffeineSleepInsight(
        { 'caf:logs': [{ ts: mkTs(2026, 1, 1, 15) }] },
        { 'peak:morning': { [dk(2026, 1, 2)]: { sleepQuality: 2 } } }
      );
      assertEq(tooFew, null, 'below the minimum sample size on either side returns null');

      const earlyOnly = computeCaffeineSleepInsight(
        { 'caf:logs': [{ ts: mkTs(2026, 1, 1, 9) }] }, // 9am, not "late"
        { 'peak:morning': {} }
      );
      assertEq(earlyOnly, null, 'caffeine before 2pm is not counted as "late"');
    }

    // ---- gym/checkin ----
    {
      const doneDays = {};
      const checkins = [];
      for (let i = 0; i < 6; i++) {
        const dateKey = dk(2026, 2, 1 + i);
        doneDays[dateKey] = true;
        checkins.push({ dateKey, feeling: 5, stress: 1 });
      }
      for (let i = 0; i < 6; i++) {
        const dateKey = dk(2026, 2, 20 + i);
        checkins.push({ dateKey, feeling: 2, stress: 4 });
      }
      const gymData = { po_coach_workout_done: doneDays };
      const peakData = { 'peak:checkins': checkins };
      const feelingInsight = computeGymCheckinInsight(gymData, peakData, 'feeling');
      assertTrue(!!feelingInsight, 'enough samples on both sides produces a feeling insight');
      assertEq(feelingInsight.avgWith, 5, 'average feeling on gym days');
      assertEq(feelingInsight.avgWithout, 2, 'average feeling on non-gym days');

      const stressInsight = computeGymCheckinInsight(gymData, peakData, 'stress');
      assertEq(stressInsight.avgWith, 1, 'average stress on gym days');
      assertEq(stressInsight.avgWithout, 4, 'average stress on non-gym days');
    }

    // ---- computeActionableInsight priority + gating ----
    {
      const cafLogs = [];
      const morning = {};
      for (let i = 0; i < 6; i++) {
        cafLogs.push({ ts: mkTs(2026, 3, 1 + i, 15) });
        morning[dk(2026, 3, 2 + i)] = { sleepQuality: 2 };
      }
      for (let i = 0; i < 6; i++) morning[dk(2026, 3, 21 + i)] = { sleepQuality: 4 };
      const caffeineData = { 'caf:logs': cafLogs };
      const peakData = { 'peak:morning': morning };

      const line = computeActionableInsight(caffeineData, peakData, {}, false);
      assertTrue(!!line && line.toLowerCase().includes('caffeine'), 'caffeine/sleep pattern surfaces as an actionable line');

      const none = computeActionableInsight({}, {}, {}, false);
      assertEq(none, null, 'no insight at all when there is not enough history either way');

      // Gym/mood pattern, but a workout is already logged today -> no nudge.
      const doneDays = {}; const checkins = [];
      for (let i = 0; i < 6; i++) { const dateKey = dk(2026, 4, 1 + i); doneDays[dateKey] = true; checkins.push({ dateKey, feeling: 5 }); }
      for (let i = 0; i < 6; i++) { const dateKey = dk(2026, 4, 20 + i); checkins.push({ dateKey, feeling: 2 }); }
      const gymData = { po_coach_workout_done: doneDays };
      const peakData2 = { 'peak:checkins': checkins };
      const suppressed = computeActionableInsight({}, peakData2, gymData, true);
      assertEq(suppressed, null, 'gym/mood nudge is suppressed once a workout is already logged today');
      const shown = computeActionableInsight({}, peakData2, gymData, false);
      assertTrue(!!shown && shown.toLowerCase().includes('workout'), 'gym/mood nudge shows when no workout is logged yet today');
    }
  }

  // ==================== composeMorningBriefing actionableInsight param ====================
  {
    const withInsight = composeMorningBriefing(['Gym'], null, 0, 'Test insight line.');
    assertTrue(withInsight.includes('💡 Test insight line.'), 'an actionable insight is appended as its own line');
    const withoutInsight = composeMorningBriefing(['Gym'], null, 0, null);
    assertTrue(!withoutInsight.includes('💡'), 'no insight line at all when none is passed');
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
