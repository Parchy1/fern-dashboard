import handler from '../api/google-token-sync.js';

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

(async () => {
  const origFetch = global.fetch;
  process.env.GOOGLE_SYNC_SECRET = 'sync-secret-123';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-xyz';

  // ---- wrong method rejected ----
  {
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    assertEq(res._status, 405, 'GET is rejected — this endpoint is write-only');
  }

  // ---- missing/wrong secret rejected ----
  {
    let res = mockRes();
    await handler({ method: 'POST', headers: {}, body: {} }, res);
    assertEq(res._status, 401, 'missing Authorization header is rejected with 401');

    res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer wrong-secret' }, body: { access: 'tok' } }, res);
    assertEq(res._status, 401, 'wrong secret is rejected with 401');
  }

  // ---- missing access token rejected ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer sync-secret-123' }, body: {} }, res);
    assertEq(res._status, 400, 'missing access token in body is rejected with 400');
  }

  // ---- successful write uses the SERVICE ROLE key, never the public anon key ----
  {
    let captured = null;
    global.fetch = async (url, opts) => { captured = { url: String(url), opts }; return { ok: true, json: async () => ({}) }; };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer sync-secret-123' }, body: { access: 'access-tok', refresh: 'refresh-tok', expires: 12345 } }, res);
    assertEq(res._status, 200, 'valid write returns 200');
    assertTrue(captured.url.includes('/rest/v1/google_tokens'), 'writes to the dedicated google_tokens table, not app_state');
    assertEq(captured.opts.headers.apikey, 'service-role-key-xyz', 'uses SUPABASE_SERVICE_ROLE_KEY as the apikey header — NOT the public anon key');
    assertEq(captured.opts.headers.Authorization, 'Bearer service-role-key-xyz', 'uses SUPABASE_SERVICE_ROLE_KEY as the bearer token too');
    const sentBody = JSON.parse(captured.opts.body);
    assertEq(sentBody.id, 1, 'always writes to the single fixed row id=1 (single-user table)');
    assertEq(sentBody.access, 'access-tok', 'access token forwarded correctly');
    assertEq(sentBody.refresh, 'refresh-tok', 'refresh token forwarded correctly');
    assertEq(sentBody.expires, 12345, 'expires forwarded correctly');
  }

  // ---- Supabase write failure surfaces a clear error, not a silent 200 ----
  {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'db error' });
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer sync-secret-123' }, body: { access: 'a' } }, res);
    assertEq(res._status, 500, 'a failed Supabase write surfaces as a 500, not a false success');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
