import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Covers a real accessibility audit pass (not a redesign) on color-only
// status signaling and icon-only controls found in health.html and
// design-system.css: the WHOOP vitals "zone" dots (Sleep/Strain/HRV/RHR/
// Skin temp/Blood O2/Resp rate) that used to convey good/normal/watch/
// high-low by hue alone with zero accessible name, two icon-only delete
// buttons ("×") with no aria-label, two toggle buttons whose pressed state
// was color-only with no aria-pressed, and a text color that measured just
// under the WCAG AA 4.5:1 contrast floor against the page's real background.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertEqual(actual, expected, label) {
  if (actual === expected) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '- expected', expected, 'got', actual); }
}

// Extracts a top-level `function name(...) { ... }` body via brace-counting,
// same helper used by test_nutrition_tracker.mjs.
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
const ds = read('design-system.css');

// relative luminance / contrast ratio helpers (WCAG 2.x formula)
function relLuminance(hex) {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16) / 255, g = parseInt(n.slice(2, 4), 16) / 255, b = parseInt(n.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(hexA, hexB) {
  const a = relLuminance(hexA), b = relLuminance(hexB);
  const lighter = Math.max(a, b), darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// ============================== WHOOP vitals zone dots ==============================
assertTrue(health.includes('const ZONE_LABELS'), 'a label map exists for the zone dot states');
const zoneFnSrc = extractFunction(health, 'zone');
assertTrue(!!zoneFnSrc, 'zone() is extractable as a standalone function body');
if (zoneFnSrc) {
  function runZone(c) {
    const calls = {};
    const el = {
      className: '',
      attrs: {},
      classList: { add(v) { calls.addedClass = v; } },
      setAttribute(k, v) { el.attrs[k] = v; },
      removeAttribute(k) { delete el.attrs[k]; },
    };
    const ZONE_LABELS = { good: 'Good', norm: 'Normal', warn: 'Watch', bad: 'High or low' };
    const factory = new Function('ZONE_LABELS', 'el', 'c', zoneFnSrc + '; zone(el, c); return el;');
    return factory(ZONE_LABELS, el, c);
  }
  const withData = runZone('warn');
  assertEqual(withData.attrs['aria-label'], 'Zone: Watch', 'a zone dot with a real reading gets a text aria-label naming the zone, not just a color class');
  assertTrue(!('aria-hidden' in withData.attrs), 'a zone dot with a real reading is not hidden from assistive tech');
  const noData = runZone(null);
  assertEqual(noData.attrs['aria-hidden'], 'true', 'a zone dot with no reading yet is hidden from assistive tech rather than announcing a stale/empty label');
  assertTrue(!('aria-label' in noData.attrs), 'a zone dot with no reading yet carries no aria-label');
}
assertTrue(
  (health.match(/class="wh-zone" id="whZone\w+" role="img" aria-hidden="true"/g) || []).length === 7,
  'all 7 WHOOP vital zone dots (Sleep/Strain/HRV/RHR/Skin temp/Blood O2/Resp rate) declare role="img" so their aria-label is exposed as an accessible name, and start aria-hidden before any data has loaded'
);

// ============================== Icon-only delete buttons ==============================
assertTrue(health.includes("del.setAttribute('aria-label', 'Delete ' + mealName)"), 'the Today-list meal delete button ("×") gets an aria-label naming the actual meal, not just the symbol');
assertTrue(
  health.includes('aria-label="\' + escapeAttr(\'Remove \' + (item.name || \'item\'))'),
  'each meal-editor line-item delete button ("×") gets an aria-label naming the item being removed'
);

// ============================== Toggle buttons: state was color-only ==============================
assertTrue(health.includes('aria-pressed="${isTaken}"'), 'the "mark taken" supplement toggle exposes its pressed state via aria-pressed, not just a background-color change');
assertTrue(health.includes("(isTaken ? 'Taken: ' : 'Mark taken: ') + item.name"), 'the "mark taken" toggle\'s accessible name changes with its own state and names the actual item');
assertTrue(health.includes('aria-pressed="${isLow}"'), 'the "Running low" toggle exposes its pressed state via aria-pressed, since its label text never changes between states and only its color previously did');
assertTrue(health.includes('aria-label="Delete ${escapeHtml(item.name)}"'), 'the supplement row delete button names the actual item being deleted, not a generic "Delete"');

// ============================== Contrast: --text-tertiary ==============================
const tertiaryMatch = ds.match(/--text-tertiary:\s*(#[0-9A-Fa-f]{6})/);
assertTrue(!!tertiaryMatch, '--text-tertiary is defined as a hex color in design-system.css');
if (tertiaryMatch) {
  const pageBgMatch = ds.match(/--surface-page:\s*(#[0-9A-Fa-f]{6})/);
  assertTrue(!!pageBgMatch, '--surface-page (the real html/body background) is defined as a hex color');
  if (pageBgMatch) {
    const ratio = contrastRatio(tertiaryMatch[1], pageBgMatch[1]);
    assertTrue(ratio >= 4.5, '--text-tertiary meets the WCAG AA 4.5:1 contrast floor for normal-size text against the actual page background (was ~4.48:1, just under)');
  }
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
