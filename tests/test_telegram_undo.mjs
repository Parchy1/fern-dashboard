// undo_last_action: patchRow() transparently snapshots the pre-mutation
// state of whichever row it just touched into a 'last_action' row, and
// undo_last_action reverts to that snapshot — verified here across
// multiple different tools/rows to confirm it's genuinely generic (wired
// into the shared patchRow helper), not special-cased per tool.
import { TOOL_EXECUTORS } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function makeFakeSupabase(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('/rest/v1/app_state')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const m = u.match(/key=eq\.([^&]+)/);
        const key = decodeURIComponent(m[1]);
        return { ok: true, json: async () => [{ data: rows[key] || {} }] };
      }
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        return { ok: true, json: async () => ({}) };
      }
    }
    throw new Error('unexpected fetch: ' + u);
  }
  return { rows, fetchStub };
}

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';

  // ==================== nothing to undo yet ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.undo_last_action();
    assertEq(result.ok, false, 'undo_last_action reports failure when nothing has been done yet');
  }

  // ==================== undoing a purchase log ====================
  {
    const fake = makeFakeSupabase({ finance: { purchases: [{ name: 'Existing', amount: 10 }] } });
    global.fetch = fake.fetchStub;

    await TOOL_EXECUTORS.log_purchase({ name: 'Accidental purchase', amount: 999, currency: 'USD' });
    assertEq(fake.rows.finance.purchases.length, 2, 'the purchase was actually logged');

    const undo = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo.ok, true, 'undo_last_action succeeds');
    assertEq(fake.rows.finance.purchases, [{ name: 'Existing', amount: 10 }], 'the finance row is reverted to exactly its state before the accidental purchase — the existing entry survives, the new one is gone');
  }

  // ==================== undo reverts whichever row was touched most recently, across different tools ====================
  {
    const fake = makeFakeSupabase({
      'po-coach': { po_coach_workout_done: {} },
      goals: { 'habits:defs': [{ id: 'h1', name: 'Meditate' }], 'habits:log': {} },
    });
    global.fetch = fake.fetchStub;

    await TOOL_EXECUTORS.mark_gym_done();
    assertTrue(Object.keys(fake.rows['po-coach'].po_coach_workout_done).length === 1, 'gym marked done');

    await TOOL_EXECUTORS.mark_habit_done({ habit: 'meditate' });
    assertTrue(Object.keys(fake.rows.goals['habits:log'].h1 || {}).length === 1, 'habit marked done');

    // Only the LAST action (mark_habit_done, touching 'goals') should be undone — mark_gym_done's change to 'po-coach' must survive.
    const undo = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo.ok, true, 'undo_last_action succeeds');
    assertEq(Object.keys(fake.rows.goals['habits:log'].h1 || {}).length, 0, 'the habit mark (the most recent action) was undone');
    assertTrue(Object.keys(fake.rows['po-coach'].po_coach_workout_done).length === 1, 'the earlier gym mark (a different row) is untouched by undoing the habit action');
  }

  // ==================== undo is single-level, not a full history stack ====================
  {
    const fake = makeFakeSupabase({ notes: { 'notes:items': [] } });
    global.fetch = fake.fetchStub;

    const first = await TOOL_EXECUTORS.undo_last_action(); // consume the leftover state from the prior test block? No — fresh fake, so nothing yet.
    assertEq(first.ok, false, 'a fresh session with no actions yet has nothing to undo');

    await TOOL_EXECUTORS.add_note({ body: 'Note A' });
    await TOOL_EXECUTORS.add_note({ body: 'Note B' });
    assertEq(fake.rows.notes['notes:items'].length, 2, 'both notes were added');

    const undo1 = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo1.ok, true, 'first undo succeeds');
    assertEq(fake.rows.notes['notes:items'].length, 1, 'only the most recent note (B) is removed by undo — A remains');
    assertEq(fake.rows.notes['notes:items'][0].body, 'Note A', 'the remaining note is the older one');

    // Calling undo again immediately must NOT also remove Note A — only one level of undo is kept.
    const undo2 = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo2.ok, false, 'a second consecutive undo reports nothing left to undo, rather than undoing further back');
    assertEq(fake.rows.notes['notes:items'].length, 1, 'Note A is untouched by the second undo attempt');
  }

  // ==================== a failed tool call does not overwrite the undo snapshot ====================
  {
    const fake = makeFakeSupabase({ goals: { 'recur:defs': [], [`goals:x`]: [] } });
    global.fetch = fake.fetchStub;

    await TOOL_EXECUTORS.add_todo({ text: 'A real todo' });
    const mismatchResult = await TOOL_EXECUTORS.mark_todo_done({ text: 'nonexistent thing entirely' });
    assertEq(mismatchResult.ok, false, 'the mark_todo_done call itself fails (no match)');

    const undo = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo.ok, true, 'undo is still available');
    assertEq(undo.undone, 'to-dos/habits/recurring items', 'undo reverts the last SUCCESSFUL action (adding the todo), not overwritten by the failed mark_todo_done call');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
