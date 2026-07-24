// Standalone verification of insights.html's predictive engine logic
// (weight projection, sleep debt, burnout risk). insights.html has no
// module exports (browser-global IIFE), so this duplicates the exact
// functions to test them in isolation — same approach as
// test_insights_bottleneck.mjs.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertClose(actual, expected, label, eps) {
  eps = eps == null ? 0.01 : eps;
  if (typeof actual === 'number' && Math.abs(actual - expected) <= eps) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected ~', expected, '\n  actual:  ', actual); }
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

const WEIGHT_MIN_POINTS = 3;
const TARGET_SLEEP_HOURS = 8;
const BURNOUT_TREND_DIFF = { stress: 0.5, sleepQuality: 0.5, consistency: 0.15 };

function computeLinearTrend(points, windowDays) {
  const cutoff = windowDays != null ? Date.now() - windowDays * 86400000 : -Infinity;
  const pts = (points || [])
    .filter(p => p && typeof p.t === 'number' && typeof p.v === 'number' && !isNaN(p.t) && p.t >= cutoff)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 86400000);
  const ys = pts.map(p => p.v);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const lastX = xs[xs.length - 1];
  return { slopePerDay: slope, currentEstimate: slope * lastX + intercept, n };
}

function weightEntriesToPoints(entries) {
  return (entries || [])
    .filter(e => e && e.dateKey && typeof e.weight === 'number')
    .map(e => ({ t: new Date(e.dateKey).getTime(), v: e.weight }))
    .filter(p => !isNaN(p.t));
}

function computeWeightProjection(weightEntries, windowDays, projectDays) {
  const trend = computeLinearTrend(weightEntriesToPoints(weightEntries), windowDays);
  if (!trend || trend.n < WEIGHT_MIN_POINTS) return null;
  return {
    currentEstimate: trend.currentEstimate,
    slopePerDay: trend.slopePerDay,
    slopePerWeek: trend.slopePerDay * 7,
    projectedValue: trend.currentEstimate + trend.slopePerDay * projectDays,
    projectDays,
    n: trend.n,
  };
}

function computeSleepDebt(dayRows, targetHours) {
  targetHours = targetHours == null ? TARGET_SLEEP_HOURS : targetHours;
  const nights = (dayRows || []).filter(r => typeof r.sleepHours === 'number');
  if (!nights.length) return null;
  const totalDebt = nights.reduce((a, r) => a + Math.max(0, targetHours - r.sleepHours), 0);
  return { totalDebt, nights: nights.length, targetHours, avgDebtPerNight: totalDebt / nights.length };
}

function computeBurnoutRisk(dayRows) {
  const recent = (dayRows || []).slice(0, 7);
  const prior = (dayRows || []).slice(7, 14);
  function avgField(rows, field) {
    const vals = rows.map(r => r[field]).filter(v => v != null);
    return vals.length ? avg(vals) : null;
  }
  const recentStress = avgField(recent, 'outcomeStress');
  const priorStress = avgField(prior, 'outcomeStress');
  const recentSleepQ = avgField(recent, 'sleepQuality');
  const priorSleepQ = avgField(prior, 'sleepQuality');
  const recentConsistency = avgField(recent, 'consistencyRate');
  const priorConsistency = avgField(prior, 'consistencyRate');

  const signals = [];
  if (recentStress != null && priorStress != null && (recentStress - priorStress) >= BURNOUT_TREND_DIFF.stress) {
    signals.push('stress has been trending up this week');
  }
  if (recentSleepQ != null && priorSleepQ != null && (priorSleepQ - recentSleepQ) >= BURNOUT_TREND_DIFF.sleepQuality) {
    signals.push('sleep quality has been trending down this week');
  }
  if (recentConsistency != null && priorConsistency != null && (priorConsistency - recentConsistency) >= BURNOUT_TREND_DIFF.consistency) {
    signals.push('habit/to-do consistency has slipped this week');
  }

  const comparisonsAvailable = [
    recentStress != null && priorStress != null,
    recentSleepQ != null && priorSleepQ != null,
    recentConsistency != null && priorConsistency != null,
  ].filter(Boolean).length;
  if (!comparisonsAvailable) return { level: 'Unknown', signals: [], insufficientData: true };

  const level = signals.length >= 2 ? 'Elevated' : signals.length === 1 ? 'Moderate' : 'Low';
  return { level, signals, insufficientData: false };
}

