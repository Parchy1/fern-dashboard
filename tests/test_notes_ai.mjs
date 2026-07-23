import handler from '../api/notes-ai.js';

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
  res.send = (b) => { res._body = b; return res; };
  res.end = () => { return res; };
  res.setHeader = () => {};
  return res;
}

(async () => {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.NOTES_EMBED_SECRET = 'shh-notes-secret';
  process.env.OPENAI_API_KEY = 'openai-key-1';
  process.env.ANTHROPIC_API_KEY = 'anthropic-key-1';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key-1';

  // ---- method/auth guards ----
  {
    const res = mockRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    assertEq(res._status, 204, 'OPTIONS returns 204');

    const res2 = mockRes();
    await handler({ method: 'GET', headers: {} }, res2);
    assertEq(res2._status, 405, 'GET is rejected with 405');

    const res3 = mockRes();
    await handler({ method: 'POST', headers: {}, body: { action: 'reflect', text: 'hi' } }, res3);
    assertEq(res3._status, 401, 'missing Authorization header is 401');

    const res4 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer wrong' }, body: {} }, res4);
    assertEq(res4._status, 401, 'wrong bearer secret is 401');
  }

  // ---- unknown action ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'nonsense' } }, res);
    assertEq(res._status, 400, 'an unrecognized action is a 400');
  }

  // ---- voice-note: validation ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'voice-note' } }, res);
    assertEq(res._status, 400, 'missing audioBase64 is a 400');
    assertEq(res._body.error, 'missing audioBase64', 'the specific validation error is surfaced');
  }

  // ---- voice-note: missing server config ----
  {
    delete process.env.OPENAI_API_KEY;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'voice-note', audioBase64: 'aGVsbG8=' } }, res);
    assertEq(res._status, 500, 'missing OPENAI_API_KEY is a 500');
    process.env.OPENAI_API_KEY = 'openai-key-1';
  }

  // ---- voice-note: happy path (transcribe then polish) ----
  {
    let sawWhisperCall = false, sawClaudeCall = false, whisperAuth = null, claudeAuth = null, claudeSystem = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('api.openai.com/v1/audio/transcriptions')) {
        sawWhisperCall = true;
        whisperAuth = opts.headers.authorization;
        return { ok: true, json: async () => ({ text: 'um so today was uh pretty good i think' }) };
      }
      if (u.includes('api.anthropic.com/v1/messages')) {
        sawClaudeCall = true;
        claudeAuth = opts.headers['x-api-key'];
        claudeSystem = JSON.parse(opts.body).system;
        return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Today was pretty good, I think.' }] }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'voice-note', audioBase64: 'aGVsbG8=', mimeType: 'audio/webm' } }, res);
    assertEq(res._status, 200, 'a valid voice-note request returns 200');
    assertTrue(sawWhisperCall, 'calls OpenAI Whisper to transcribe the audio');
    assertEq(whisperAuth, 'Bearer openai-key-1', 'Whisper call uses OPENAI_API_KEY');
    assertTrue(sawClaudeCall, 'calls Claude to polish the raw transcript');
    assertEq(claudeAuth, 'anthropic-key-1', 'Claude call uses ANTHROPIC_API_KEY');
    assertTrue(claudeSystem.includes('Rewrite the following raw speech-to-text transcript'), 'the polish system prompt is used, not the reflect one');
    assertEq(res._body.transcript, 'um so today was uh pretty good i think', 'the raw transcript is returned alongside the polished text');
    assertEq(res._body.polished, 'Today was pretty good, I think.', 'the polished text is returned');
  }

  // ---- voice-note: a blank transcript skips the polish call entirely ----
  {
    let claudeCalled = false;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('audio/transcriptions')) return { ok: true, json: async () => ({ text: '   ' }) };
      claudeCalled = true;
      throw new Error('should not reach Claude for a blank transcript');
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'voice-note', audioBase64: 'aGVsbG8=' } }, res);
    assertEq(res._status, 200, 'a blank transcript still returns 200');
    assertEq(res._body.polished, '', 'no polished text when nothing was said');
    assertTrue(!claudeCalled, 'Claude is never called for an empty transcript');
  }

  // ---- reflect: validation ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'reflect', text: '' } }, res);
    assertEq(res._status, 400, 'missing text is a 400');
  }

  // ---- reflect: missing server config ----
  {
    delete process.env.ANTHROPIC_API_KEY;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'reflect', text: 'rough day' } }, res);
    assertEq(res._status, 500, 'missing ANTHROPIC_API_KEY is a 500');
    process.env.ANTHROPIC_API_KEY = 'anthropic-key-1';
  }

  // ---- reflect: happy path, pulls in dashboard context ----
  {
    let claudeUserMsg = null, claudeSystem = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/')) return { ok: true, json: async () => ({}) }; // buildContext's readRow calls
      if (u.includes('api.anthropic.com/v1/messages')) {
        const parsed = JSON.parse(opts.body);
        claudeUserMsg = parsed.messages[0].content;
        claudeSystem = parsed.system;
        return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'That sounds like a lot to carry today.' }] }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'reflect', text: 'rough day at work' } }, res);
    assertEq(res._status, 200, 'a valid reflect request returns 200');
    assertEq(res._body.reflection, 'That sounds like a lot to carry today.', 'the reflection text is returned');
    assertTrue(claudeUserMsg.includes('rough day at work'), 'the note text is included in the prompt sent to Claude');
    assertTrue(claudeUserMsg.includes('Background context on my life'), 'dashboard context is included in the prompt, not just the bare note text');
    assertTrue(claudeSystem.includes('journaling companion'), 'the reflect system prompt is used, not the polish one');
    assertTrue(claudeSystem.includes('crisis line'), 'the safety guardrail language is present in the system prompt');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
