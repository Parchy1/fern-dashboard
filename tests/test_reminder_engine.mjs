import handler, {
  effectiveTimeMinutes, shouldSendNow, composeSingleMessage, computeOneOffTimedUndone,
  shouldSendFeelingCheckin, computeUndone,
} from '../api/send-reminders.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function mockRes() {
  const res = { _status: null, _body: null };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}
function minToHM(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function nowMinUtc() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

(async () => {
  const origFetch = global.fetch;
  const BEDTIME = 23 * 60; // 23:00 -> 1380 minutes

  // ============================================================
  // effectiveTimeMinutes — pure, no clock involved
  // ============================================================
  {
    const eff = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20');
    assertTrue(Math.abs(eff - 18 * 60) <= 10, 'explicit time honored within jitter bounds (+/-10min): got ' + eff);

    const effAM = effectiveTimeMinutes('Skin care (AM)', null, BEDTIME, '2026-07-20');
    assertTrue(Math.abs(effAM - 8 * 60) <= 10, 'no explicit time + "(AM)" in name defaults near 8:00am: got ' + effAM);

    const effPM = effectiveTimeMinutes('Skin care (PM)', null, BEDTIME, '2026-07-20');
    assertTrue(Math.abs(effPM - (BEDTIME - 30)) <= 10, 'no explicit time + "(PM)" in name defaults near 30min before bedtime: got ' + effPM + ' vs bedtime-30=' + (BEDTIME - 30));

    const effGeneric = effectiveTimeMinutes('Clean up room (no time set)', null, BEDTIME, '2026-07-20');
    assertEq(effGeneric, null, 'a generic name with no explicit time and no AM/PM hint returns null (goes to catch-all)');

    const effDeterministic1 = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20');
    const effDeterministic2 = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20');
    assertEq(effDeterministic1, effDeterministic2, 'same (name, time, bedtime, date) always produces the same jittered result — reproducible, not truly random');

    const effDifferentDay = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-21');
    assertTrue(Math.abs(effDifferentDay - 18 * 60) <= 10, 'a different date still stays within jitter bounds (may differ from another day, still bounded): got ' + effDifferentDay);
  }

  // ============================================================
  // shouldSendNow — pure decision logic
  // ============================================================
  {
    assertEq(shouldSendNow(null, 100, 120, BEDTIME), false, 'not due before its effective time (now=100 < eff=120)');
    assertEq(shouldSendNow(null, 120, 120, BEDTIME), true, 'due exactly at its effective time with no prior state (first reminder)');
    assertEq(shouldSendNow(null, 200, 120, BEDTIME), true, 'due any time after its effective time with no prior state');

    const justReminded = { count: 1, lastMinutes: 200 };
    assertEq(shouldSendNow(justReminded, 210, 120, BEDTIME), false, 'not due again 10 min after being reminded (renag interval is 90 min)');
    assertEq(shouldSendNow(justReminded, 200 + 90, 120, BEDTIME), true, 'due again exactly at the 90-minute renag interval');
    assertEq(shouldSendNow(justReminded, 200 + 200, 120, BEDTIME), true, 'due again well past the renag interval');

    assertEq(shouldSendNow(null, BEDTIME, 120, BEDTIME), false, 'never due once now has reached bedtime, even with no prior state');
    assertEq(shouldSendNow(justReminded, BEDTIME + 30, 120, BEDTIME), false, 'stops nagging past bedtime even if still undone');
  }

  // ============================================================
  // composeSingleMessage — varies by nag count, deterministic
  // ============================================================
  {
    const first = composeSingleMessage('Gym', '2026-07-20', 0);
    const again = composeSingleMessage('Gym', '2026-07-20', 0);
    assertEq(first, again, 'same (name, date, count) always composes the same message');
    assertTrue(first.toLowerCase().includes('gym'), 'composed message actually mentions the item name: "' + first + '"');

    const variants = new Set([0, 1, 2, 3, 4, 5].map(c => composeSingleMessage('Gym', '2026-07-20', c)));
    assertTrue(variants.size > 1, 'different nag counts produce at least some varied phrasing (not the identical line every re-nag)');
  }

  // ============================================================
  // computeOneOffTimedUndone
  // ============================================================
  {
    const goalsData = {
      'goals:2026-07-20': [
        { text: 'Buy milk', done: false, time: '11:00' },
        { text: 'Already done thing', done: true, time: '12:00' },
        { text: 'No time set', done: false },
        { text: 'Gym', done: false, time: '18:00' }, // matches a recur def name below — should be excluded
      ],
    };
    const defs = [{ id: 'r1', name: 'Gym', freq: 'daily' }];
    const result = computeOneOffTimedUndone(goalsData, '2026-07-20', defs);
    assertEq(result, [{ name: 'Buy milk', time: '11:00' }], 'only surfaces undone, timed, non-recurring one-off goals');
  }

  // ============================================================
  // Full handler integration
  // ============================================================
  const nowMin = nowMinUtc();
  const pastTime = minToHM(Math.max(0, nowMin - 45));
  const bedtimeFuture = minToHM(Math.min(1439, nowMin + 180));

  // peakData defaults to a just-now check-in so the independent periodic
  // feeling-check-in reminder (tested separately below) never fires inside
  // tests that are really about something else.
  function fakeSupabase({ recurDefs = [], oneOffGoals = [], stateRow = null, peakData = { 'peak:checkins': [{ ts: Date.now() }] } } = {}) {
    let writtenState = null;
    // Upserts (POST /rest/v1/app_state?on_conflict=key) carry the row key
    // inside the JSON body, not the URL query string — only GET reads use
    // `?key=eq.<key>`. Check the method + body, not the URL, for writes.
    const fetchStub = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && u.includes('/rest/v1/app_state')) {
        const body = JSON.parse(opts.body);
        if (body.key === 'reminder_state') writtenState = body.data;
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('key=eq.goals')) {
        return { ok: true, json: async () => [{ data: { 'recur:defs': recurDefs, ['goals:' + '__ignored__']: [] } }] };
      }
      if (u.includes('key=eq.reminder_state')) {
        return { ok: true, json: async () => (stateRow ? [{ data: stateRow }] : []) };
      }
      if (u.includes('key=eq.peak')) {
        return { ok: true, json: async () => (peakData ? [{ data: peakData }] : []) };
      }
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      throw new Error('unexpected fetch: ' + u);
    };
    return { fetchStub, getWrittenState: () => writtenState };
  }

  // ---- an item whose time has passed and never reminded today: fires an individual message ----
  {
    process.env.TELEGRAM_BOT_TOKEN = 'tok'; process.env.TELEGRAM_CHAT_ID = '123';
    process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon';
    process.env.REMINDER_TIMEZONE = 'UTC';
    process.env.BEDTIME_LOCAL = bedtimeFuture;
    delete process.env.CRON_SECRET;

    // goalsData needs today's actual dateKey (6am boundary in UTC) — reconstruct precisely like the handler does.
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();

    const { fetchStub, getWrittenState } = fakeSupabase({
      recurDefs: [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: pastTime }],
    });
    global.fetch = fetchStub;
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._status, 200, 'handler returns 200');
    assertEq(res._body.sent, true, 'an overdue item triggers a send');
    assertEq(res._body.results.length, 1, 'exactly one individual reminder sent');
    assertEq(res._body.results[0].name, 'Gym', 'correct item named in the result');
    const written = getWrittenState();
    assertTrue(!!written && !!written[todayKey6amActual] && written[todayKey6amActual].Gym && written[todayKey6amActual].Gym.count === 1, 'reminder state persisted with count=1 after the first send: ' + JSON.stringify(written));
  }

  // ---- same item, reminded again immediately (before renag interval): does NOT re-send ----
  {
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    const stateRow = { [todayKey6amActual]: { Gym: { count: 1, lastMinutes: nowMin - 5 } } };
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: pastTime }] } }] };
      if (u.includes('key=eq.reminder_state')) return { ok: true, json: async () => [{ data: stateRow }] };
      if (u.includes('key=eq.peak')) return { ok: true, json: async () => [{ data: { 'peak:checkins': [{ ts: Date.now() }] } }] };
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, false, 'already-reminded-recently item does not trigger a second send within the renag window');
  }

  // ---- past bedtime: no sends at all, even for a never-reminded overdue item ----
  {
    process.env.BEDTIME_LOCAL = minToHM(Math.max(0, nowMin - 60)); // bedtime already passed
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: pastTime }] } }] };
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, false, 'nothing sends once the current time is past bedtime');
    process.env.BEDTIME_LOCAL = bedtimeFuture;
  }

  // ---- CRON_SECRET gating still works ----
  {
    process.env.CRON_SECRET = 'shh';
    global.fetch = async () => { throw new Error('should not fetch anything before auth check'); };
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._status, 401, 'missing Authorization header is rejected with 401 when CRON_SECRET is set');
    delete process.env.CRON_SECRET;
  }

  // ---- catch-all digest: a generic (no-time, no AM/PM) recurring item only
  // fires once near bedtime, and not a second time later the same day ----
  {
    process.env.CRON_SECRET && delete process.env.CRON_SECRET;
    // Clamped (not wrapped past midnight) — BEDTIME_LOCAL is a same-day HH:MM
    // cutoff, so wrapping past 23:59 back to e.g. 00:15 would make it look
    // like bedtime already passed hours ago instead of "coming up soon"
    // whenever this test happens to run near midnight UTC.
    const bedtimeSoon = minToHM(Math.min(1439, nowMin + 20)); // catch-all fires at bedtime-30, so bedtime 20min out means catch-all window already open
    process.env.BEDTIME_LOCAL = bedtimeSoon;
    const { fetchStub, getWrittenState } = fakeSupabase({
      recurDefs: [{ id: 'r1', name: 'Clean up room', freq: 'daily', days: null, autoSource: null, time: null }],
    });
    global.fetch = fetchStub;
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, true, 'a generic untimed item triggers the catch-all digest once bedtime is close enough');
    assertEq(res._body.results.length, 1, 'exactly one catch-all message sent (not one per generic item)');
    assertEq(res._body.results[0].name, '__catchall__', 'the catch-all result is tagged distinctly from individual item reminders');
    assertEq(res._body.results[0].items, ['Clean up room'], 'the catch-all lists the correct generic item(s)');
    const written = getWrittenState();
    const todayKey6amActual = Object.keys(written)[0];
    assertEq(written[todayKey6amActual].__catchall__, true, 'catch-all-sent flag persisted in state');

    // Second tick the same day: catch-all should NOT fire again.
    const { fetchStub: fetchStub2 } = fakeSupabase({
      recurDefs: [{ id: 'r1', name: 'Clean up room', freq: 'daily', days: null, autoSource: null, time: null }],
      stateRow: written[todayKey6amActual] ? { [todayKey6amActual]: written[todayKey6amActual] } : null,
    });
    // fakeSupabase's stateRow option wraps the whole row already keyed by date — pass it through as-is.
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.reminder_state') && (!opts || opts.method !== 'POST')) return { ok: true, json: async () => [{ data: written }] };
      return fetchStub2(url, opts);
    };
    const res2 = mockRes();
    await handler({ headers: {} }, res2);
    assertEq(res2._body.sent, false, 'the catch-all digest does not fire a second time the same day once already sent');
  }

  // ============================================================
  // shouldSendFeelingCheckin — pure, no clock involved
  // ============================================================
  {
    const BED = 23 * 60;
    assertEq(shouldSendFeelingCheckin(null, 8 * 60, BED, null), false, 'not due before 9am even with nothing else going on');
    assertEq(shouldSendFeelingCheckin(null, 10 * 60, BED, null), true, 'due mid-morning with no prior check-ins/prompts at all');
    assertEq(shouldSendFeelingCheckin(null, BED, BED, null), false, 'never due once at/past bedtime');

    const recentCheckin = { 'peak:checkins': [{ ts: Date.now() - 30 * 60 * 1000 }] }; // 30 min ago
    assertEq(shouldSendFeelingCheckin(recentCheckin, 12 * 60, BED, null), false, 'suppressed by a real check-in logged within the interval, even with no prior prompt');

    const oldCheckin = { 'peak:checkins': [{ ts: Date.now() - 5 * 60 * 60 * 1000 }] }; // 5 hours ago
    assertEq(shouldSendFeelingCheckin(oldCheckin, 12 * 60, BED, null), true, 'a check-in older than the interval (4h) does not suppress a new prompt');

    assertEq(shouldSendFeelingCheckin(null, 12 * 60, BED, { lastMinutes: 12 * 60 - 60 }), false, 'suppressed by a prompt already sent within the interval, even with no real check-in');
    assertEq(shouldSendFeelingCheckin(null, 12 * 60, BED, { lastMinutes: 12 * 60 - 241 }), true, 'due again once the prompt interval (4h) has fully elapsed since the last prompt');
  }

  // ============================================================
  // peak_morning autoSource via computeUndone
  // ============================================================
  {
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    const todayPlainActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate());
    })();
    const goalsData = { 'recur:defs': [{ id: 'rc10', name: 'Morning Check-In', freq: 'daily', days: null, autoSource: 'peak_morning' }] };
    const fetchers = { goalsData, healthData: {}, gymData: {}, businessData: {}, readingData: {}, todayKey6am: todayKey6amActual, todayPlain: todayPlainActual, dow: new Date().getDay(), utcToday: new Date().toISOString().slice(0, 10) };

    const notDoneYet = await computeUndone(Object.assign({}, fetchers, { peakData: {} }));
    assertEq(notDoneYet, ['Morning Check-In'], 'Morning Check-In is undone when peak:morning has no entry for today');

    const alreadyDone = await computeUndone(Object.assign({}, fetchers, { peakData: { 'peak:morning': { [todayPlainActual]: { wakeTime: '07:30', ts: Date.now() } } } }));
    assertEq(alreadyDone, [], 'Morning Check-In is NOT undone once peak:morning has today\'s entry (peak_morning autoSource correctly wired)');
  }

  // ============================================================
  // Full handler: feeling check-in fires and is tracked in state
  // ============================================================
  {
    process.env.CRON_SECRET && delete process.env.CRON_SECRET;
    process.env.BEDTIME_LOCAL = bedtimeFuture; // comfortably in the future, per the earlier nowMin/bedtimeFuture setup
    let sentBody = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: {} }] };
      if (u.includes('key=eq.peak')) return { ok: true, json: async () => [{ data: {} }] }; // no check-ins logged at all today
      if (u.includes('key=eq.reminder_state')) return { ok: true, json: async () => [] };
      if (opts && opts.method === 'POST' && u.includes('/rest/v1/app_state')) return { ok: true, json: async () => ({}) };
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      if (u.includes('sendMessage')) { sentBody = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ headers: {} }, res);
    // Only assert this if the real current time is within the 9am-bedtime window —
    // otherwise (e.g. a test run at 3am) it's correctly not due, which is fine.
    if (nowMin >= 9 * 60 && nowMin < parseInt(bedtimeFuture.slice(0, 2), 10) * 60 + parseInt(bedtimeFuture.slice(3), 10)) {
      assertEq(res._body.sent, true, 'a feeling check-in prompt sends when nothing has been logged today and it is past 9am');
      assertTrue(!!sentBody && sentBody.length > 0, 'the feeling check-in message actually has content');
      assertTrue(res._body.results.some(r => r.name === '__feeling_checkin__'), 'the result is tagged distinctly as the feeling check-in');
    }
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
