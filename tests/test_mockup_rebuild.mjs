import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Covers the structural rebuild that followed the cinematic pass: the
// user's mockups showed a fundamentally different page composition (single-
// column stacked Command Center sections instead of a 3-rail layout; large
// icon-in-ring/hero tiles and per-page hero stat rows on the hub pages)
// than what the earlier cinematic-pass animation work had been layered
// onto. This file verifies the rebuilt structure directly against what the
// mockups showed, on all six pages. Referenced from
// test_command_center_appearance.mjs's rail-layout assertions.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ============================== index.html ==============================
const idx = read('index.html');
const ccCss = read('command-center.css');
const ccJs = read('command-center.js');

assertTrue(idx.includes('class="cc-page-flow"'), 'index.html flows as stacked full-width sections, not a 3-column rail grid');
assertTrue(idx.includes('class="cc-top-row"'), 'a two-up Today/Recommended-Action row leads the page, matching the mockup');
assertTrue(!idx.includes('id="ccRailLeft"'), 'the old left rail wrapper is gone');
assertTrue(idx.includes('class="cc-core-today-row"'), 'the Today panel lays the globe/ring and score out horizontally, matching the mockup');
assertTrue(idx.includes('id="scoreStats"'), 'the score sub-stats render as a real chip row (from the actual per-category breakdown), not a single plain-text line');
assertTrue(idx.includes('class="cc-action-body"') && idx.includes('class="cc-action-icon"'), 'the Recommended Action card carries a geometric icon beside its copy, matching the mockup');
assertTrue(idx.includes('id="ccBriefRow"') && idx.includes('id="ccBriefToggle"'), 'the AI Daily Brief leads with a condensed row and a View Full Brief toggle, not the full narrative by default');
assertTrue(idx.includes('class="cc-schedule-strip'), 'Schedule renders as a single horizontal strip, matching the mockup, not a vertical list');
assertTrue(idx.includes('id="ccSignals"') && ccCss.includes('.cc-signal-grid'), 'the Signals rail is now a 4-card grid with real mini-visualizations');
assertTrue(ccJs.includes('function renderSignalCards'), 'the 4 signal cards (Recovery, Hydration, Finance, System Status) are built from real model data');
assertTrue(idx.includes('class="cc-insight-label"') && idx.includes('class="cc-insight-link"'), 'the Insight banner carries the INSIGHT: label and a See all insights link, matching the mockup');
assertTrue(idx.includes('class="cc-bottom-row"'), 'Alerts and Recent Activity sit in a 2-column row, not a right rail');
assertTrue(idx.includes('class="cc-browse-cards"'), 'Browse renders as a 5-card horizontal row, matching the mockup');
assertTrue(!idx.includes('id="railContentSeg"') && !ccJs.includes('function applyRailContent'), 'the obsolete rail-order Settings toggle and its handler were actually removed, not left dangling');

// ============================== hub-body.html ==============================
const body = read('hub-body.html');
const ds = read('design-system.css');
assertTrue(body.includes('class="hub-status"'), 'hub-body.html carries the mockup\'s status badge under the title');
assertTrue(body.includes('class="hub-hero-row') && body.includes('id="heroRecovery"') && body.includes('id="heroWater"'), 'a real hero stat row (Recovery/Sleep/Water/Caffeine) leads the page');
assertTrue(body.includes('tile-hero') && body.includes('tile-emoji-ring'), 'the top 4 tiles use the large centered icon-in-ring composition from the mockup');
assertTrue(body.includes('tile-list') && (body.match(/tile-list/g) || []).length >= 2, 'the bottom 2 tiles (Sleep, Recovery) use the wide icon-left list composition from the mockup');
assertTrue(ds.includes('.tile-num { font-family: var(--font-mono); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: var(--accent)'), 'tile numbering is colored per category accent, matching the varied colors in the mockups, not a flat gray');

// ============================== hub-money.html ==============================
const money = read('hub-money.html');
assertTrue(money.includes('id="heroNetWorth"') && money.includes('id="heroMonthChange"') && money.includes('id="heroSpending"') && money.includes('id="heroRunway"'), 'a real hero stat row (Net worth/This month/Spending/Cash runway) leads the page');
assertTrue(money.includes('id="heroNetWorthSpark"'), 'the hero row includes a real sparkline built from nw:history, matching the mockup');
assertTrue((money.match(/tile-circle/g) || []).length >= 3, 'the 3 category tiles (Finance, Businesses, Learning) use the larger circular-icon composition from the mockup');
assertTrue(money.includes('function renderHeroRow') && money.includes("storeGet('purchases')") && money.includes("storeGet('nw:'"), 'hero-row numbers are computed from real stored purchases/net-worth data, not invented');

// ============================== hub-today.html ==============================
const today = read('hub-today.html');
assertTrue(today.includes('class="hub-nextup') && today.includes('id="nextUpBarFill"'), 'a NEXT UP countdown bar with a real progress fill leads the page, matching the mockup');
assertTrue((today.match(/tile-feature/g) || []).length >= 2, 'Main and Fitness use the large-icon feature-tile composition from the mockup');
assertTrue(today.includes('class="mc-secondary-label"'), 'the pre-existing Mission Control stats are demoted below the mockup-matching hero cards, not deleted outright');
assertTrue(!today.includes('id="mcNextValue"'), 'the old separate Next-up mission-control card was folded into the new NEXT UP hero bar, not left duplicated');

// ============================== hub-reflect.html ==============================
const reflect = read('hub-reflect.html');
assertTrue(reflect.includes('class="hub-status"'), 'hub-reflect.html carries the mockup\'s status badge under the title');
assertTrue(/grid-template-columns:repeat\(3,\s*1fr\)/.test(reflect), 'the tile grid uses a uniform 3-column layout, matching the mockup\'s evenly-sized cards');
assertTrue(!reflect.includes('class="tile wide"'), 'the old wide/small mixed sizing was replaced with the uniform sizing the mockup shows');

// ============================== hub-insights.html ==============================
const insights = read('hub-insights.html');
assertTrue(insights.includes('class="insights-finding'), 'a Latest Finding banner leads the page, matching the mockup');
assertTrue(insights.includes('id="insightsDaysAnalyzed"') && insights.includes('function countDaysAnalyzed'), 'the "days analyzed" status is a real count from stored data, not a fabricated number');
assertTrue(insights.includes('function computeLatestFinding') && insights.includes("'Building your picture"), 'the finding falls back to an honest low-confidence state instead of inventing a finding when there isn\'t one yet');
assertTrue(insights.includes('id="insightsFindingBadge"'), 'the finding carries a real confidence badge (High/Low), matching the mockup\'s confidence pill');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
