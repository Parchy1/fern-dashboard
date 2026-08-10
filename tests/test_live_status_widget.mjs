import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildLiveStatus, computeWorkoutStreak } from '../command-center.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', JSON.stringify(expected), '\n  actual:  ', JSON.stringify(actual)); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const now = new Date(2026, 7, 10, 14, 0, 0).getTime(); // Mon Aug 10 2026, 2:00 PM

function statById(stats, id) { return stats.find(s => s.id === id); }
function baseModel(overrides) {
  return Object.assign({
    goals: [], workoutDays: {}, subscriptions: [], schedule: [],
    sleepNights: {}, waterProgress: null, calTargets: null, calEntries: [],
  }, overrides);
}

// ============================== computeWorkoutStreak ==============================
assertEq(computeWorkoutStreak({}, now), 0, 'no workout days at all -> streak 0');
assertEq(
  computeWorkoutStreak({ '2026-08-08': true, '2026-08-09': true, '2026-08-10': true }, now),
  3, 'consecutive days ending today count fully'
);
assertEq(
  computeWorkoutStreak({ '2026-08-08': true, '2026-08-09': true }, now),
  2, 'yesterday still counts even if today is not logged yet (forgiving rule)'
);
assertEq(
  computeWorkoutStreak({ '2026-08-07': true, '2026-08-09': true, '2026-08-10': true }, now),
  2, 'a gap breaks the streak — only the unbroken run ending at today/yesterday counts'
);

// ============================== buildLiveStatus: tasks ==============================
{
  const stats = buildLiveStatus(baseModel({ goals: [{ text: 'A', done: true }, { text: 'B', done: false }, { text: 'C', done: false }] }), now);
  const tasks = statById(stats, 'tasks');
  assertEq(tasks.value, '2', 'tasks module counts only the OPEN (not-done) items');
  assertEq(tasks.status, 'neutral', 'open tasks remaining is neutral, not flagged as a problem');
}
{
  const stats = buildLiveStatus(baseModel({ goals: [{ text: 'A', done: true }] }), now);
  assertEq(statById(stats, 'tasks').status, 'good', 'all tasks done for the day reads as good');
}
{
  const stats = buildLiveStatus(baseModel({ goals: [] }), now);
  assertEq(statById(stats, 'tasks').value, '—', 'no tasks added at all is an honest dash, not a fabricated 0/0');
}

// ============================== buildLiveStatus: gym streak ==============================
{
  const stats = buildLiveStatus(baseModel({ workoutDays: { '2026-08-09': true } }), now);
  const streak = statById(stats, 'streak');
  assertEq(streak.value, '1', 'a streak from yesterday, not logged yet today, still shows as 1');
  assertEq(streak.status, 'warn', 'a streak that lapses at midnight if not logged today is flagged as at-risk');
  assertTrue(streak.sub.toLowerCase().includes('before it resets'), 'the at-risk sub-label explains why, not just a bare warning');
}
{
  const stats = buildLiveStatus(baseModel({ workoutDays: { '2026-08-09': true, '2026-08-10': true } }), now);
  const streak = statById(stats, 'streak');
  assertEq(streak.status, 'good', 'a streak already logged today is not at-risk');
}

// ============================== buildLiveStatus: subscription renewal ==============================
{
  const stats = buildLiveStatus(baseModel({
    subscriptions: [
      { name: 'Netflix', renewal: '2026-09-01', period: 'monthly' },
      { name: 'Domain', renewal: '2026-08-11', period: 'yearly' },
    ],
  }), now);
  const renewal = statById(stats, 'renewal');
  assertEq(renewal.sub, 'Domain', 'the SOONEST renewal wins, not the first item in the array');
  assertEq(renewal.value, '1d', 'renewal shows real days-until, computed via the same nextRenewal() buildAlerts uses');
  assertEq(renewal.status, 'warn', 'a renewal within 2 days is flagged');
}
{
  const stats = buildLiveStatus(baseModel({ subscriptions: [] }), now);
  assertEq(statById(stats, 'renewal').value, '—', 'no subscriptions tracked is an honest dash');
}

// ============================== buildLiveStatus: next up ==============================
{
  const stats = buildLiveStatus(baseModel({
    schedule: [
      { title: 'Dentist', time: '2:00 PM', isNext: false },
      { title: 'Gym', time: '6:00 PM', isNext: true },
    ],
  }), now);
  assertEq(statById(stats, 'nextup').sub, 'Gym', 'next-up module uses the schedule\'s own isNext flag, not just the first item');
}

