import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Covers the four architecture-preserving nutrition-tracker features added
// on top of the existing Photo/Describe/Manual calorie logger in
// health.html: barcode scanning (ZXing + Open Food Facts), label/receipt
// photo scanning (new system prompts reusing the existing Claude Vision
// call), an "AI est." honesty badge on genuinely-estimated entries, and a
// deterministic Mifflin-St Jeor BMR/TDEE goal suggestion sourced from the
// profile data the dashboard already collects. No new storage keys, no new
// build step, no new framework — see the PR description for why each of
// these stayed inside the existing static-HTML/localStorage architecture.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertEqual(actual, expected, label) {
  if (actual === expected) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '- expected', expected, 'got', actual); }
}

// Extracts a top-level `function name(...) { ... }` body via brace-counting
// so a dynamically-executed check doesn't rely on a brittle regex matching
// the exact current formatting of the surrounding code.
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

// ============================== Barcode scanning ==============================
assertTrue(health.includes('data-mode="barcode"'), 'a 4th Barcode mode tab exists alongside Photo/Describe/Manual');
assertTrue(health.includes('id="calBarcodeMode"') && health.includes('id="calBarcodeVideo"') && health.includes('id="calBarcodeStartBtn"'), 'the Barcode tab has a start button and a video element for the live scan');
assertTrue(health.includes("unpkg.com/@zxing/library"), 'the barcode decoder loads the ZXing library from CDN, matching the existing dynamic-script-load pattern used for jarvis-globe.js');
assertTrue(health.includes('function loadZXing') && health.includes('if (window.ZXing) return Promise.resolve(window.ZXing)'), 'ZXing is loaded lazily and only once, not re-fetched on every scan');
assertTrue(health.includes('function stopBarcodeScan') && health.includes("tab.dataset.mode !== 'barcode') stopBarcodeScan()"), 'switching away from the Barcode tab stops the camera instead of leaving it running in the background');
assertTrue(health.includes('world.openfoodfacts.org/api/v2/product/'), 'barcode lookups hit Open Food Facts, a free database with no API key, not a paid/AI lookup');
assertTrue(health.includes('function extractBarcodeItem'), 'a real product lookup is converted into a calorie/macro item, not fabricated');
assertTrue(health.includes("json.status !== 1 || !json.product") && health.includes('try Manual entry'), 'a barcode with no database match tells the user honestly and points at Manual entry, rather than guessing nutrition for an unidentified product');
assertTrue(health.includes("pendingSource = 'barcode'"), 'items resolved via barcode are tagged with their real source');

// ============================== Label / receipt scanning ==============================
assertTrue(health.includes('class="cal-photo-kind-row"'), 'the Photo tab has a Meal/Label/Receipt sub-selector instead of tripling the camera-capture UI');
assertTrue(health.includes('data-kind="photo"') && health.includes('data-kind="label"') && health.includes('data-kind="receipt"'), 'all three photo kinds (Meal, Label, Receipt) are selectable');
assertTrue(health.includes('const LABEL_SYS'), 'a dedicated system prompt exists for reading nutrition labels');
assertTrue(/LABEL_SYS[\s\S]{0,400}reading, not estimating/.test(health), 'the label prompt frames the task as transcription, not visual guessing');
assertTrue(/LABEL_SYS[\s\S]{0,600}(refuses to guess|0[\s\S]{0,60}note|unreadable)/i.test(health), 'the label prompt is told to report 0 + a note for unreadable/missing values rather than inventing a plausible-looking number');
assertTrue(health.includes('const RECEIPT_SYS'), 'a dedicated system prompt exists for reading receipts');
assertTrue(/RECEIPT_SYS[\s\S]{0,400}(receipt|line item)/i.test(health), 'the receipt prompt is scoped to extracting food line items from a receipt photo');
assertTrue(health.includes('const systemPrompts = { photo: ANALYZE_SYS, label: LABEL_SYS, receipt: RECEIPT_SYS }'), 'the Analyze button dispatches to the correct system prompt for whichever photo kind is selected');
assertTrue(health.includes('pendingSource = photoAnalysisKind'), 'photo-mode entries are tagged with their real analyzed kind (photo/label/receipt), not a single generic source');
assertTrue(/labels\[photoAnalysisKind\][\s\S]{0,20}labels\.photo/.test(health), 'the Analyze button label changes to reflect what it will actually do (Analyze/Read Label/Read Receipt)');

