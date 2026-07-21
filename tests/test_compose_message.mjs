import { composeMessage } from '../api/send-reminders.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ---- Determinism: same undone list + same date/hour -> byte-identical message ----
const msgA = composeMessage(['Gym', 'Water'], '2026-07-16', 14);
const msgB = composeMessage(['Gym', 'Water'], '2026-07-16', 14);
assertEq(msgA, msgB, 'same undone list + same date/hour composes an identical message (re-sends after a failure are reproducible, not confusingly different)');

// ---- Variety across hours: the SAME undone item gets different phrasing at different hours ----
const lines = new Set();
for (let h = 0; h < 24; h++) {
  const msg = composeMessage(['Gym'], '2026-07-16', h);
  lines.add(msg.split('\n')[1]); // the one item line, below the intro
}
assertTrue(lines.size >= 4, 'a single undone item (Gym) gets meaningfully varied phrasing across different hours of the day, got ' + lines.size + ' distinct lines');

// ---- Variety across days: same hour, different day -> also varies ----
const dayLines = new Set();
for (let d = 1; d <= 28; d++) {
  const dk = '2026-07-' + String(d).padStart(2, '0');
  dayLines.add(composeMessage(['Gym'], dk, 14).split('\n')[1]);
}
assertTrue(dayLines.size >= 4, 'the same item at the same hour still varies across different days, got ' + dayLines.size + ' distinct lines');

// ---- Category-specific phrasing: different item types get contextually different lines, not the same generic line ----
const gymLine = composeMessage(['Gym'], '2026-07-16', 10).split('\n')[1];
const waterLine = composeMessage(['Water'], '2026-07-16', 10).split('\n')[1];
const readingLine = composeMessage(['Read'], '2026-07-16', 10).split('\n')[1];
assertTrue(gymLine !== waterLine && waterLine !== readingLine && gymLine !== readingLine, 'Gym/Water/Read each get distinct category-specific phrasing at the same date+hour: "' + gymLine + '" / "' + waterLine + '" / "' + readingLine + '"');

// ---- Multiple simultaneous undone items each get their OWN line, not one flat comma list ----
const multi = composeMessage(['Gym', 'Read', 'Clean up room'], '2026-07-16', 9);
const multiLines = multi.split('\n');
assertEq(multiLines.length, 4, 'intro line + one line per undone item (3 items -> 4 total lines), got ' + multiLines.length);
assertTrue(multiLines[1].includes('Gym'), 'first item line mentions Gym: "' + multiLines[1] + '"');
assertTrue(multiLines[2].toLowerCase().includes('read'), 'second item line mentions Read: "' + multiLines[2] + '"');
assertTrue(multiLines[3].toLowerCase().includes('clean up room'), 'third item line mentions the custom item name verbatim: "' + multiLines[3] + '"');

// ---- Custom/unrecognized item names still get a sensible generic line rather than crashing or silently omitting the name ----
const customLine = composeMessage(['Learn Spanish'], '2026-07-16', 11).split('\n')[1];
assertTrue(customLine.toLowerCase().includes('learn spanish'), 'a custom item name with no keyword match still appears verbatim in the fallback phrasing: "' + customLine + '"');

// ---- "Work on side hustles" is correctly categorized as side-hustle phrasing, not generic "work" phrasing ----
// (regression check: the word "work" appears inside this name too, so the side-hustle keyword check must win)
const hustleLine = composeMessage(['Work on side hustles'], '2026-07-16', 13).split('\n')[1];
const plainWorkLine = composeMessage(['Work'], '2026-07-16', 13).split('\n')[1];
assertTrue(hustleLine !== plainWorkLine, '"Work on side hustles" (side-hustle category) is phrased differently than plain "Work" (work category): "' + hustleLine + '" vs "' + plainWorkLine + '"');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
