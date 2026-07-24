// Standalone verification of skills.html's Skill Stack Tracker logic
// (hour-based mastery staging + per-skill session aggregation). skills.html
// has no module exports (browser-global IIFE), so this duplicates the exact
// functions to test them in isolation — same approach as this repo's other
// embedded-HTML pure-logic test files.

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

const STAGE_THRESHOLDS = [
  { stage: 'novice', minHours: 0, label: 'Novice' },
  { stage: 'beginner', minHours: 10, label: 'Beginner' },
  { stage: 'intermediate', minHours: 50, label: 'Intermediate' },
  { stage: 'advanced', minHours: 200, label: 'Advanced' },
  { stage: 'expert', minHours: 1000, label: 'Expert' },
];

function stageForHours(hours) {
  let result = STAGE_THRESHOLDS[0];
  for (const t of STAGE_THRESHOLDS) {
    if (hours >= t.minHours) result = t;
  }
  return result;
}

function progressToNextStage(hours) {
  const idx = STAGE_THRESHOLDS.findIndex(t => t.stage === stageForHours(hours).stage);
  const next = STAGE_THRESHOLDS[idx + 1];
  if (!next) return null;
  const cur = STAGE_THRESHOLDS[idx];
  return Math.max(0, Math.min(1, (hours - cur.minHours) / (next.minHours - cur.minHours)));
}

function buildSkillSummaries(defs, sessions) {
  return (defs || []).map(def => {
    const own = (sessions || []).filter(s => s.skillId === def.id);
    const totalMinutes = own.reduce((a, s) => a + (s.minutes || 0), 0);
    const totalHours = totalMinutes / 60;
    const lastPracticedTs = own.length ? Math.max(...own.map(s => s.ts || 0)) : null;
    return {
      id: def.id,
      name: def.name,
      category: def.category || '',
      totalHours,
      sessionCount: own.length,
      lastPracticedTs,
      stage: stageForHours(totalHours),
      progress: progressToNextStage(totalHours),
    };
  }).sort((a, b) => (b.lastPracticedTs || 0) - (a.lastPracticedTs || 0));
}

// ==================== stageForHours ====================
{
  assertEq(stageForHours(0).stage, 'novice', 'zero hours is Novice');
  assertEq(stageForHours(9.9).stage, 'novice', 'just under the 10h boundary is still Novice');
  assertEq(stageForHours(10).stage, 'beginner', 'exactly 10h is Beginner (boundary is inclusive)');
  assertEq(stageForHours(49).stage, 'beginner', 'just under 50h is still Beginner');
  assertEq(stageForHours(50).stage, 'intermediate', 'exactly 50h is Intermediate');
  assertEq(stageForHours(200).stage, 'advanced', 'exactly 200h is Advanced');
  assertEq(stageForHours(1000).stage, 'expert', 'exactly 1000h is Expert');
  assertEq(stageForHours(5000).stage, 'expert', 'well beyond 1000h is still Expert, not out of range');
}

// ==================== progressToNextStage ====================
{
  assertClose(progressToNextStage(0), 0, 'zero hours is 0% of the way to Beginner');
  assertClose(progressToNextStage(5), 0.5, '5 of 10 hours is 50% of the way to Beginner');
  assertClose(progressToNextStage(30), 0.5, '30 hours is 50% of the way from Beginner(10) to Intermediate(50)');
  assertEq(progressToNextStage(1000), null, 'the top stage (Expert) has no next stage, so progress is null');
  assertEq(progressToNextStage(5000), null, 'well beyond the top stage still returns null, not a value over 1');
}

// ==================== buildSkillSummaries ====================
{
  const defs = [
    { id: 's1', name: 'Guitar', category: 'Music' },
    { id: 's2', name: 'Spanish' },
    { id: 's3', name: 'Chess' }, // never practiced
  ];
  const sessions = [
    { skillId: 's1', ts: 1000, minutes: 60 },
    { skillId: 's1', ts: 3000, minutes: 30 }, // most recent for s1
    { skillId: 's2', ts: 2000, minutes: 600 }, // 10 hours exactly
  ];
  const summaries = buildSkillSummaries(defs, sessions);

  const guitar = summaries.find(s => s.id === 's1');
  assertClose(guitar.totalHours, 1.5, "Guitar's total hours sum all its sessions' minutes / 60");
  assertEq(guitar.sessionCount, 2, 'Guitar has 2 logged sessions');
  assertEq(guitar.lastPracticedTs, 3000, "Guitar's lastPracticedTs is the MOST RECENT session, not the first");
  assertEq(guitar.stage.stage, 'novice', '1.5 hours is still Novice');
  assertEq(guitar.category, 'Music', "a skill's category is carried through");

  const spanish = summaries.find(s => s.id === 's2');
  assertEq(spanish.stage.stage, 'beginner', 'exactly 10 hours crosses into Beginner');

  const chess = summaries.find(s => s.id === 's3');
  assertEq(chess.totalHours, 0, 'a skill with zero logged sessions has 0 total hours, not a crash');
  assertEq(chess.sessionCount, 0, 'a never-practiced skill has a session count of 0');
  assertEq(chess.lastPracticedTs, null, 'a never-practiced skill has a null lastPracticedTs, not 0 (0 would look like "just now" in epoch terms)');
  assertEq(chess.category, '', 'a skill with no category defaults to an empty string, not undefined');

  // Sort order: most recently practiced first, never-practiced last.
  assertEq(summaries.map(s => s.id), ['s1', 's2', 's3'], 'summaries are sorted by lastPracticedTs descending, with never-practiced skills sorted last');

  assertEq(buildSkillSummaries([], []), [], 'no skill defs at all returns an empty list, not an error');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
