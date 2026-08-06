import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { greetingFor, kickerFor, readAppearance } from '../command-center.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'command-center.css'), 'utf8');

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ---- readAppearance: defaults preserve today's exact behavior ----
global.localStorage = {
  store: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  clear() { this.store = {}; },
};

global.localStorage.clear();
assertEq(readAppearance(), { tone: 'friendly', consoleStyle: 'cards', railContent: 'schedule_signals' }, 'with nothing saved, appearance defaults match the pre-redesign behavior exactly');

global.localStorage.setItem('cc_appearance_v1', JSON.stringify({ tone: 'callsign', consoleStyle: 'terminal', railContent: 'alerts_activity' }));
assertEq(readAppearance(), { tone: 'callsign', consoleStyle: 'terminal', railContent: 'alerts_activity' }, 'a saved preference is read back as-is');

global.localStorage.setItem('cc_appearance_v1', JSON.stringify({ tone: 'not-a-real-tone', consoleStyle: 'also-fake' }));
assertEq(readAppearance(), { tone: 'friendly', consoleStyle: 'cards', railContent: 'schedule_signals' }, 'an unrecognized/corrupt value falls back to the safe default rather than propagating garbage');

global.localStorage.setItem('cc_appearance_v1', 'not json');
assertEq(readAppearance(), { tone: 'friendly', consoleStyle: 'cards', railContent: 'schedule_signals' }, 'unparsable localStorage does not throw, falls back to defaults');

// ---- greetingFor / kickerFor ----
assertEq(greetingFor('friendly', 8), 'Good morning, Fernando', 'friendly tone at 8am matches the original greeting copy exactly');
assertEq(greetingFor('friendly', 14), 'Good afternoon, Fernando', 'friendly tone at 2pm matches the original greeting copy exactly');
assertEq(greetingFor('friendly', 20), 'Good evening, Fernando', 'friendly tone at 8pm matches the original greeting copy exactly');
assertEq(greetingFor('friendly', 2), 'Still up, Fernando', 'friendly tone at 2am matches the original greeting copy exactly');
assertEq(greetingFor('callsign', 8), 'JARVIS // GOOD MORNING', 'callsign tone swaps in JARVIS-flavored copy');
assertEq(greetingFor('callsign', 2), 'JARVIS // STANDBY', 'callsign tone has its own late-night phrasing');
assertEq(kickerFor('friendly'), 'Command Center · Online', 'friendly kicker matches the original static text exactly');
assertEq(kickerFor('callsign'), 'FERNANDO-OS · Online', 'callsign kicker swaps in the JARVIS-flavored label');

// ---- markup / stylesheet wiring ----
assertTrue(html.includes('id="ccKicker"'), 'the kicker element has an id so its text can be swapped by tone');
assertTrue(html.includes('id="coreTabToday"') && html.includes('id="coreTabJarvis"'), 'the AI Core card exposes Today/Jarvis tabs');
assertTrue(html.includes('id="coreJarvisPanel"') && /id="coreJarvisPanel"[^>]*hidden/.test(html), 'the Jarvis panel starts hidden — Today is the default view on load');
assertTrue(/cc-jarvis-btn[^>]*disabled|disabled[^>]*cc-jarvis-btn/.test(html) || html.includes('cc-jarvis-btn" disabled'), 'the Jarvis "Tap to talk" button ships disabled — it is a placeholder, not a working feature');
assertTrue(html.includes('id="toneSeg"') && html.includes('id="consoleStyleSeg"') && html.includes('id="railContentSeg"'), 'Settings exposes all three appearance toggles');
assertTrue(html.includes("appearance-changed"), 'toggling an appearance setting notifies the Command Center to re-render live, not just on next reload');
assertTrue(css.includes('.cc-core-panel[hidden]'), 'hidden AI Core panels are actually hidden — a bare .cc-core-panel{display:flex} rule alone would beat the UA [hidden] stylesheet default at equal specificity');
assertTrue(css.includes('.cc-console-row') && css.includes('.cc-console-cursor'), 'the terminal console style has its own CSS');
assertTrue(/prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.cc-console-(row|cursor)/.test(css.replace(/\n/g, ' ')), 'the terminal console cursor/rows respect prefers-reduced-motion');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
