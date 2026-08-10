import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Covers the "This Week: AI Est. vs. Real Source" rollup added to the
// nutrition tracker in health.html: a 7-day (today included) split of
// logged calories between genuinely AI-estimated sources (photo/describe/
// receipt) and real sources (barcode/label/manual, or a legacy entry with
// no source tag), reusing the exact classification already established for
// the Today list's "AI est." badge.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '- expected', e, 'got', a); }
}

// Extracts a top-level `function name(...) { ... }` body via brace-counting,
// same helper as test_nutrition_tracker.mjs, so a dynamically-executed check
// doesn't rely on a brittle regex matching the exact current formatting.
function extractFunction(src, name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const health = read('health.html');

// ============================== Markup ==============================
assertTrue(health.includes('This Week: AI Est. vs. Real Source'), 'a weekly source-mix card exists in the Nutrition section');
assertTrue(
  health.includes('id="calSourceMixBar"') && health.includes('id="calSourceMixAiSeg"') && health.includes('id="calSourceMixRealSeg"'),
  'the mix renders as a two-segment stacked bar, not just numbers'
);
assertTrue(
  health.includes('id="calSourceMixAiPct"') && health.includes('id="calSourceMixRealPct"') && health.includes('id="calSourceMixLegend"'),
  'a legend shows the AI-estimated and real-source percentages as text, not just color'
);
assertTrue(health.includes('id="calSourceMixEmpty"'), 'an empty state exists for a week with no logged meals');

// ============================== Wiring ==============================
assertTrue(health.includes('function renderSourceMix'), 'a dedicated render function computes and paints the weekly mix');
assertTrue(health.includes('function renderAll() { renderSummary(); renderTodayList(); renderChart(); renderSourceMix(); }'), 'renderSourceMix runs on every renderAll(), same as the other nutrition widgets, so new/edited/deleted entries keep it live');
assertTrue(/getDate\(\) - 6/.test(health), 'the window spans the last 7 calendar days (today included), not just today');
assertTrue(
  /e\.source === 'photo' \|\| e\.source === 'describe' \|\| e\.source === 'receipt'\) aiCal \+= cals;\s*else realCal \+= cals;/.test(health),
  'the weekly mix classifies photo/describe/receipt as AI-estimated and everything else (barcode/label/manual/untagged) as real, matching the Today list badge convention exactly'
);

// ============================== Pure arithmetic (computeSourceMix) ==============================
const fnSrc = extractFunction(health, 'computeSourceMix');
assertTrue(!!fnSrc, 'computeSourceMix is extractable as a standalone function body for direct execution');
if (fnSrc) {
  const compute = new Function('list', fnSrc + '; return computeSourceMix(list);');

  assertEqual(compute([]), { aiCal: 0, realCal: 0, aiPct: 0, realPct: 0 }, 'an empty week yields all-zero output rather than NaN from a 0/0 division');

  const allAi = compute([
    { source: 'photo', calories: 300 },
    { source: 'describe', calories: 200 },
    { source: 'receipt', calories: 100 },
  ]);
  assertEqual(allAi.aiCal, 600, 'photo/describe/receipt calories all land in the AI bucket');
  assertEqual(allAi.realCal, 0, 'no real-source calories are counted when every entry is AI-estimated');
  assertEqual(allAi.aiPct, 100, 'an all-AI week reports 100% AI-estimated');
  assertEqual(allAi.realPct, 0, 'an all-AI week reports 0% real source');

  const allReal = compute([
    { source: 'barcode', calories: 400 },
    { source: 'label', calories: 150 },
    { source: 'manual', calories: 250 },
  ]);
  assertEqual(allReal.realCal, 800, 'barcode/label/manual calories all land in the real bucket');
  assertEqual(allReal.aiPct, 0, 'an all-real week reports 0% AI-estimated');
  assertEqual(allReal.realPct, 100, 'an all-real week reports 100% real source');

  const untagged = compute([{ calories: 500 }]);
  assertEqual(untagged.realPct, 100, 'a legacy entry with no source field is treated as real, not flagged as an AI estimate it never claimed to be');

  // 300 AI / 700 real -> 30% / 70%, exercising a non-trivial rounding case.
  const mixed = compute([
    { source: 'photo', calories: 300 },
    { source: 'manual', calories: 700 },
  ]);
  assertEqual(mixed.aiPct, 30, 'a mixed week computes the correct AI-estimated percentage');
  assertEqual(mixed.realPct, 70, 'a mixed week computes the correct real-source percentage, complementary to the AI percentage');
  assertEqual(mixed.aiPct + mixed.realPct, 100, 'the two percentages always sum to 100 (no rounding gap or overlap)');

  // Entries with a non-numeric/missing calories field don't poison the sum.
  const withJunk = compute([{ source: 'photo', calories: 'not-a-number' }, { source: 'manual', calories: 100 }]);
  assertEqual(withJunk.aiCal, 0, 'a non-numeric calories value contributes 0, not NaN');
  assertEqual(withJunk.realPct, 100, 'the rest of the week still computes correctly despite one malformed entry');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
