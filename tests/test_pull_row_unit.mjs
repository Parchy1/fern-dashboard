// Directly evals the REAL CONFIG + normalize()/buildDefaultExercises() source
// straight out of gym.html (same extraction approach as
// test_core_expansion_unit.mjs) so this tests the exact
// pull_barbell_row_2026_08 migration logic that ships, not a
// reimplementation of it.
//
// Context: researched a 5-day PPL/Upper/Lower split — Push (bench press),
// Legs (back squat), and Lower (deadlift) all already had a true
// heavy-compound opener in the 5-8 rep range, but Pull's heaviest movement
// was a machine (Lat pulldown, 6-10 reps). A barbell row fills that gap the
// same way those days' compounds do — this patch adds it for every user,
// new and returning, without disturbing anything else.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function extractBlock(src, marker) {
  const markerIdx = src.indexOf(marker);
  if (markerIdx < 0) throw new Error('marker not found in gym.html: ' + marker);
  const braceIdx = src.indexOf('{', markerIdx);
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(markerIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting: ' + marker);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gymSrc = fs.readFileSync(path.join(__dirname, '..', 'gym.html'), 'utf8');

const configSrc = extractBlock(gymSrc, 'const CONFIG = ') + ';';
const buildDefaultExercisesSrc = extractBlock(gymSrc, 'function buildDefaultExercises() ');
const exerciseLogKeySrc = extractBlock(gymSrc, 'function exerciseLogKey(ex) ');
const normalizeSrc = extractBlock(gymSrc, 'function normalize(s) ');
const configVersionMatch = /const CONFIG_VERSION = (\d+);/.exec(gymSrc);
if (!configVersionMatch) throw new Error('CONFIG_VERSION not found in gym.html');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  configSrc + '\n' +
  'const CONFIG_VERSION = ' + configVersionMatch[1] + ';\n' +
  buildDefaultExercisesSrc + '\n' +
  exerciseLogKeySrc + '\n' +
  normalizeSrc + '\n' +
  'this.__normalize = normalize; this.__CONFIG = CONFIG; this.__CONFIG_VERSION = CONFIG_VERSION; this.__buildDefaultExercises = buildDefaultExercises; this.__exerciseLogKey = exerciseLogKey;',
  sandbox
);
const { __normalize: normalize, __CONFIG: CONFIG, __CONFIG_VERSION: CONFIG_VERSION, __buildDefaultExercises: buildDefaultExercises, __exerciseLogKey: exerciseLogKey } = sandbox;

// ==================== research grounding: every split day now has a true heavy compound ====================
{
  const s = normalize({});
  const HEAVY_COMPOUNDS = {
    push: 'Barbell bench press',
    pull: 'Barbell row',
    legs: 'Back squat',
    lower: 'Deadlift',
  };
  Object.keys(HEAVY_COMPOUNDS).forEach(day => {
    const ex = s.exercises.find(e => e.name === HEAVY_COMPOUNDS[day] && e.day === day);
    assertTrue(!!ex, day + ' has a heavy-compound opener (' + HEAVY_COMPOUNDS[day] + ')');
    assertTrue(ex.repMax <= 8, day + '\'s heavy compound uses a true strength rep range (top of range <= 8): ' + JSON.stringify(ex));
  });
}

// ---- Scenario 1: brand-new user (empty state) ----
{
  const s = normalize({});
  const matches = s.exercises.filter(e => e.name === 'Barbell row' && e.day === 'pull');
  assertEq(matches.length, 1, 'fresh install: exactly one "Barbell row" on pull (default seed + patch don\'t double up)');
  assertTrue(s.patchesApplied.indexOf('pull_barbell_row_2026_08') !== -1, 'fresh install: pull_barbell_row patch pre-marked as applied');
}

// ---- Scenario 2: existing user, already configVersion current, predates this patch ----
{
  const priorExercises = buildDefaultExercises().filter(e => e.name !== 'Barbell row');
  const benchPress = priorExercises.find(e => e.name === 'Barbell bench press');
  const priorState = {
    configVersion: CONFIG_VERSION,
    days: CONFIG.days.slice(),
    exercises: priorExercises,
    logs: { [benchPress.id]: [{ weight: 82.5, reps: 6, ts: 1752600000000 }] },
    gyms: CONFIG.gyms.slice(),
    patchesApplied: ['ab_crunch_machine_2026_07', 'core_expansion_2026_08'],
  };
  const s = normalize(JSON.parse(JSON.stringify(priorState)));
  const matches = s.exercises.filter(e => e.name === 'Barbell row' && e.day === 'pull');
  assertEq(matches.length, 1, 'existing pre-patch user: patch adds exactly one "Barbell row" on pull');

  const bench = s.exercises.find(e => e.name === 'Barbell bench press');
  assertTrue(!!bench, 'existing exercises (Barbell bench press) untouched by the patch');
  assertEq(s.logs[exerciseLogKey(bench)], [{ weight: 82.5, reps: 6, ts: 1752600000000 }], 'previously logged history is untouched by an unrelated patch');

  // ---- Scenario 2b: normalize again on the already-patched state -> idempotent ----
  const s2 = normalize(JSON.parse(JSON.stringify(s)));
  const matches2 = s2.exercises.filter(e => e.name === 'Barbell row' && e.day === 'pull');
  assertEq(matches2.length, 1, 'running normalize() again does not duplicate Barbell row');

  // ---- Scenario 2c: user deletes it on purpose -> must not silently come back ----
  const afterDelete = JSON.parse(JSON.stringify(s2));
  afterDelete.exercises = afterDelete.exercises.filter(e => e.name !== 'Barbell row');
  const s3 = normalize(afterDelete);
  const barbellRow = s3.exercises.filter(e => e.name === 'Barbell row');
  assertEq(barbellRow.length, 0, 'deleting the patched Barbell row on purpose sticks across a subsequent normalize() call');
}

// ---- Scenario 3: fields on the new exercise are correct ----
{
  const s = normalize({});
  const row = s.exercises.find(e => e.name === 'Barbell row');
  assertTrue(!!row, 'Barbell row exists in a fresh install');
  assertEq(row.gym, 'comm', 'Barbell row uses gym:"comm", matching every other default exercise');
  assertEq(row.day, 'pull', 'Barbell row is tagged to the pull day');
  assertEq([row.repMin, row.repMax], [5, 8], 'Barbell row uses a heavy-compound rep range (5-8), matching bench press/squat/deadlift');
}

// ---- Scenario 4: a stale configVersion user goes through the full reset path, still ends up with exactly one (not two) ----
{
  const staleState = { configVersion: 1, days: [{ id: 'push', name: 'Push' }], exercises: [{ id: 'old1', name: 'Old thing', gym: 'comm', day: 'push' }], logs: {} };
  const s = normalize(staleState);
  const matches = s.exercises.filter(e => e.name === 'Barbell row' && e.day === 'pull');
  assertEq(matches.length, 1, 'a full CONFIG_VERSION reset (old stale state) also ends up with exactly one Barbell row, not two');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
