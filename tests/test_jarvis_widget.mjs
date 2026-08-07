import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Consolidated coverage for the "Tony Stark" cinematic pass: the JARVIS
// neural-core widget, the holographic-globe replacement for the score
// ring, the ambient Canvas background, and the dashboard-wide motion
// hierarchy (stagger, hover sweep, tab-scan, alert/signal pulses, animated
// score counter). Supersedes the placeholder-mic assertions that used to
// live in test_command_center_appearance.mjs and
// test_dashboard_animation_and_icons.mjs (those two still own emoji and
// baseline-animation coverage from the prior two phases; this file is
// specifically the cinematic-pass follow-up referenced from
// test_command_center_appearance.mjs's jarvisPromptBtn assertion).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const html = read('index.html');
const css = read('command-center.css');
const ds = read('design-system.css');
const js = read('command-center.js');
const topbar = read('topbar.js');
const bg = read('jarvis-background.js');
const globe = read('jarvis-globe.js');

// ---- JARVIS orb replaces the old disabled-placeholder mic ----
assertTrue(!/cc-jarvis-mic|cc-jarvis-btn/.test(html), 'the old placeholder mic/button markup is fully gone from index.html');
assertTrue(!/cc-jarvis-mic|cc-jarvis-btn/.test(css), 'the old placeholder mic/button CSS is fully gone from command-center.css');
for (const id of ['jarvisOrb', 'jarvisStatusDot', 'jarvisStatusText', 'jarvisNodes', 'jarvisWaveform', 'jarvisPromptBtn', 'jarvisPromptText', 'jarvisResponse', 'jarvisResponseLabel', 'jarvisResponseBody', 'jarvisResponseSource']) {
  assertTrue(html.includes('id="' + id + '"'), 'index.html has the JARVIS widget element #' + id);
}

// ---- Five states: idle (default/no attribute), listening, thinking, responding, alert ----
assertTrue(/\[data-state="listening"\][^{]*\.cc-jarvis-ring-1/.test(css) || /data-state="listening"/.test(css), 'a listening state selector exists');
assertTrue(css.includes('[data-state="thinking"]'), 'a thinking state selector exists');
assertTrue(css.includes('[data-state="responding"]'), 'a responding state selector exists');
assertTrue(css.includes('.cc-jarvis-orb.is-alert'), 'an alert state exists as an independent class (can combine with any data-state)');
assertTrue(/is-alert[^{]*\{[^}]*var\(--warning\)/.test(css), 'alert state uses the restrained amber/warning token, not a constantly-flashing red');

// ---- Idle breathing + concentric rings at different speeds, within the 4-6s spec band ----
assertTrue(/ccJarvisBreathe 5s/.test(css), 'the core breathes on a 5s cycle (within the 4-6s spec band)');
assertTrue(/ccJarvisRingSpin/.test(css) && css.includes('@keyframes ccJarvisRingSpin'), 'the ring-spin keyframe exists');
assertTrue(css.includes('.cc-jarvis-ring-1') && css.includes('.cc-jarvis-ring-2') && css.includes('.cc-jarvis-ring-3'), 'three concentric rings are defined');
assertTrue(/\.cc-jarvis-ring-2[^}]*animation-duration:8s/.test(css) && /\.cc-jarvis-ring-3[^}]*animation-duration:11s/.test(css), 'the rings spin at different speeds from each other (5s/8s/11s), not in lockstep');

