// The wake-up Sleep Recap ports insights-recovery.html's Night Score
// formula exactly (computeNightScore/tierForNightScore) so a number read
// out over Telegram always matches what the dashboard's own gauge would
// show for the same night — these tests pin that formula down directly,
// then verify buildSleepRecap()'s formatting/trend/tip logic on top of it,
// and finally that execLogMorningCheckin actually wires a `recap` into its
// tool result end to end.
import {
  TOOL_EXECUTORS, computeNightScore, tierForNightScore, formatSleepDuration,
  buildSleepRecap, dateKeyFor, hourFor, plainDateKey,
} from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function makeFakeSupabase(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
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
    throw new Error('unexpected fetch: ' + u);
  }
  return { rows, fetchStub };
}

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';

  // ==================== computeNightScore (pinned against insights-recovery.html's formula) ====================
  {
    process.env.REMINDER_TIMEZONE = 'UTC';
    assertEq(computeNightScore(null, null, false, false), null, 'no hours and no quality logged scores as null, not zero');
    // 8h/8h target -> ratio 1, weight 35; quality 5/5 -> ratio 1, weight 35;
    // caffeine untracked -> that 30-weight part is excluded entirely, so the
    // remaining two parts (70 total weight) are renormalized to 100.
    assertEq(computeNightScore(8, 5, false, false), 100, 'a full 8h + perfect quality scores 100 when caffeine is not tracked at all');
    // Same inputs, but caffeine IS tracked and no late caffeine -> all three
    // parts present, still all ratio 1 -> still 100.
    assertEq(computeNightScore(8, 5, false, true), 100, 'a full night stays 100 once caffeine is tracked and none was late');
    // Late caffeine drags the caffeine part's ratio to 0: (35+35+0)/100 = 70.
    assertEq(computeNightScore(8, 5, true, true), 70, 'late caffeine costs exactly its 30-point weight');
    // Half the target hours (4/8 = 0.5 ratio), perfect quality, caffeine untracked:
    // (35*0.5 + 35*1) / 70 * 100 = 75.
    assertEq(computeNightScore(4, 5, false, false), 75, 'partial sleep hours scale linearly against the 8h target');
    // Hours-only (no quality logged): only the hours part counts, fully renormalized.
    assertEq(computeNightScore(8, null, false, false), 100, 'hours alone can still produce a full score if quality was not logged');
    assertEq(computeNightScore(6, null, false, false), 75, 'hours alone scale correctly with no quality part diluting it (6/8 = 75)');
    // Oversleeping doesn't push the ratio above 1 (Math.min(1, ...)).
    assertEq(computeNightScore(11, 5, false, false), 100, 'sleep hours are capped at the target ratio, not rewarded for oversleeping');
  }

  // ==================== tierForNightScore tier boundaries ====================
  {
    assertEq(tierForNightScore(100), 'Restorative night', '100 is Restorative');
    assertEq(tierForNightScore(85), 'Restorative night', '85 is the Restorative floor');
    assertEq(tierForNightScore(84), 'Solid night', '84 falls just short of Restorative');
    assertEq(tierForNightScore(65), 'Solid night', '65 is the Solid floor');
    assertEq(tierForNightScore(64), 'Rough night', '64 falls just short of Solid');
    assertEq(tierForNightScore(45), 'Rough night', '45 is the Rough floor');
    assertEq(tierForNightScore(44), 'Wrecked night', '44 falls into Wrecked');
    assertEq(tierForNightScore(0), 'Wrecked night', '0 is Wrecked');
  }

  // ==================== formatSleepDuration ====================
  {
    assertEq(formatSleepDuration(null), null, 'no hours formats as null, not "0h"');
    assertEq(formatSleepDuration(8), '8h', 'a whole number of hours omits the minutes segment');
    assertEq(formatSleepDuration(7.5), '7h 30m', 'a half hour formats with minutes');
    assertEq(formatSleepDuration(6.25), '6h 15m', 'a quarter hour rounds cleanly');
    assertEq(formatSleepDuration(0.98), '0h 59m', 'sub-hour durations still format sensibly');
  }

  // ==================== dateKeyFor / hourFor (timezone-aware, mirrors tzNow()/plainDateKey()) ====================
  {
    process.env.REMINDER_TIMEZONE = 'America/New_York';
    // 2026-01-15T04:30:00Z is 2026-01-14 23:30 in New York (EST, UTC-5) —
    // both the date AND the hour must roll back across the UTC day boundary.
    const ts = Date.UTC(2026, 0, 15, 4, 30);
    assertEq(dateKeyFor(ts), '2026-01-14', 'dateKeyFor converts to the configured timezone, not UTC, across a day boundary');
    assertEq(hourFor(ts), 23, 'hourFor converts to the configured timezone, not UTC, across a day boundary');
    process.env.REMINDER_TIMEZONE = 'UTC';
  }

  // ==================== buildSleepRecap ====================
  {
    process.env.REMINDER_TIMEZONE = 'UTC';
    const today = plainDateKey();

    assertEq(buildSleepRecap({}, today, { sleepHours: null, sleepQuality: null }, {}), null, 'no score means no recap at all — nothing to relay');

    const fullNight = buildSleepRecap(
      { [today]: { sleepHours: 8, sleepQuality: 5 } }, today, { sleepHours: 8, sleepQuality: 5 }, {},
    );
    assertTrue(fullNight.includes('Score 100 (Restorative night)'), 'a perfect first-ever-logged night reports a 100 score with its tier');
    assertTrue(fullNight.includes('8h'), 'the recap states the duration');
    assertTrue(fullNight.includes('Quality 5/5'), 'the recap states the quality rating');
    assertTrue(!fullNight.includes('💡'), 'a maxed-out score does not get a nagging tip');
    assertTrue(!fullNight.includes('night avg'), 'a single-night history does not claim a multi-night trend');

    // A 7-night history plus tonight, to exercise the trend/debt lines.
    const nights = {};
    ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'].forEach((k, i) => {
      nights[k] = { sleepHours: 6, sleepQuality: 3 }; // consistent below-target nights
    });
    nights[today] = { sleepHours: 5, sleepQuality: 2 }; // tonight is the worst of the bunch
    const trended = buildSleepRecap(nights, today, nights[today], {});
    assertTrue(/7-night avg: \d+/.test(trended), 'a multi-night history reports the trend average');
    assertTrue(trended.includes('Sleep debt this week:'), 'a multi-night history reports running sleep debt against the 8h target');
    assertTrue(trended.includes('💡'), 'a below-target night gets an actionable tip');

    // Tip targets whichever factor is weakest: hours vs quality vs caffeine.
    const hoursWeak = buildSleepRecap({}, today, { sleepHours: 4, sleepQuality: 5 }, {});
    assertTrue(hoursWeak.includes('closer to 8h'), 'when hours are the weak point, the tip is about hours');

    const qualityWeak = buildSleepRecap({}, today, { sleepHours: 8, sleepQuality: 2 }, {});
    assertTrue(qualityWeak.includes('quality was the biggest drag'), 'when quality is the weak point, the tip is about quality');

    const lateCaffeineTs = Date.UTC(2026, 0, 20, 20, 0); // 20:00 UTC, well after 14:00
    const caffeineWeak = buildSleepRecap(
      {}, '2026-01-20', { sleepHours: 8, sleepQuality: 5 },
      { 'caf:logs': [{ ts: lateCaffeineTs }] },
    );
    assertTrue(caffeineWeak.includes('Caffeine after 2pm'), 'when late caffeine is the weak point (and caffeine is actually tracked), the tip calls it out');

    // Caffeine logged, but not late -> the caffeine part scores full and
    // isn't blamed even though it's the only other tracked factor. Hours
    // low enough (4h) that the score still lands under 85 even with a
    // perfect caffeine factor included, so the tip logic actually fires.
    const earlyCaffeineTs = Date.UTC(2026, 0, 20, 12, 0); // 12:00 UTC, before 14:00
    const caffeineOk = buildSleepRecap(
      {}, '2026-01-20', { sleepHours: 4, sleepQuality: 5 },
      { 'caf:logs': [{ ts: earlyCaffeineTs }] },
    );
    assertTrue(caffeineOk.includes('closer to 8h') && !caffeineOk.includes('Caffeine'), 'early caffeine does not get blamed for a low score — hours still is');
  }

  // ==================== execLogMorningCheckin wires a real recap into its tool result ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    process.env.REMINDER_TIMEZONE = 'UTC';
    const result = await TOOL_EXECUTORS.log_morning_checkin({ sleep_hours: 8, sleep_quality: 5 });
    assertEq(result.ok, true, 'log_morning_checkin still succeeds with the recap wiring in place');
    assertTrue(typeof result.recap === 'string' && result.recap.includes('Score 100'), 'the tool result carries a real computed recap, not a placeholder');

    const freshFake = makeFakeSupabase({}); // a separate row — no prior entry to inherit sleepHours/sleepQuality from
    global.fetch = freshFake.fetchStub;
    const empty = await TOOL_EXECUTORS.log_morning_checkin({ wake_time: '07:00' });
    assertEq(empty.recap, null, 'a check-in with neither hours nor quality logged (only wake_time, nothing prior to inherit) carries no recap');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