// ==================== computeLinearTrend ====================
{
  const dayMs = 86400000;
  const t0 = Date.now() - 10 * dayMs;
  // Perfectly linear: value increases by 1 per day, starting at 100.
  const points = [];
  for (let i = 0; i < 10; i++) points.push({ t: t0 + i * dayMs, v: 100 + i });
  const trend = computeLinearTrend(points, 60);
  assertTrue(!!trend, 'a clean linear series produces a trend');
  assertClose(trend.slopePerDay, 1, 'slope is correctly recovered as 1/day');
  assertClose(trend.currentEstimate, 109, 'currentEstimate lands on the trend line at the last point');

  const tooFew = computeLinearTrend([{ t: Date.now(), v: 5 }], 60);
  assertEq(tooFew, null, 'a single point is not enough to fit a trend');

  const outOfWindow = computeLinearTrend([{ t: Date.now() - 200 * dayMs, v: 1 }, { t: Date.now() - 190 * dayMs, v: 2 }], 30);
  assertEq(outOfWindow, null, 'points entirely outside the trailing window are excluded, leaving too few');
}

// ==================== weightEntriesToPoints ====================
{
  const points = weightEntriesToPoints([
    { dateKey: '2026-01-01', weight: 180 },
    { dateKey: '2026-01-05', weight: 179 },
    { bad: 'entry' },
    { dateKey: '2026-01-10' },
  ]);
  assertEq(points.length, 2, 'only well-formed entries with a numeric weight are converted');
  assertEq(points[0].v, 180, 'weight value is carried through as v');
}

// ==================== computeWeightProjection ====================
{
  const dayMs = 86400000;
  const base = new Date();
  const entries = [];
  // Losing 0.1 lb/day over 10 entries -> -0.7 lb/week.
  for (let i = 0; i < 10; i++) {
    const d = new Date(base.getTime() - (9 - i) * dayMs);
    const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    entries.push({ dateKey, weight: 180 - i * 0.1 });
  }
  const projection = computeWeightProjection(entries, 45, 30);
  assertTrue(!!projection, 'enough weigh-ins produce a projection');
  assertClose(projection.slopePerWeek, -0.7, 'losing weight produces a negative slope per week', 0.05);
  assertTrue(projection.projectedValue < projection.currentEstimate, 'a losing trend projects a lower value 30 days out');

  const tooFewEntries = computeWeightProjection(entries.slice(0, 2), 45, 30);
  assertEq(tooFewEntries, null, 'fewer than the minimum weigh-ins returns no projection');
}

// ==================== computeSleepDebt ====================
{
  const rows = [
    { sleepHours: 6 }, { sleepHours: 7 }, { sleepHours: 8.5 }, { sleepHours: 5 }, { sleepHours: null },
  ];
  const debt = computeSleepDebt(rows, 8);
  assertTrue(!!debt, 'nights with sleep data produce a debt result');
  assertEq(debt.nights, 4, 'only nights with a logged sleepHours count, nulls are excluded');
  assertClose(debt.totalDebt, 2 + 1 + 0 + 3, 'debt sums (target - actual) per night, floored at 0 for oversleep nights');
  assertClose(debt.avgDebtPerNight, 6 / 4, 'avgDebtPerNight is totalDebt / nights with data');

  const noData = computeSleepDebt([{ sleepHours: null }], 8);
  assertEq(noData, null, 'no logged nights at all returns null rather than a fake zero');
}

// ==================== computeBurnoutRisk ====================
{
  // Recent 7 days: high stress, low sleep quality, low consistency.
  // Prior 7 days: low stress, high sleep quality, high consistency.
  const recent = [];
  for (let i = 0; i < 7; i++) recent.push({ outcomeStress: 4, sleepQuality: 2, consistencyRate: 0.3 });
  const prior = [];
  for (let i = 0; i < 7; i++) prior.push({ outcomeStress: 2, sleepQuality: 4, consistencyRate: 0.8 });
  const risk = computeBurnoutRisk(recent.concat(prior));
  assertEq(risk.level, 'Elevated', 'all three signals worsening together is flagged Elevated');
  assertEq(risk.signals.length, 3, 'all three individual signals are reported');

  // Only stress rising, everything else flat.
  const recent2 = [];
  for (let i = 0; i < 7; i++) recent2.push({ outcomeStress: 4, sleepQuality: 3, consistencyRate: 0.6 });
  const prior2 = [];
  for (let i = 0; i < 7; i++) prior2.push({ outcomeStress: 2, sleepQuality: 3, consistencyRate: 0.6 });
  const risk2 = computeBurnoutRisk(recent2.concat(prior2));
  assertEq(risk2.level, 'Moderate', 'exactly one worsening signal is Moderate, not Elevated');

  // Nothing worsening.
  const flat = [];
  for (let i = 0; i < 14; i++) flat.push({ outcomeStress: 3, sleepQuality: 3, consistencyRate: 0.6 });
  const risk3 = computeBurnoutRisk(flat);
  assertEq(risk3.level, 'Low', 'stable weeks report Low risk');
  assertEq(risk3.signals.length, 0, 'no signals are listed when nothing is trending worse');

  // No data at all.
  const risk4 = computeBurnoutRisk([]);
  assertTrue(risk4.insufficientData === true, 'no data at all is reported as insufficient rather than a fake Low');
  assertEq(risk4.level, 'Unknown', 'insufficient data reports an Unknown level rather than guessing Low');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
