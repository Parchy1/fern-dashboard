import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'design-system.css'), 'utf8');
const searchPage = readFileSync(path.join(root, 'search.html'), 'utf8');

let pass = 0, fail = 0;
function assertTrue(condition, label) {
  if (condition) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label); }
}

for (const token of [
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-full',
  '--shadow-sm', '--shadow-md', '--shadow-glow',
  '--z-topbar', '--z-command-bar', '--z-modal', '--z-lock',
]) {
  assertTrue(css.includes(token + ':'), token + ' is defined in the shared design system');
}

for (const selector of ['a:focus-visible', 'button:focus-visible', 'input:focus-visible', 'select:focus-visible', 'textarea:focus-visible']) {
  assertTrue(css.includes(selector), selector + ' receives a shared keyboard focus treatment');
}

assertTrue(css.includes('@media (prefers-reduced-motion: reduce)'), 'the shared design system has a reduced-motion mode');
for (const futureComponent of ['.cc-ai-core', '.cc-alert', '.cc-activity-item', '.cc-now-marker', '.command-bar', '.focus-mode']) {
  assertTrue(css.includes(futureComponent), futureComponent + ' is covered before its Phase 1 animation ships');
}

assertTrue(searchPage.includes('type="module"'), 'search.html loads its wiring as a browser module');
assertTrue(searchPage.includes("from './search-index.js'"), 'search.html consumes the extracted shared search module');
assertTrue(!searchPage.includes('function normalizeNotes('), 'search.html no longer carries a second inline copy of search normalization');
assertTrue(searchPage.includes('window.__searchLogic'), 'the existing browser debug/test hook remains available');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
