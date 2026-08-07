import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}

// PR #161 swapped navigation icons to non-colorful sign glyphs; the very
// next request reverted that specific decision and asked for colorful
// emoji back on primary navigation/category markers. This file now
// verifies the emoji are actually back, not that they're gone.
const iconFiles = {
  'index.html': read('index.html'),
  'hub-today.html': read('hub-today.html'),
  'hub-body.html': read('hub-body.html'),
  'hub-money.html': read('hub-money.html'),
  'hub-reflect.html': read('hub-reflect.html'),
  'hub-insights.html': read('hub-insights.html'),
  'topbar.js': read('topbar.js'),
};
const EXPECTED_EMOJI = ['🏠', '⚡', '💰', '🪞', '🧭', '🎯', '🔥', '⏭️', '💪', '🗓️', '📆',
  '💊', '💧', '☕', '😴', '🌙', '📊', '💼', '📚', '🎖️', '🧠', '📝', '🎞️', '⚠️', '🏗️',
  '🎭', '🌊', '🕰️', '🔮', '🔗', '❤️', '🔔', '⭐', '📅', '🖥️', '📈', '🏋️'];
const ICON_SPAN_RE = /class="(tile-emoji|mc-emoji|cc-browse-icon|cc-browse-card-emoji|cc-signal-icon|bottombar-tab-icon|topbar-finance-icon)">([^<]*)</g;
for (const [file, content] of Object.entries(iconFiles)) {
  const glyphs = Array.from(content.matchAll(ICON_SPAN_RE)).map(m => m[2]);
  if (!glyphs.length) continue;
  const allEmoji = glyphs.every(g => EXPECTED_EMOJI.includes(g));
  assertTrue(allEmoji, file + ': navigation-icon spans are colorful emoji again, not sign glyphs (' + glyphs.length + ' icons checked)');
}
assertTrue(read('index.html').includes('cc-browse-card-emoji">🏠<'), 'index.html Today icon is back to 🏠');
assertTrue(read('hub-body.html').includes('tile-emoji">💧<'), 'hub-body.html Water icon is back to 💧');
assertTrue(read('hub-reflect.html').includes('tile-emoji">📝<'), 'hub-reflect.html Notes icon is back to 📝');
assertTrue(read('command-center.js').includes('❤️') && read('command-center.js').includes('😴'), 'the Signals grid Recovery/Sleep icon uses the requested ❤️/😴 emoji, not a plain sign glyph');
assertTrue(read('command-center.js').includes('💧'), 'the Signals grid Water icon uses the requested 💧 emoji');
assertTrue(read('index.html').includes('📅 Schedule') || read('command-center.js').includes('📅 Schedule'), 'the Schedule section head carries the requested 📅 marker');
assertTrue(read('index.html').includes('🔔 Alerts'), 'the Alerts section head carries the requested 🔔 marker');

// ---- The explicit accent-color CSS added when these were sign glyphs is
// harmless now that they're emoji again (color is simply ignored for
// emoji-presentation characters) — left in place rather than churned back
// out, since it costs nothing and helps if a future pass goes sign-only
// again. ----
assertTrue(/\.tile-emoji\s*\{[^}]*color:\s*var\(--accent\)/.test(read('design-system.css')), 'the tile-emoji accent-color rule from the sign-glyph pass is still present (inert for emoji, harmless)');

// ---- Global animation: applies to every page via design-system.css ----
const ds = read('design-system.css');
assertTrue(/\.gm-card,\s*\.tile\s*\{[^}]*animation:\s*gmEntranceIn/.test(ds), 'every .gm-card and .tile gets a fade/rise-in entrance animation, on every page that uses the shared design system');
assertTrue(ds.includes('@keyframes gmEntranceIn'), 'the entrance keyframe is defined');
assertTrue(/animation:\s*hud-drift[^;]*,\s*hud-bg-pulse/.test(ds), 'the ambient background now also pulses, not just drifts');
assertTrue(ds.includes('@keyframes hud-bg-pulse'), 'the background pulse keyframe is defined');

// ---- The scanline CSS existed before but nothing ever instantiated the
// element — verify it's now actually injected on every page via topbar.js,
// which loads everywhere. ----
const tb = read('topbar.js');
assertTrue(/function injectScanline/.test(tb), 'topbar.js defines a scanline-injection function');
assertTrue(/injectScanline\(\);/.test(tb), 'the scanline injector is actually called during boot, not just defined and forgotten');
assertTrue(/hud-scanline/.test(tb) && /createElement\('div'\)/.test(tb), 'the injector creates the element design-system.css already styles');

// ---- Reduced motion: every new animated element added to the disable list ----
const reducedBlockDs = ds.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)[1];
assertTrue(reducedBlockDs.includes('.gm-card') && reducedBlockDs.includes('.tile'), 'the global reduced-motion block disables the new card entrance animation');
const cc = read('command-center.css');
const reducedBlock1 = cc.match(/@media \(prefers-reduced-motion: reduce\) \{([^}]*)\}/)[1];
assertTrue(reducedBlock1.includes('.cc-core-panel-enter'), 'reduced-motion disables the AI Core tab-switch fade-in');
assertTrue(reducedBlock1.includes('.cc-jarvis-ring') && reducedBlock1.includes('.cc-jarvis-core-svg'), 'reduced-motion disables the JARVIS orb ring/core animation (superseded the earlier mic pulse — see tests/test_jarvis_widget.mjs)');
assertTrue(reducedBlock1.includes('.cc-trace-bar'), 'reduced-motion disables the trend-trace bar grow-in');

// ---- AI Core tab-switch animation: replays on every switch, not just once ----
const ccJs = read('command-center.js');
assertTrue(/entering\.classList\.remove\('cc-core-panel-enter'\)/.test(ccJs) && /entering\.classList\.add\('cc-core-panel-enter'\)/.test(ccJs), 'switching tabs removes then re-adds the entrance class so the animation actually replays (not skipped as a no-op class toggle)');
assertTrue(/void entering\.offsetWidth/.test(ccJs), 'a reflow is forced between removing and re-adding the class, otherwise the browser would coalesce the two and never restart the animation');

// ---- trace-bar grow-in ----
assertTrue(cc.includes('@keyframes ccTraceGrow'), 'the trend-trace bar grow-in keyframe is defined');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
