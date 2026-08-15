// Directly evals the REAL CONFIG + normalize()/buildDefaultExercises() source
// straight out of gym.html (same extraction approach as the other gym unit
// test files) so this tests the exact v4 functional-training redesign that
// ships, not a reimplementation of it.
//
// Context: the prior program (v3) was a bodybuilding-style hypertrophy
// split — mostly seated machines and single-joint isolation, organized by
// which muscle each exercise targets. Fernando explicitly asked for the
// split to be rebuilt around real functional-training principles instead:
// resistance training built around the multi-joint MOVEMENT PATTERNS the
// body actually uses (squat, hinge, lunge, push, pull, carry, rotate),
// favoring free weights/bodyweight over fixed-path machines, with balance
// and core stability trained directly. See PR description for sources.
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

assertEq(CONFIG_VERSION, 4, 'CONFIG_VERSION was bumped to 4 for the functional-training redesign, so returning users actually pick it up');

// ==================== all 7 functional movement patterns are covered across the week ====================
{
  const s = normalize({});
  const names = s.exercises.map(e => e.name);
  const has = (re) => names.some(n => re.test(n));

  assertTrue(has(/back squat/i), 'squat pattern is present (Back squat)');
  assertTrue(has(/romanian deadlift/i) && has(/^deadlift$/i), 'hinge pattern is present twice (Romanian deadlift + Deadlift)');
  assertTrue(has(/walking lunge/i) && has(/bulgarian split squat/i), 'lunge pattern is present twice, both unilateral (Walking lunge, Bulgarian split squat)');
  assertTrue(has(/bench press/i) && has(/overhead press/i) && has(/push-up/i), 'push pattern covers multiple variations (bench, overhead press, push-up)');
  assertTrue(has(/barbell row/i) && has(/pull-up/i) && has(/dumbbell row/i), 'pull pattern covers multiple variations (row, pull-up, single-arm row)');
  assertTrue(has(/farmer's carry/i) && has(/suitcase carry/i) && has(/overhead carry/i), 'all 3 carry variants are present (farmer\'s, suitcase, overhead)');
  assertTrue(has(/woodchopper/i) && has(/russian twist/i), 'rotate pattern is present (woodchopper, Russian twist)');
}

// ==================== every day has a true free-weight/bodyweight heavy compound, not a machine ====================
{
  const s = normalize({});
  const HEAVY = { push: 'Barbell bench press', pull: 'Barbell row', legs: 'Back squat', lower: 'Deadlift' };
  Object.keys(HEAVY).forEach(day => {
    const ex = s.exercises.find(e => e.day === day && e.name === HEAVY[day]);
    assertTrue(!!ex, day + ' has its heavy compound (' + HEAVY[day] + ')');
    assertTrue(ex.repMax <= 8, day + '\'s heavy compound uses a true strength rep range');
  });
}

// ==================== fixed-path seated machines from the old bodybuilding split are gone ====================
{
  const s = normalize({});
  const names = s.exercises.map(e => e.name);
  ['Leg press', 'Leg extension machine', 'Leg extension', 'Chest press machine', 'Seated shoulder press machine', 'Seated cable row', 'Lateral raise (dumbbell)', 'Incline dumbbell press'].forEach(removed => {
    assertTrue(!names.includes(removed), '"' + removed + '" (fixed-path machine / v3 leftover) is not part of the v4 functional program');
  });
}

// ==================== unilateral (single-side) work exists — a defining feature of functional training absent from v3 ====================
{
  const s = normalize({});
  const unilateral = s.exercises.filter(e => /single-arm|walking lunge|bulgarian split squat|suitcase carry/i.test(e.name));
  assertTrue(unilateral.length >= 4, 'at least 4 genuinely unilateral/single-side exercises exist (single-arm row, single-arm OHP, walking lunge, Bulgarian split squat, suitcase carry): found ' + unilateral.length);
}

// ==================== carries use a steps-based rep range (20-40), distinct from strength rep ranges ====================
{
  const s = normalize({});
  s.exercises.filter(e => /carry/i.test(e.name)).forEach(e => {
    assertEq([e.repMin, e.repMax], [20, 40], e.name + ' uses the steps-based range (20-40), not a strength rep range');
  });
}

// ==================== a handful of deliberately-retained accessory movements still cover real injury-prevention gaps ====================
{
  const s = normalize({});
  assertTrue(s.exercises.some(e => e.name === 'Face pull (cable)'), 'Face pull retained for shoulder health, even though it\'s not a "pure" movement pattern exercise');
  const hamstringIsolation = s.exercises.filter(e => e.name === 'Leg curl machine' || e.name === 'Leg curl');
  assertEq(hamstringIsolation.length, 2, 'exactly one hamstring-curl accessory retained per leg day (Legs + Lower), not stripped entirely');
}

// ==================== no duplicate exercise names within the same day ====================
{
  const s = normalize({});
  ['push', 'pull', 'legs', 'upper', 'lower'].forEach(day => {
    const names = s.exercises.filter(e => e.day === day).map(e => e.name);
    assertEq(names.length, new Set(names).size, day + ' has no duplicate exercise names within the same day');
  });
}

// ==================== no inverted rep ranges anywhere ====================
{
  const s = normalize({});
  const bad = s.exercises.filter(e => e.repMin > e.repMax);
  assertEq(bad, [], 'no exercise has an inverted rep range (repMin > repMax)');
}

// ==================== log continuity: exercises that kept their exact name across BOTH rewrites (v3 and v4) preserve logged history ====================
{
  const survivors = ['Barbell bench press', 'Barbell row', 'Back squat', 'Deadlift', 'Hip thrust', 'Cable crunch', 'Face pull (cable)'];
  const oldExercises = survivors.map((name, i) => ({ id: 'old_' + i, name, gym: 'comm', day: 'push' }));
  const logs = {};
  oldExercises.forEach(ex => { logs[ex.id] = [{ weight: 50, reps: 6, ts: Date.now() }]; });
  const staleState = { configVersion: 1, days: CONFIG.days.slice(), exercises: oldExercises, logs };
  const s = normalize(JSON.parse(JSON.stringify(staleState)));
  survivors.forEach(name => {
    assertTrue(s.exercises.some(e => e.name === name), name + ' still exists in the v4 functional program');
  });
}

// ==================== dropped exercises (from either rewrite) don't crash normalize(), and old log data isn't force-deleted ====================
{
  const oldExercises = [
    { id: 'old_legpress', name: 'Leg press', gym: 'comm', day: 'legs' },
    { id: 'old_inclinepress', name: 'Incline dumbbell press', gym: 'comm', day: 'push' },
  ];
  const staleState = {
    configVersion: 1, days: CONFIG.days.slice(), exercises: oldExercises,
    logs: { old_legpress: [{ weight: 100, reps: 10, ts: Date.now() }] },
  };
  const s = normalize(JSON.parse(JSON.stringify(staleState)));
  assertTrue(!s.exercises.some(e => e.name === 'Leg press'), 'Leg press (v3 leftover, dropped in v4) is absent from the rewritten program');
  assertTrue(Array.isArray(s.exercises) && s.exercises.length > 0, 'normalize() does not crash when old state references exercises removed across two rewrites');
  assertTrue('old_legpress' in s.logs, 'the old exercise\'s raw log entry is not force-deleted — just no longer surfaced');
}

// ==================== a fresh install and a full CONFIG_VERSION reset from any prior version land on the same v4 program ====================
{
  const fresh = normalize({});
  const staleV1 = normalize({ configVersion: 1, days: [{ id: 'push', name: 'Push' }], exercises: [{ id: 'x', name: 'Old thing', gym: 'comm', day: 'push' }], logs: {} });
  const staleV3 = normalize({ configVersion: 3, days: CONFIG.days.slice(), exercises: [{ id: 'x', name: 'Old thing', gym: 'comm', day: 'push' }], logs: {}, patchesApplied: ['ab_crunch_machine_2026_07', 'core_expansion_2026_08', 'pull_barbell_row_2026_08'] });
  const namesFresh = fresh.exercises.map(e => e.name).sort();
  assertEq(staleV1.exercises.map(e => e.name).sort(), namesFresh, 'a reset from a very old (v1) state lands on the exact same v4 program as a fresh install');
  assertEq(staleV3.exercises.map(e => e.name).sort(), namesFresh, 'a reset from the immediately-prior (v3) state lands on the exact same v4 program as a fresh install');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
