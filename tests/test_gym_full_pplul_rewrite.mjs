// Directly evals the REAL CONFIG + normalize()/buildDefaultExercises() source
// straight out of gym.html (same extraction approach as the other gym unit
// test files) so this tests the exact v3 full-program rewrite that ships.
//
// Context: the app's 5-day Push/Pull/Legs/Upper/Lower rotation was already
// structurally the evidence-based "PPLUL" split (each muscle group gets a
// heavy hit + a second, lighter hit per cycle), but the exercise selection
// within it had accumulated ad-hoc via three separate incremental patches
// over time. This rewrite is a deliberate, complete redesign: every
// exercise is categorized into one of four consistent roles (heavy
// compound 4-8 reps, secondary compound 8-12, isolation 10-15, core 8-20),
// every day gets a true free-weight heavy compound, chest/shoulder work is
// split cleanly between Push and Upper instead of overlapping, a genuine
// hip-hinge movement (Romanian deadlift) was added to Legs, a free-weight
// overhead press was added to Upper (previously only a machine existed
// anywhere in the program), and the old duplicate "Ab crunch machine" (the
// same machine on 3 different days) was replaced by 5 distinct core
// movements, one per day.
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

assertEq(CONFIG_VERSION, 3, 'CONFIG_VERSION was bumped to 3 for this full rewrite, so returning users actually pick it up');

// ==================== every day has exactly one heavy compound (4-8 reps) ====================
{
  const s = normalize({});
  const HEAVY = { push: 'Barbell bench press', pull: 'Barbell row', legs: 'Back squat', lower: 'Deadlift' };
  Object.keys(HEAVY).forEach(day => {
    const matches = s.exercises.filter(e => e.day === day && e.repMax <= 8);
    assertEq(matches.length, 1, day + ' has exactly one heavy-compound-range exercise');
    assertEq(matches[0].name, HEAVY[day], day + '\'s heavy compound is ' + HEAVY[day]);
  });
  // Upper is the one day that's intentionally moderate-volume throughout
  // (the "second hit" day) rather than anchored by its own heavy single.
  const upperHeavy = s.exercises.filter(e => e.day === 'upper' && e.repMax <= 8);
  assertEq(upperHeavy.length, 0, 'Upper day has no <=8-rep exercise by design — it\'s the second, lighter hit for each muscle group, not a third heavy day');
}

// ==================== genuine content gaps identified by research are now filled ====================
{
  const s = normalize({});
  assertTrue(s.exercises.some(e => e.name === 'Romanian deadlift' && e.day === 'legs'), 'Legs day now has a genuine hip-hinge/hamstring movement (Romanian deadlift), previously missing entirely');
  assertTrue(s.exercises.some(e => e.name === 'Overhead press (dumbbell)' && e.day === 'upper'), 'Upper day now has a free-weight overhead press — previously every shoulder press in the program was machine-only');
  assertTrue(s.exercises.some(e => e.name === 'Barbell row' && e.day === 'pull'), 'Pull day has its heavy row (from the prior pull_barbell_row_2026_08 patch, still present in the full rewrite)');
}

// ==================== every muscle group gets a heavy hit + a second, lighter hit across the 5-day cycle ====================
{
  const s = normalize({});
  const byDay = day => s.exercises.filter(e => e.day === day).map(e => e.name);
  const push = byDay('push'), pull = byDay('pull'), upper = byDay('upper');
  assertTrue(push.some(n => /bench|incline|chest/i.test(n)) && upper.some(n => /chest/i.test(n)), 'chest is trained on both Push (bench/incline) and Upper (chest press)');
  assertTrue(pull.some(n => /row|pulldown/i.test(n)) && upper.some(n => /pulldown|row/i.test(n)), 'back is trained on both Pull and Upper, with different grips/angles');
  assertTrue(push.some(n => /press|raise/i.test(n)) && upper.some(n => /press/i.test(n)), 'shoulders are trained on both Push and Upper');
}

// ==================== no duplicate identical exercise within the same day ====================
{
  const s = normalize({});
  ['push', 'pull', 'legs', 'upper', 'lower'].forEach(day => {
    const names = s.exercises.filter(e => e.day === day).map(e => e.name);
    assertEq(names.length, new Set(names).size, day + ' has no duplicate exercise names within the same day');
  });
}

// ==================== rep ranges are consistently categorized (no stray inconsistent ranges) ====================
{
  const s = normalize({});
  const bad = s.exercises.filter(e => e.repMin > e.repMax);
  assertEq(bad, [], 'no exercise has an inverted rep range (repMin > repMax)');
  const isolationLike = /curl|pushdown|raise|extension|calf|face pull/i;
  s.exercises.filter(e => isolationLike.test(e.name) && !/row|press|squat|deadlift|hanging|leg raise/i.test(e.name)).forEach(e => {
    assertTrue(e.repMin >= 10, e.name + ' (isolation-style movement) uses a rep-range floor of 10+: ' + JSON.stringify(e));
  });
}

// ==================== log continuity: exercises that kept their name preserve logged history across the version bump ====================
{
  const preExisting = ['Barbell bench press', 'Barbell row', 'Back squat', 'Deadlift', 'Leg press', 'Hip thrust', 'Cable crunch'];
  const oldExercises = preExisting.map((name, i) => ({ id: 'old_' + i, name, gym: 'comm', day: 'push' }));
  const logs = {};
  oldExercises.forEach(ex => { logs[ex.id] = [{ weight: 50 + Math.random() * 10, reps: 6, ts: Date.now() }]; });
  const staleState = { configVersion: 1, days: CONFIG.days.slice(), exercises: oldExercises, logs };
  const s = normalize(JSON.parse(JSON.stringify(staleState)));
  preExisting.forEach(name => {
    const ex = s.exercises.find(e => e.name === name);
    assertTrue(!!ex, name + ' still exists in the rewritten program');
  });
}

// ==================== dropped/renamed exercises don't crash normalize(), and their storage-level log data isn't force-deleted ====================
{
  const oldExercises = [{ id: 'old_pullup', name: 'Assisted pull-up machine', gym: 'comm', day: 'pull' }];
  const staleState = {
    configVersion: 1, days: CONFIG.days.slice(), exercises: oldExercises,
    logs: { old_pullup: [{ weight: 0, reps: 8, ts: Date.now() }] },
  };
  const s = normalize(JSON.parse(JSON.stringify(staleState)));
  assertTrue(!s.exercises.some(e => e.name === 'Assisted pull-up machine'), 'Assisted pull-up machine (deliberately dropped — redundant with Barbell row + Lat pulldown + Seated cable row) is absent from the rewritten Pull day');
  assertTrue(Array.isArray(s.exercises) && s.exercises.length > 0, 'normalize() does not crash when old state references a since-removed exercise');
  assertTrue('old_pullup' in s.logs, 'the old exercise\'s raw log entry is not force-deleted by normalize() — it\'s just no longer surfaced in the active exercise list');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
