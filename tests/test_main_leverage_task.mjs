// Standalone verification of main.html's Daily Leverage Task toggle logic
// (exactly one leverage task allowed per day's goal list). main.html has
// no module exports (plain inline script), so this duplicates the exact
// function to test it in isolation — same approach as insights.html's
// test_insights_*.mjs files.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}

function toggleLeverageTask(list, idx) {
  if (!list[idx]) return list;
  const turningOn = !list[idx].leverage;
  list.forEach(g => { delete g.leverage; });
  if (turningOn) list[idx].leverage = true;
  return list;
}

// ==================== toggleLeverageTask ====================
{
  const list = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  toggleLeverageTask(list, 1);
  assertEq(list.map(g => !!g.leverage), [false, true, false], 'marking an item with none previously set turns just that one on');
}

{
  const list = [{ text: 'a' }, { text: 'b', leverage: true }, { text: 'c' }];
  toggleLeverageTask(list, 1);
  assertEq(list.map(g => !!g.leverage), [false, false, false], 'clicking the already-active item toggles it off, leaving none active');
}

{
  const list = [{ text: 'a' }, { text: 'b', leverage: true }, { text: 'c' }];
  toggleLeverageTask(list, 2);
  assertEq(list.map(g => !!g.leverage), [false, false, true], 'marking a different item clears the previous pick, keeping exactly one active');
}

{
  const list = [{ text: 'a' }];
  const result = toggleLeverageTask(list, 5);
  assertEq(result, list, 'an out-of-range index is a no-op and returns the list unchanged');
  assertEq(list[0].leverage, undefined, 'no item gains a leverage flag from an out-of-range index');
}

{
  const list = [];
  const result = toggleLeverageTask(list, 0);
  assertEq(result, [], 'an empty list is a no-op, not a crash');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