// ============================== buildLiveStatus: sleep score ==============================
{
  const stats = buildLiveStatus(baseModel({ sleepNights: { '2026-08-09': { sleepHours: 8, sleepQuality: 5 } } }), now);
  const sleep = statById(stats, 'sleep');
  assertEq(sleep.value, '100', 'a full 8h + perfect quality night scores 100 (same computeNightScore weights as insights-recovery.html)');
  assertEq(sleep.sub, 'Restorative', 'a 100 score is labeled Restorative, matching the same tier thresholds used elsewhere');
  assertEq(sleep.status, 'good', 'a Restorative night reads as good');
}
{
  const stats = buildLiveStatus(baseModel({ sleepNights: {} }), now);
  assertEq(statById(stats, 'sleep').value, '—', 'no sleep logged is an honest dash, not a fabricated score');
}

// ============================== buildLiveStatus: hydration ==============================
{
  const stats = buildLiveStatus(baseModel({ waterProgress: { done: 7, total: 7, ratio: 1 } }), now);
  assertEq(statById(stats, 'water').status, 'good', 'hitting the daily water goal reads as good');
}
{
  const stats = buildLiveStatus(baseModel({ waterProgress: null }), now);
  assertEq(statById(stats, 'water').sub, 'Add your profile to track', 'no water profile set gets an actionable honest message, not a fake 0%');
}

// ============================== buildLiveStatus: calories ==============================
{
  const stats = buildLiveStatus(baseModel({
    calTargets: { calories: 2000 },
    calEntries: [
      { dateKey: '2026-08-10', calories: 600 },
      { dateKey: '2026-08-10', calories: 400 },
      { dateKey: '2026-08-09', calories: 9999 }, // yesterday — must NOT count
    ],
  }), now);
  const cal = statById(stats, 'calories');
  assertEq(cal.value, '1000', 'calories remaining = target minus ONLY today\'s entries, ignoring other days');
  assertEq(cal.status, 'neutral', 'under target is neutral, not flagged');
}
{
  const stats = buildLiveStatus(baseModel({
    calTargets: { calories: 1000 },
    calEntries: [{ dateKey: '2026-08-10', calories: 1400 }],
  }), now);
  assertEq(statById(stats, 'calories').status, 'warn', 'going over today\'s calorie target is flagged');
}
{
  const stats = buildLiveStatus(baseModel({ calTargets: null }), now);
  assertEq(statById(stats, 'calories').sub, 'No goal set', 'no calorie target set is an honest message, not a fabricated remaining count');
}

// ============================== buildLiveStatus: ring + telegram start pending ==============================
{
  const stats = buildLiveStatus(baseModel({}), now);
  const ring = statById(stats, 'ring'), telegram = statById(stats, 'telegram');
  assertTrue(ring.pending === true, 'ring vitals starts in a pending state — buildLiveStatus is synchronous and cannot read the Supabase-only ring_health row itself');
  assertTrue(telegram.pending === true, 'assistant status starts pending for the same reason (telegram_session is Supabase-only)');
  assertEq(stats.length, 9, 'all nine Live Status modules are present');
}

// ============================== HTML/CSS wiring ==============================
const indexHtml = read('index.html');
const css = read('command-center.css');
const js = read('command-center.js');
assertTrue(indexHtml.indexOf('id="ccLiveStatus"') < indexHtml.indexOf('class="cc-top-row"'), 'the Live Status widget is pinned ABOVE the top row, matching the approved mockup');
assertTrue(indexHtml.includes('id="ccLiveBrief"') && indexHtml.includes('id="ccLiveGrid"') && indexHtml.includes('id="ccLiveUpdated"'), 'the widget\'s brief line, stat grid, and synced-timestamp elements all exist');
assertTrue(css.includes('.cc-live-grid') && css.includes('.cc-live-stat'), 'Live Status CSS is present');
assertTrue(css.includes('.cc-live-pulse') && css.includes('.cc-live-stat.is-refreshed'), 'the reduced-motion block exempts the pulse dot and the refresh-highlight animation');
assertTrue(js.includes('export async function refreshLiveStatusExternal') && js.includes("pull('ring_health')") && js.includes("pull('telegram_session')"), 'the async external-data refresh pulls both Supabase-only rows');
assertTrue(js.includes("document.getElementById('ccLiveGrid').innerHTML = renderLiveStatus(model)"), 'render() actually wires the Live Status grid into the page, not just defining the function');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