// ---- Listening: waveform activates ----
assertTrue(css.includes('.cc-jarvis-waveform') && /\[data-state="listening"\][^{]*\.cc-jarvis-waveform\s*\{[^}]*opacity:1/.test(css), 'the waveform only becomes visible in the listening state');
assertTrue(css.includes('@keyframes ccJarvisWave'), 'the waveform bar-height keyframe is defined');

// ---- Thinking: nodes light up sequentially, scan speeds increase ----
assertTrue(/thinking[^~]*~[^{]*\.cc-jarvis-node[^{]*\{[^}]*animation:ccJarvisNodeLight/.test(css), 'thinking state lights up the signal nodes');
assertTrue(css.includes('--i') && css.includes('animation-delay:calc(var(--i)'), 'nodes light up with a staggered delay (not all at once)');
assertTrue(js.includes("JARVIS_NODE_LABELS = ['SCHEDULE', 'RECOVERY', 'FINANCE', 'HABITS']"), 'the four signal nodes connect the dashboard systems the brief named');

// ---- Responding: geometry brighter, response unfolds as a compact card ----
assertTrue(/responding[^{]*\.cc-jarvis-facet\s*\{[^}]*fill:rgba\(var\(--hud-rgb\)/.test(css), 'responding state brightens the facet fill');
assertTrue(css.includes('.cc-jarvis-response') && /ccCorePanelIn|animation/.test(css.slice(css.indexOf('.cc-jarvis-response'), css.indexOf('.cc-jarvis-response') + 400)), 'the response card animates in rather than just appearing');

// ---- Even before voice is connected, the widget visually represents real analysis ----
assertTrue(js.includes('window.__commandCenterModel'), 'JARVIS sources its response from the real command-center model, not a scripted demo');
assertTrue(js.includes('model.insight') || js.includes('model && model.insight'), 'the response text is the same real insight already shown in the Insight banner (buildProactiveInsight), not fabricated text');
assertTrue(/'Add a goal or check-in and the Command Center will start prioritizing your day\.'/.test(js), 'with no real insight yet, JARVIS says so honestly rather than inventing a fake finding');
assertTrue(js.includes("setJarvisState('listening')") && js.includes("setJarvisState('thinking')") && js.includes("setJarvisState('responding')"), 'a single analysis run walks through listening -> thinking -> responding');
assertTrue(js.includes('jarvisAutoPlayed') && /if \(!jarvisAutoPlayed\)/.test(js), 'the widget auto-plays once the first time the Jarvis tab opens (not on every switch back), matching "even before voice interaction is connected, visually represent the AI analyzing signals"');
assertTrue(js.includes('jarvisBusy') && /if \(jarvisBusy/.test(js), 'a run in progress cannot be re-triggered mid-sequence');

// ---- updateJarvisAlertState must be reachable from render(), i.e. at module scope ----
assertTrue(/^function updateJarvisAlertState\(alertCount\) \{/m.test(js), 'updateJarvisAlertState is a module-scope function (not nested inside boot()), so render() can actually call it');
assertTrue(/updateJarvisAlertState\(model\.alertCount\);/.test(js), 'render() calls updateJarvisAlertState on every render so the alert tint always reflects the current alert count');

// ---- Orb prominence + idle liveliness (follow-up polish pass) ----
assertTrue(/\.cc-jarvis-orb \{[^}]*width:172px/.test(css), 'the orb is sized up from the original 118px for more visual weight');
assertTrue(css.includes('.cc-jarvis-glow') && css.includes('@keyframes ccJarvisGlowPulse'), 'a soft radial energy field pulses behind the orb, independent of the ring animations');
assertTrue(css.includes('.cc-jarvis-orbit') && css.includes('.cc-jarvis-orbit-dot'), 'small signal nodes continuously trace the rings, even at idle, so the widget never reads as a static image');
assertTrue(css.includes('@keyframes ccJarvisIdleShimmer') && /\.cc-jarvis-facet-line \{[^}]*animation:ccJarvisIdleShimmer/.test(css), 'facet lines shimmer even in idle (thinking state still overrides with the faster/brighter scan)');
assertTrue(css.includes('.cc-jarvis-facet-core') && css.includes('.cc-jarvis-core-dot') && css.includes('@keyframes ccJarvisCorePulse'), 'a third, innermost facet layer and a pulsing core dot add geometric depth beyond the original two-layer hexagon');
assertTrue(css.includes('.cc-jarvis-orb.is-alert .cc-jarvis-glow'), 'the alert state also tints the ambient glow amber, not just the ring stroke');
assertTrue(/\.cc-jarvis-glow,\s*\n?\s*\.cc-jarvis-orbit,\s*\n?\s*\.cc-jarvis-core-dot,/.test(css) || (css.includes('.cc-jarvis-glow') && css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)[1].includes('.cc-jarvis-glow')), 'the new always-on glow/orbit/core-dot animations are disabled under reduced motion too, not just the original elements');

// ---- Holographic globe: existing ring is the real fallback, not removed ----
assertTrue(html.includes('id="scoreRing"') && html.includes('hud-ring-track'), 'the original flat ring markup is still intact in the DOM as the WebGL fallback');
assertTrue(globe.includes("document.getElementById('scoreRing')") && /if \(!mount\) return;/.test(globe), 'the globe module bails cleanly (leaving the ring alone) if its mount point is missing');
assertTrue(/window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) return;/.test(globe), 'the globe module bails under reduced motion before ever mounting');
assertTrue(/getContext\('webgl'\)/.test(globe) && /catch \(e\) \{ return; \}/.test(globe), 'the globe module bails if WebGL context creation throws');
assertTrue(/\.catch\(\(\) => \{/.test(globe), 'a blocked/failed Three.js CDN import is caught silently, leaving the fallback ring rendering as-is');
assertTrue(globe.includes("unpkg.com/three@"), 'Three.js is loaded via dynamic ES module import, matching the existing CDN-script pattern used for Supabase');
assertTrue(css.includes('.hud-ring.has-globe') && /\.hud-ring-track\s*\{\s*opacity:0/.test(css.slice(css.indexOf('.has-globe'))), 'the flat ring visuals are only hidden once the globe actually mounts (has-globe class), never unconditionally');
assertTrue(globe.includes('window.__jarvisGlobePulse') && globe.includes('window.__jarvisGlobeSetAlertLevel'), 'the globe exposes pulse and alert-level hooks for the real score/alert data to drive');
const rotatePeriod = Number((globe.match(/ROTATE_PERIOD\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
assertTrue(rotatePeriod >= 20 && rotatePeriod <= 30, 'globe rotation period (' + rotatePeriod + 's) is within the 20-30s spec band');
const ringPeriodA = Number((globe.match(/RING_PERIOD_A\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
const ringPeriodB = Number((globe.match(/RING_PERIOD_B\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
assertTrue(ringPeriodA >= 8 && ringPeriodA <= 12 && ringPeriodB >= 8 && ringPeriodB <= 12, 'both orbital ring periods (' + ringPeriodA + 's, ' + ringPeriodB + 's) fall within the 8-12s spec band');
assertTrue(globe.includes("document.addEventListener('visibilitychange'") && /cancelAnimationFrame/.test(globe), 'the globe animation loop pauses when the tab is hidden');
assertTrue(globe.includes('amber') || globe.includes('0xffb84d'), 'a restrained amber tone is used for priority signals on the globe, not a loud/flashing color');

// ---- Globe polish pass: bigger stage, more surface detail, a real axial tilt ----
assertTrue(/\.cc-ai-core\.score-card \.hud-ring\.has-globe \{ width:224px/.test(css), 'the globe gets a noticeably bigger stage than the flat-ring fallback once it actually mounts');
const lightCount = Number((globe.match(/LIGHT_COUNT = (\d+)/) || [])[1]);
assertTrue(lightCount > 260, 'the city-light point count was increased from the original pass (' + lightCount + ' > 260) for a visibly richer surface');
assertTrue(globe.includes('atmosphere') && globe.includes('THREE.BackSide'), 'a back-face atmosphere shell adds a soft rim glow around the globe');
assertTrue(globe.includes('AXIAL_TILT') && /globeGroup\.rotation\.x = AXIAL_TILT/.test(globe), 'the globe spins on a real axial tilt rather than dead-level, for a more planetary motion feel');
assertTrue(/globeGroup\.rotation\.x = AXIAL_TILT \+ Math\.sin\(elapsed \* [\d.]+\) \* [\d.]+;/.test(globe), 'a slow, subtle wobble is layered on top of the tilt rather than a perfectly rigid spin');

// ---- Ambient Canvas background: sitewide (loaded by topbar.js on every
// page, same pattern as time-theme.js/command-bar.js), layered, reduced-
// motion aware, idempotent against double-mounting ----
assertTrue(topbar.includes("loadSharedModule('jarvis-background.js'"), 'topbar.js loads the ambient background on every page it runs on, not just the Command Center');
assertTrue(!html.includes('<script src="jarvis-background.js"'), "index.html no longer carries its own static script tag now that topbar.js's shared loader covers it (would double-mount otherwise)");
assertTrue(bg.includes("if (document.getElementById('jarvisBg')) return;"), 'the background bails if already mounted, so a page double-loading it (e.g. its own leftover tag) never creates a second canvas');
assertTrue(/window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) return;/.test(bg), 'the ambient background bails entirely under reduced motion, leaving the existing static CSS backdrop');
// No negative z-index — verified against a real browser that it silently
// hides behind body's own explicit background-color (a real, confirmed
// stacking bug, not a style preference). Inserted as body's first child
// instead, so plain DOM paint order puts it behind everything on its own.
const bgCanvasStyle = (bg.match(/canvas\.style\.cssText = '([^']*)'/) || [])[1] || '';
assertTrue(bg.includes("canvas.id = 'jarvisBg'") && !bgCanvasStyle.includes('z-index') && bgCanvasStyle.includes('pointer-events:none') && /insertBefore\(canvas, document\.body\.firstChild\)/.test(bg), 'the canvas sits behind all content via DOM order (no negative z-index, which hides behind body\'s own background) and never intercepts clicks');
assertTrue(bg.includes('particleLayers') && /for \(let l = 0; l < 3; l\+\+\)/.test(bg), 'the particle field has multiple depth layers, matching "multiple layers of slowly drifting particles"');
assertTrue(bg.includes('arcs') && bg.includes('nextPulseAt') && bg.includes('pulse'), 'orbital arcs carry occasional traveling energy pulses, not just static rings');
assertTrue(bg.includes('fogBlobs'), 'a soft fog/bloom layer is present');
assertTrue(bg.includes('hudColor') && bg.includes('dataset.timeTheme'), 'background tint shifts with the existing day/night theme, without introducing a new storage key');
assertTrue(bg.includes('onPointerMove') && /isFinePointer\(\) \|\| isNarrow\(\)/.test(bg), 'pointer parallax is gated off on touch/narrow devices, only active for a fine pointer on a wide viewport');
assertTrue(/isNarrow\(\) \? 14 : 34/.test(bg), 'particle count is reduced on narrow viewports rather than rendering the full desktop count on mobile');
assertTrue(bg.includes("document.addEventListener('visibilitychange'") && bg.includes('function stop()') && bg.includes('function start()'), 'the background render loop pauses while the tab is hidden');

// ---- Global CSS animation-lock fix: entrance animation must release the
// transform property once it finishes, or the CSS `:hover` lift on every
// .gm-card/.tile across the whole app is silently and permanently blocked
// by the still-"filled" animation (found and fixed during this pass's own
// Playwright verification — see topbar.js). ----
assertTrue(/document\.addEventListener\('animationend'/.test(topbar) && /gmEntranceIn/.test(topbar) && /style\.animation = 'none'/.test(topbar), 'topbar.js releases the one-shot entrance animation once it ends, so :hover transforms on .gm-card/.tile actually apply afterward on every page');

// ---- Global CSS hover-sweep + stagger (design-system.css, every page) ----
assertTrue(/\.gm-card:hover\s*\{[^}]*transform:\s*translateY\(-2px\)/.test(ds), '.gm-card lifts on hover');
assertTrue(/background-position 0\.6s/.test(ds), 'the border-energy sweep glides across on hover rather than snapping');
assertTrue(/\.gm-card:nth-child\(2\), \.tile:nth-child\(2\) \{ animation-delay:/.test(ds), 'cards/tiles stagger their entrance by DOM position');
assertTrue(/\.tile:hover \.tile-emoji \{ transform:\s*scale/.test(ds), 'category emoji react slightly on hover, matching "navigation emojis reacting slightly on hover/selection"');
assertTrue(/\.cc-browse-card:hover \.cc-browse-card-emoji \{ transform:scale/.test(css), 'the Command Center browse-row emoji react on hover too');

// ---- Tab-switch "scan" indicator ----
assertTrue(/\.cc-core-tab\.is-active\s*\{[^}]*animation:ccTabActivate/.test(css) && css.includes('@keyframes ccTabActivate'), 'selected tabs transition through a scan pulse, not an instant swap');

// ---- Alerts: one controlled entry pulse for genuinely new alerts only ----
assertTrue(/\.cc-alert\.is-new \{[^}]*animation:ccRowIn[^,]*,\s*ccAlertNewPulse/.test(css), 'new alerts get one controlled pulse on entry');
const previousAlertIdsUsed = /previousAlertIds\.has\(alert\.id\)/.test(js) && /previousAlertIds = currentAlertIds;/.test(js);
assertTrue(previousAlertIdsUsed, 'is-new is computed by diffing against alerts already on screen, so old alerts do not re-pulse on every render');

// ---- Signals rail: a brief traveling highlight only on a genuine value change ----
assertTrue(/\.cc-signal\.is-refreshed \{ animation:ccSignalRefresh/.test(css), 'a changed signal value gets a brief refresh highlight');
assertTrue(js.includes('previousSignalValues') && /changed = !isFirstSignalsRender/.test(js), 'the refresh highlight is diff-based (real change), not applied on every re-render');
// Regression test: a single logical event (e.g. one `storage` event) fans
// out into multiple render() triggers in this codebase (index.html's own
// storage handler re-dispatches command-center:refresh after running) —
// without coalescing, the 2nd render always compares against the 1st
// render's already-updated snapshot and sees "no change," silently
// erasing the highlight before the browser ever paints it.
assertTrue(js.includes('function scheduleRender()') && js.includes('queueMicrotask'), 'render() calls triggered by storage/goals-changed/alert-state-changed/command-center:refresh are coalesced into one microtask per tick');
assertTrue(js.includes("window.addEventListener('storage', scheduleRender)") && js.includes("document.addEventListener('command-center:refresh', scheduleRender)"), 'the events known to fan out into multiple triggers per logical change go through the coalescing wrapper, not render() directly');

// ---- Animated score counter (count-up, not an instant jump) ----
assertTrue(html.includes('function animateScoreNum') && /requestAnimationFrame\(tick\)/.test(html), 'the Today Score counts up via requestAnimationFrame rather than snapping to the new value');
assertTrue(/prefersReducedMotion \|\| from === to/.test(html), 'the counter skips straight to the final value under reduced motion or when nothing changed');
assertTrue(/__jarvisGlobePulse/.test(html) && /lastRenderedScore !== result\.score/.test(html), 'a real score change also pulses the globe, giving the update a felt moment rather than an instant silent change');

// ---- Reduced-motion coverage for every new animated selector this pass added ----
const reducedBlock = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)animation: none;\s*\}/)[1];
for (const sel of ['.cc-jarvis-ring', '.cc-jarvis-core-svg', '.cc-jarvis-status-dot', '.cc-jarvis-facet-line', '.cc-jarvis-node', '.cc-jarvis-waveform span', '.cc-jarvis-response', '.cc-core-tab.is-active', '.cc-alert.is-new', '.cc-signal.is-refreshed']) {
  assertTrue(reducedBlock.includes(sel), 'reduced-motion disables ' + sel + ' (own local block, avoiding the earlier-loaded-stylesheet specificity trap)');
}

// ---- No new storage keys introduced by this pass ----
const newStorageKeyPattern = /localStorage\.(?:setItem|getItem)\(['"]cc_[a-z_]+_v\d['"]/g;
const keysInThisPassFiles = [globe, bg].join('\n');
assertTrue(!newStorageKeyPattern.test(keysInThisPassFiles), 'jarvis-globe.js and jarvis-background.js introduce no new storage keys of their own');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