// ============================== Honest source tagging ==============================
assertTrue(health.includes("source: pendingSource") && health.includes("source: 'manual'") && health.includes("pendingSource = 'describe'"), 'every entry path (photo/label/receipt/describe/barcode/manual) stamps a real source on the saved entry');
assertTrue(health.includes("badge.className = 'cal-source-badge'"), 'a distinct badge element is rendered for uncertain-source entries');
assertTrue(
  /e\.source === 'photo' \|\| e\.source === 'describe' \|\| e\.source === 'receipt'/.test(health),
  'the "AI est." badge only fires for genuinely AI-estimated sources'
);
assertTrue(!/e\.source === 'barcode'[\s\S]{0,80}cal-source-badge/.test(health), 'barcode entries (real database numbers) are never flagged as an AI estimate');
assertTrue(!/e\.source === 'manual'[\s\S]{0,80}cal-source-badge/.test(health), 'manually-entered numbers are never flagged as an AI estimate');

// ============================== Deterministic BMR/TDEE goal suggestion ==============================
assertTrue(health.includes('id="calGoalSuggestBtn"') && health.includes('id="calGoalPreview"'), 'a "Suggest from my profile" control and its preview box exist next to the existing Nova goal-setting button');
assertTrue(health.includes("storeGet('po_water_v1')") && health.includes('water && water.profile'), 'the suggestion reuses the profile data the dashboard already collects, with no new input UI or storage key');
assertTrue(health.includes('function computeSuggestedGoals'), 'a real formula function computes the suggestion, not an AI-guessed number');
assertTrue(health.includes("Add your weight, height, and age in Settings"), 'missing profile data produces an honest fallback message instead of a guessed target');
assertTrue(health.includes('preview.dataset.suggestion = JSON.stringify(suggestion)') && health.includes("$('calGoalPreviewApply').addEventListener"), 'the suggestion only ever previews — writing to cal:targets requires an explicit "Use this" click, never an automatic overwrite');
assertTrue(health.includes("storeSet(TARGETS_KEY, Object.assign({}, suggestion, { updatedAt: Date.now() }))"), 'applying the suggestion writes through the existing cal:targets key/shape, unchanged');

// Real numeric verification of the Mifflin-St Jeor arithmetic itself, since
// string-matching the formula's source text can't catch an arithmetic bug
// (e.g. a swapped +5/-161, or a wrong activity-multiplier bucket boundary).
const fnSrc = extractFunction(health, 'computeSuggestedGoals');
assertTrue(!!fnSrc, 'computeSuggestedGoals is extractable as a standalone function body for direct execution');
if (fnSrc) {
  function run(profile) {
    const storeGet = (key) => (key === 'po_water_v1' ? { profile } : null);
    const factory = new Function('storeGet', fnSrc + '; return computeSuggestedGoals();');
    return factory(storeGet);
  }

  assertEqual(run(null), null, 'no profile at all yields no suggestion (honest fallback, not a guess)');
  assertEqual(run({ weightKg: 70 }), null, 'a partial profile (missing height/age) yields no suggestion');

  // 30-year-old male, 80kg, 180cm, <2 hrs/week activity (multiplier 1.2).
  // BMR = 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780
  // TDEE = round(1780 * 1.2) = 2136
  const male = run({ weightKg: 80, heightCm: 180, age: 30, sex: 'm', activityHrsPerWeek: 0 });
  assertEqual(male.calories, 2136, 'male BMR/TDEE arithmetic matches Mifflin-St Jeor by hand for a known input');
  assertEqual(male.protein, Math.round((2136 * 0.30) / 4), 'protein target follows the stated 30% split at 4 cal/g');
  assertEqual(male.carbs, Math.round((2136 * 0.40) / 4), 'carb target follows the stated 40% split at 4 cal/g');
  assertEqual(male.fat, Math.round((2136 * 0.30) / 9), 'fat target follows the stated 30% split at 9 cal/g');

  // 28-year-old female, 60kg, 165cm, 10 hrs/week activity (multiplier 1.725).
  // BMR = 10*60 + 6.25*165 - 5*28 - 161 = 600 + 1031.25 - 140 - 161 = 1330.25
  // TDEE = round(1330.25 * 1.725) = round(2294.68125) = 2295
  const female = run({ weightKg: 60, heightCm: 165, age: 28, sex: 'f', activityHrsPerWeek: 10 });
  assertEqual(female.calories, 2295, 'female BMR uses the -161 constant, and a mid-range activity level picks the correct multiplier bucket');

  // Multiplier bucket boundaries: 2/5/8/12 hrs/week.
  const lowActivity = run({ weightKg: 80, heightCm: 180, age: 30, sex: 'm', activityHrsPerWeek: 1.9 });
  const justOverTwo = run({ weightKg: 80, heightCm: 180, age: 30, sex: 'm', activityHrsPerWeek: 2 });
  assertTrue(justOverTwo.calories > lowActivity.calories, 'crossing the 2 hrs/week boundary bumps the activity multiplier up, as intended');
  const highActivity = run({ weightKg: 80, heightCm: 180, age: 30, sex: 'm', activityHrsPerWeek: 12 });
  assertEqual(highActivity.calories, Math.round(1780 * 1.9), '12+ hrs/week hits the top 1.9 multiplier bucket');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
