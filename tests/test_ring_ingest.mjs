import { extractSnapshot, buildNextState } from '../api/ring-ingest.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ---- extractSnapshot ----
assertEq(
  extractSnapshot({ heartRate: 62, steps: 4200, notARealField: 99, stress: 'not a number' }),
  { heartRate: 62, steps: 4200 },
  'extractSnapshot keeps only recognized numeric fields, drops unknown keys and non-numbers'
);
assertEq(extractSnapshot({}), {}, 'extractSnapshot on an empty body returns an empty snapshot');
assertEq(extractSnapshot(null), {}, 'extractSnapshot tolerates a null body');
assertEq(
  extractSnapshot({ heartRate: 58, steps: 100, spo2: 97, sleepHours: 7.2, stress: 34, battery: 81 }),
  { heartRate: 58, steps: 100, spo2: 97, sleepHours: 7.2, stress: 34, battery: 81 },
  'extractSnapshot accepts all six ring fields (heartRate/steps/spo2/sleepHours/stress/battery)'
);

// ---- buildNextState: fresh state (no existing row) ----
{
  const next = buildNextState(null, { steps: 4200, heartRate: 62 }, '2026-08-10');
  assertEq(next.latest.steps, 4200, 'buildNextState (fresh): latest.steps set correctly');
  assertEq(next.latest.heartRate, 62, 'buildNextState (fresh): latest.heartRate set correctly');
  assertEq(next.latest.date, '2026-08-10', 'buildNextState (fresh): latest.date set correctly');
  assertTrue(typeof next.latest.receivedAt === 'string', 'buildNextState (fresh): latest.receivedAt is set');
  assertEq(next.history['2026-08-10'], { steps: 4200, heartRate: 62 }, 'buildNextState (fresh): history entry created for the date');
}

// ---- buildNextState: merging a later-in-the-day field (e.g. sleep only known once you wake up, stress accumulating through the day) ----
{
  const existing = { history: { '2026-08-10': { steps: 4200, heartRate: 62 } } };
  const next = buildNextState(existing, { sleepHours: 7.2, stress: 28 }, '2026-08-10');
  assertEq(next.history['2026-08-10'], { steps: 4200, heartRate: 62, sleepHours: 7.2, stress: 28 },
    'buildNextState merges a same-day update into the existing entry instead of overwriting sibling fields');
  assertEq(next.latest, { steps: 4200, heartRate: 62, sleepHours: 7.2, stress: 28, date: '2026-08-10', receivedAt: next.latest.receivedAt },
    'buildNextState: "latest" is the FULL accumulated merge for the day — a stress-only POST should not make steps/heartRate vanish from the card');
}

// ---- buildNextState: re-syncing the same field on the SAME day (e.g. a live heart-rate reading every poll) updates in place ----
{
  const existing = { history: { '2026-08-10': { heartRate: 62 } } };
  const next = buildNextState(existing, { heartRate: 71 }, '2026-08-10');
  assertEq(next.history['2026-08-10'], { heartRate: 71 }, 'buildNextState: re-syncing the same field for the same day overwrites the old value with the latest reading');
}

// ---- buildNextState: a different day gets its own separate entry ----
{
  const existing = { history: { '2026-08-09': { steps: 6100 } } };
  const next = buildNextState(existing, { steps: 4200 }, '2026-08-10');
  assertEq(next.history['2026-08-09'], { steps: 6100 }, 'buildNextState: existing days are preserved untouched');
  assertEq(next.history['2026-08-10'], { steps: 4200 }, 'buildNextState: a new day gets its own entry');
}

// ---- buildNextState: pruning to the most recent 60 days ----
{
  const history = {};
  for (let i = 0; i < 65; i++) {
    const d = new Date(2026, 0, 1 + i);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    history[key] = { steps: i };
  }
  const next = buildNextState({ history }, { steps: 9999 }, '2026-03-08');
  const keys = Object.keys(next.history);
  assertTrue(keys.length <= 60, 'buildNextState prunes history to at most 60 days, got ' + keys.length);
  assertTrue(!('2026-01-01' in next.history), 'buildNextState: oldest days are the ones pruned away');
}

// ---- buildNextState: a backfill POST (e.g. the Mac was asleep, catching up on an older sync) does not clobber "latest" ----
{
  const existing = { history: { '2026-08-10': { steps: 9000, heartRate: 64 } } };
  const next = buildNextState(existing, { steps: 4000 }, '2026-08-08');
  assertEq(next.latest.date, '2026-08-10', 'buildNextState: "latest" still points at the most recent day, not the backfilled day');
  assertEq(next.latest.steps, 9000, 'buildNextState: "latest" values come from the most recent day, unaffected by an older backfill');
  assertEq(next.history['2026-08-08'], { steps: 4000 }, 'buildNextState: the backfilled day is still recorded correctly in history');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
