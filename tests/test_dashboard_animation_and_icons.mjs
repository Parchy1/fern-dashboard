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

// A colorful pictograph emoji is any character outside the Basic Multilingual
// Plane's plain-text ranges we actually use for icons (Geometric Shapes,
// Arrows, a handful of Miscellaneous Symbols already proven text-presentation
// elsewhere in this codebase). Rather than enumerate every emoji block, check
// for the specific pictographs this pass was asked to remove.
const REMOVED_EMOJI = ['🏠', '⚡', '💰', '🪞', '🧭', '🎯', '🔥', '⏭️', '💪', '🗓️', '📆',
  '💊', '💧', '☕', '😴', '🌙', '📊', '💼', '📚', '🎖️', '🧠', '📝', '🎞️', '⚠️', '🏗️',
  '🎭', '🌊', '🕰️', '🔮', '🔗'];

const iconFiles = {
  'index.html': read('index.html'),
  'hub-today.html': read('hub-today.html'),
  'hub-body.html': read('hub-body.html'),
  'hub-money.html': read('hub-money.html'),
  'hub-reflect.html': read('hub-reflect.html'),
  'hub-insights.html': read('hub-insights.html'),
  'topbar.js': read('topbar.js'),
};

// ---- Navigation-icon emoji replaced with non-colorful HUD sign glyphs ----
// Scoped to the icon-class spans specifically (tile-emoji / mc-emoji /
// cc-browse-icon / bottombar-tab-icon / topbar-finance-icon) — this pass
// deliberately did not touch content emoji embedded in page bodies
// (caffeine.html's drink list, peak.html's factor rows, status text, etc.),
// a different usage pattern than persistent navigation iconography.
const ICON_SPAN_RE = /class="(tile-emoji|mc-emoji|cc-browse-icon|bottombar-tab-icon|topbar-finance-icon)">([^<]*)</g;
for (const [file, content] of Object.entries(iconFiles)) {
  const glyphs = Array.from(content.matchAll(ICON_SPAN_RE)).map(m => m[2]);
  if (!glyphs.length) continue;
  const stillEmoji = glyphs.filter(g => REMOVED_EMOJI.includes(g));
  assertTrue(stillEmoji.length === 0, file + ': no colorful pictograph emoji remain in navigation-icon spans (' + glyphs.length + ' icons checked)');
}

assertTrue(read('index.html').includes('cc-browse-icon">◉<') , 'index.html Today icon is a plain sign glyph, not the old 🏠');
assertTrue(read('hub-body.html').includes('tile-emoji">◇<'), 'hub-body.html Water icon reuses the same ◇ glyph the Signals rail already uses for water');
assertTrue(read('hub-reflect.html').includes('tile-emoji">✎<'), 'hub-reflect.html Notes icon reuses the same ✎ glyph the Recent Activity feed already uses for notes');

// ---- Icons now need an explicit CSS color (emoji ignored the `color`
// property; plain text glyphs don't) ----
assertTrue(/\.tile-emoji\s*\{[^}]*color:\s*var\(--accent\)/.test(read('design-system.css')), 'tile-emoji has an explicit accent color now that it is plain text, not a self-colored emoji');
assertTrue(/\.cc-browse-icon\s*\{[^}]*color:var\(--accent\)/.test(read('command-center.css')), 'cc-browse-icon has an explicit accent color');
assertTrue(/\.mc-emoji\s*\{[^}]*color:\s*var\(--accent\)/.test(read('hub-today.html')), 'mc-emoji has an explicit accent color');

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
assertTrue(reducedBlock1.includes('.cc-jarvis-mic::before') && reducedBlock1.includes('.cc-jarvis-mic::after'), 'reduced-motion disables the Jarvis mic pulse rings');
assertTrue(reducedBlock1.includes('.cc-trace-bar'), 'reduced-motion disables the trend-trace bar grow-in');

// ---- AI Core tab-switch animation: replays on every switch, not just once ----
const ccJs = read('command-center.js');
assertTrue(/entering\.classList\.remove\('cc-core-panel-enter'\)/.test(ccJs) && /entering\.classList\.add\('cc-core-panel-enter'\)/.test(ccJs), 'switching tabs removes then re-adds the entrance class so the animation actually replays (not skipped as a no-op class toggle)');
assertTrue(/void entering\.offsetWidth/.test(ccJs), 'a reflow is forced between removing and re-adding the class, otherwise the browser would coalesce the two and never restart the animation');

// ---- Jarvis mic pulse and trace-bar grow-in are purely decorative (no
// behavior change) ----
assertTrue(cc.includes('@keyframes ccJarvisPulse'), 'the Jarvis mic pulse keyframe is defined');
assertTrue(cc.includes('@keyframes ccTraceGrow'), 'the trend-trace bar grow-in keyframe is defined');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
