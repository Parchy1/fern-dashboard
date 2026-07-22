// Standalone verification of peak.html's correlation-insight algorithms.
// peak.html has no module exports (browser-global IIFE), so this duplicates
// the exact logic from computeCaffeineSleepInsight()/computeSleepStressInsight()
// verbatim, mirroring this repo's established approach for testing
// gym.html/peak.html's pure logic without a DOM (see test_rest_timer_logic.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const INSIGHT_MIN_SAMPLES = 5;
function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dateToKey(dt);
}

function computeCaffeineSleepInsight(cafLogs, morning) {
  const lateCaffeineDays = new Set();
  (cafLogs || []).forEach(l => {
    if (!l.ts) return;
    const d = new Date(l.ts);
    if (d.getHours() >= 14) lateCaffeineDays.add(dateToKey(d));
  });
  const withLate = [], withoutLate = [];
  Object.keys(morning || {}).forEach(dateKey => {
    const q = morning[dateKey] && morning[dateKey].sleepQuality;
    if (!q) return;
    const prevDay = shiftDateKey(dateKey, -1);
    (lateCaffeineDays.has(prevDay) ? withLate : withoutLate).push(q);
  });
  if (withLate.length < INSIGHT_MIN_SAMPLES || withoutLate.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgWith: avg(withLate), avgWithout: avg(withoutLate), nWith: withLate.length, nWithout: withoutLate.length };
}

function computeSleepStressInsight(morning, checkins) {
  const stressByDay = {};
  (checkins || []).forEach(c => {
    if (!c.stress || !c.dateKey) return;
    (stressByDay[c.dateKey] = stressByDay[c.dateKey] || []).push(c.stress);
  });
  const goodSleepStress = [], poorSleepStress = [];
  Object.keys(morning || {}).forEach(dateKey => {
    const q = morning[dateKey] && morning[dateKey].sleepQuality;
    const dayStress = stressByDay[dateKey];
    if (!q || !dayStress || !dayStress.length) return;
    const dayAvgStress = avg(dayStress);
    if (q >= 4) goodSleepStress.push(dayAvgStress);
    else if (q <= 2) poorSleepStress.push(dayAvgStress);
  });
  if (goodSleepStress.length < INSIGHT_MIN_SAMPLES || poorSleepStress.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgGood: avg(goodSleepStress), avgPoor: avg(poorSleepStress), nGood: goodSleepStress.length, nPoor: poorSleepStress.length };
}

// ---- helpers to build test fixtures ----
function keyDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return dateToKey(d); }
function tsAt(daysAgo, hour) { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime(); }

// ==================== computeCaffeineSleepInsight ====================
{
  assertEq(computeCaffeineSleepInsight([], {}), null, 'returns null with no data at all');

  // Fewer than INSIGHT_MIN_SAMPLES (5) days on one side -> null.
  const morningSmall = {};
  [0, 1, 2].forEach(n => { morningSmall[keyDaysAgo(n)] = { sleepQuality: 3 }; });
  assertEq(computeCaffeineSleepInsight([], morningSmall), null, 'returns null when below the minimum sample size on the "without" side');

  // 5 poor-sleep days each preceded by late caffeine, 5 good-sleep days preceded by none.
  const morning = {};
  [0, 1, 2, 3, 4].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 2 }; });
  [5, 6, 7, 8, 9].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 5 }; });
  const cafLogs = [1, 2, 3, 4, 5].map(n => ({ ts: tsAt(n, 15) })); // 3pm, precedes days 0-4
  const result = computeCaffeineSleepInsight(cafLogs, morning);
  assertTrue(!!result, 'returns a result once both sides have >= 5 samples');
  assertEq(result.avgWith, 2, 'average sleep quality on late-caffeine-preceded days is correct');
  assertEq(result.avgWithout, 5, 'average sleep quality on non-late-caffeine days is correct');
  assertEq(result.nWith, 5, 'sample count for the "with" side is correct');
  assertEq(result.nWithout, 5, 'sample count for the "without" side is correct');

  // Caffeine logged before 2pm must NOT count as "late".
  const earlyOnly = [1, 2, 3, 4, 5].map(n => ({ ts: tsAt(n, 9) }));
  const noLateResult = computeCaffeineSleepInsight(earlyOnly, morning);
  assertEq(noLateResult, null, 'caffeine logged only before 2pm produces no "late caffeine" days, so there aren\'t enough samples on that side');

  // Entries with no ts, or non-numeric ts, are safely ignored.
  const junkLogs = [{ ts: null }, {}, { ts: tsAt(1, 15) }, { ts: tsAt(2, 15) }, { ts: tsAt(3, 15) }, { ts: tsAt(4, 15) }, { ts: tsAt(5, 15) }];
  assertTrue(!!computeCaffeineSleepInsight(junkLogs, morning), 'malformed caffeine log entries are safely skipped, not crashed on');
}

// ==================== computeSleepStressInsight ====================
{
  assertEq(computeSleepStressInsight({}, []), null, 'returns null with no data at all');

  const morning = {};
  [0, 1, 2, 3, 4].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 1 }; });
  [5, 6, 7, 8, 9].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 5 }; });
  const checkins = [];
  [0, 1, 2, 3, 4].forEach(n => checkins.push({ dateKey: keyDaysAgo(n), stress: 5 }));
  [5, 6, 7, 8, 9].forEach(n => checkins.push({ dateKey: keyDaysAgo(n), stress: 1 }));
  const result = computeSleepStressInsight(morning, checkins);
  assertTrue(!!result, 'returns a result once both sides have >= 5 samples');
  assertEq(result.avgPoor, 5, 'average stress on poor-sleep (<=2) days is correct');
  assertEq(result.avgGood, 1, 'average stress on good-sleep (>=4) days is correct');

  // A sleepQuality of exactly 3 (neither good nor poor) must be excluded from both buckets.
  const morningWithMiddle = Object.assign({}, morning);
  morningWithMiddle[keyDaysAgo(10)] = { sleepQuality: 3 };
  const checkinsWithMiddle = checkins.concat([{ dateKey: keyDaysAgo(10), stress: 3 }]);
  const resultMiddle = computeSleepStressInsight(morningWithMiddle, checkinsWithMiddle);
  assertEq(resultMiddle.nGood, 5, 'a sleepQuality of exactly 3 is not counted as "good" (>=4 only)');
  assertEq(resultMiddle.nPoor, 5, 'a sleepQuality of exactly 3 is not counted as "poor" (<=2 only)');

  // A day with multiple check-ins averages its own stress values first.
  const morningMulti = {};
  [0, 1, 2, 3, 4].forEach(n => { morningMulti[keyDaysAgo(n)] = { sleepQuality: 1 }; });
  [5, 6, 7, 8, 9].forEach(n => { morningMulti[keyDaysAgo(n)] = { sleepQuality: 5 }; });
  const checkinsMulti = [];
  [0, 1, 2, 3, 4].forEach(n => {
    checkinsMulti.push({ dateKey: keyDaysAgo(n), stress: 4 });
    checkinsMulti.push({ dateKey: keyDaysAgo(n), stress: 6 }); // day average = 5, matching the single-checkin scenario above
  });
  [5, 6, 7, 8, 9].forEach(n => checkinsMulti.push({ dateKey: keyDaysAgo(n), stress: 1 }));
  const resultMulti = computeSleepStressInsight(morningMulti, checkinsMulti);
  assertEq(resultMulti.avgPoor, 5, 'multiple check-ins on the same day are averaged before being folded into the overall comparison');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
