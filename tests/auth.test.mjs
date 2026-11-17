import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseToken, saveToken, loadToken, authStatus, logout,
} from '../scripts/lib/auth.mjs';
import {
  tmpDir, rejectsCode, throwsCode, NOW, DAY, makeToken, goodToken, GOOD_EXP_SEC, errText,
  liveToken, fakeFetch, emptyRes, jsonRes, headersOf, assertNoSignoutAll,
} from './helpers.mjs';

const now = () => NOW;
const b64url = (s) => Buffer.from(s).toString('base64url');
const authFile = (dir) => path.join(dir, 'auth.json');
const writeAuth = (dir, data) => fs.writeFile(authFile(dir), JSON.stringify(data));

// ---- parseToken ----

test('parseToken: valid token gives token and exp in ms', () => {
  const t = goodToken();
  assert.deepEqual(parseToken(t), { token: t, exp: GOOD_EXP_SEC * 1000 });
});

test('parseToken: trims spaces and newline around the token', () => {
  const t = goodToken();
  assert.equal(parseToken(`  ${t}\n`).token, t);
});

test('parseToken: k_jwt= prefix and trailing ; are dropped', () => {
  const t = goodToken();
  assert.equal(parseToken(`k_jwt=${t}`).token, t);
  assert.equal(parseToken(`${t};`).token, t);
  assert.equal(parseToken(`k_jwt=${t};\n`).token, t);
});

test('parseToken: non-string input is stringified, not crashed on', () => {
  throwsCode(() => parseToken(undefined), 'BAD_TOKEN');
  throwsCode(() => parseToken(null), 'BAD_TOKEN');
});

const badInputs = {
  garbage: 'this is not a token',
  empty: '',
  'one part': 'abcdef',
  'two parts': `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ exp: GOOD_EXP_SEC }))}`,
  'four parts': `${goodToken()}.extra`,
  'empty part': `${b64url('{"alg":"none"}')}..sig`,
  'empty last part': `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ exp: GOOD_EXP_SEC }))}.`,
  'payload not JSON': `${b64url('{"alg":"none"}')}.${b64url('this is not json')}.sig`,
  'payload is array': `${b64url('{"alg":"none"}')}.${b64url('[1,2]')}.sig`,
  'payload is null': `${b64url('{"alg":"none"}')}.${b64url('null')}.sig`,
  'no exp': `${b64url('{"alg":"none"}')}.${b64url('{"sub":"x"}')}.sig`,
  'exp is string': `${b64url('{"alg":"none"}')}.${b64url('{"exp":"123"}')}.sig`,
  'char outside alphabet': `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ exp: GOOD_EXP_SEC }))}.si+g`,
  'newline inside': `${goodToken()}\nmore`,
  'space inside': `${goodToken()} more`,
};

for (const [name, raw] of Object.entries(badInputs)) {
  test(`parseToken: ${name} is BAD_TOKEN and the error does not echo the input`, () => {
    let err;
    try { parseToken(raw); } catch (e) { err = e; }
    assert.ok(err, 'must throw');
    assert.equal(err.name, 'KufarError');
    assert.equal(err.code, 'BAD_TOKEN');
    const text = errText(err);
    if (raw.trim()) assert.ok(!text.includes(raw.trim()), 'error contains the input');
    for (const part of raw.trim().split('.').filter((p) => p.length >= 4)) {
      assert.ok(!text.includes(part), `error contains a part of the input: ${part}`);
    }
  });
}

// ---- saveToken / loadToken / authStatus / logout ----

test('saveToken writes auth.json with mode 0600 and returns status without the token', async () => {
  const dir = await tmpDir();
  const t = goodToken();
  const status = await saveToken(dir, t, now);
  assert.deepEqual(status, {
    logged_in: true, expires_at: new Date(GOOD_EXP_SEC * 1000).toISOString(), days_left: 30,
  });
  assert.ok(!JSON.stringify(status).includes(t));
  const st = await fs.stat(authFile(dir));
  assert.equal(st.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(authFile(dir), 'utf8')), {
    token: t, exp: GOOD_EXP_SEC * 1000, saved_at: NOW,
  });
});

test('saveToken creates a missing state dir with mode 0700', async () => {
  const base = await tmpDir();
  const dir = path.join(base, 'nested', 'state');
  await saveToken(dir, goodToken(), now);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
});

test('saveToken stores the clean token when given k_jwt= and ;', async () => {
  const dir = await tmpDir();
  const t = goodToken();
  await saveToken(dir, `k_jwt=${t};`, now);
  assert.equal(JSON.parse(await fs.readFile(authFile(dir), 'utf8')).token, t);
});

test('saveToken: BAD_TOKEN writes nothing', async () => {
  const dir = await tmpDir();
  await rejectsCode(saveToken(dir, 'garbage', now), 'BAD_TOKEN');
  await assert.rejects(fs.stat(authFile(dir)), { code: 'ENOENT' });
});

test('saveToken: expired token is AUTH_EXPIRED and writes nothing', async () => {
  const dir = await tmpDir();
  await rejectsCode(saveToken(dir, makeToken(Math.floor((NOW - DAY) / 1000)), now), 'AUTH_EXPIRED');
  await assert.rejects(fs.stat(authFile(dir)), { code: 'ENOENT' });
});

test('saveToken: exp equal to now is AUTH_EXPIRED', async () => {
  const dir = await tmpDir();
  await rejectsCode(saveToken(dir, makeToken(NOW / 1000), now), 'AUTH_EXPIRED');
});

test('loadToken returns the saved token', async () => {
  const dir = await tmpDir();
  const t = goodToken();
  await saveToken(dir, t, now);
  assert.equal(await loadToken(dir, now), t);
});

test('loadToken: no file is AUTH_REQUIRED', async () => {
  await rejectsCode(loadToken(await tmpDir(), now), 'AUTH_REQUIRED');
});

test('loadToken: file without a token string is AUTH_REQUIRED', async () => {
  for (const data of [{}, { token: 5 }, { token: null }, { exp: GOOD_EXP_SEC * 1000 }]) {
    const dir = await tmpDir();
    await writeAuth(dir, data);
    await rejectsCode(loadToken(dir, now), 'AUTH_REQUIRED');
  }
});

test('loadToken: hand-edited token with a newline inside or not three parts is AUTH_REQUIRED', async () => {
  for (const token of [`${goodToken()}\nX-Evil: 1`, `${goodToken()}\nmore`, 'abc.def', 'garbage']) {
    const dir = await tmpDir();
    await writeAuth(dir, { token, exp: GOOD_EXP_SEC * 1000, saved_at: NOW });
    await rejectsCode(loadToken(dir, now), 'AUTH_REQUIRED');
  }
});

test('loadToken: expiry comes from the token, not from the exp field of the file', async () => {
  const expired = makeToken(Math.floor((NOW - DAY) / 1000));
  let dir = await tmpDir();
  await writeAuth(dir, { token: expired, exp: NOW + 10 * DAY, saved_at: NOW });
  await rejectsCode(loadToken(dir, now), 'AUTH_EXPIRED');

  const good = goodToken();
  dir = await tmpDir();
  await writeAuth(dir, { token: good, exp: NOW - DAY, saved_at: NOW });
  assert.equal(await loadToken(dir, now), good);
});

test('loadToken: token expiring exactly now is AUTH_EXPIRED', async () => {
  const dir = await tmpDir();
  await writeAuth(dir, { token: makeToken(NOW / 1000), exp: 0, saved_at: NOW });
  await rejectsCode(loadToken(dir, now), 'AUTH_EXPIRED');
});

test('authStatus: no file is logged_in false', async () => {
  assert.deepEqual(await authStatus(await tmpDir(), now), { logged_in: false });
});

test('authStatus: days_left is floored and expires_at is ISO', async () => {
  const dir = await tmpDir();
  const expMs = NOW + 3 * DAY + 5 * 3_600_000;
  await writeAuth(dir, { token: makeToken(expMs / 1000), exp: 0, saved_at: NOW });
  assert.deepEqual(await authStatus(dir, now), {
    logged_in: true, expires_at: new Date(expMs).toISOString(), days_left: 3,
  });
});

test('authStatus: less than a day left gives days_left 0', async () => {
  const dir = await tmpDir();
  await writeAuth(dir, { token: makeToken((NOW + 3_600_000) / 1000), exp: 0, saved_at: NOW });
  const s = await authStatus(dir, now);
  assert.equal(s.logged_in, true);
  assert.equal(s.days_left, 0);
});

test('authStatus: expired token', async () => {
  const dir = await tmpDir();
  const expMs = NOW - DAY;
  await writeAuth(dir, { token: makeToken(expMs / 1000), exp: expMs, saved_at: NOW });
  assert.deepEqual(await authStatus(dir, now), {
    logged_in: false, expired: true, expires_at: new Date(expMs).toISOString(),
  });
});

test('authStatus: hand-edited token that fails parseToken is logged_in false', async () => {
  for (const token of [`${goodToken()}\nX-Evil: 1`, 'abc.def', 'garbage', 42, undefined]) {
    const dir = await tmpDir();
    await writeAuth(dir, { token, exp: GOOD_EXP_SEC * 1000, saved_at: NOW });
    assert.deepEqual(await authStatus(dir, now), { logged_in: false });
  }
});

test('authStatus never contains the token', async () => {
  const dir = await tmpDir();
  const t = goodToken();
  await saveToken(dir, t, now);
  assert.ok(!JSON.stringify(await authStatus(dir, now)).includes(t));
});

// ---- parseToken on the content of auth.json ----

test('parseToken: the content of auth.json gives the same result as the bare token', () => {
  const t = goodToken();
  const file = JSON.stringify({ token: t, exp: GOOD_EXP_SEC * 1000, saved_at: NOW });
  assert.deepEqual(parseToken(file), parseToken(t));
  assert.deepEqual(parseToken(file), { token: t, exp: GOOD_EXP_SEC * 1000 });
  assert.deepEqual(parseToken(`\n  ${JSON.stringify({ token: t }, null, 2)}\n`), parseToken(t));
});

const badFileContent = {
  'empty object': '{}',
  'token is a number': '{"token":5}',
  'token is null': '{"token":null}',
  'token is an object': '{"token":{"a":1}}',
  'no token field': `{"exp":${GOOD_EXP_SEC * 1000}}`,
  'broken JSON': '{"token":',
  'broken JSON with a value inside': '{"token":"FILE-MARK-ABCDEF.GHIJKL.sig"',
  'token is garbage': '{"token":"FILE-MARK-garbage"}',
  'token is two parts': `{"token":"${b64url('{"alg":"none"}')}.FILE-MARK-QWERTY"}`,
};
for (const [name, raw] of Object.entries(badFileContent)) {
  test(`parseToken: auth.json content, ${name} -> BAD_TOKEN, no part of the input in the error`, () => {
    let err;
    try { parseToken(raw); } catch (e) { err = e; }
    assert.ok(err, 'must throw');
    assert.equal(err.name, 'KufarError');
    assert.equal(err.code, 'BAD_TOKEN');
    assert.ok(!errText(err).includes('FILE-MARK'));
    assert.ok(!errText(err).includes('ABCDEF'));
  });
}

test('saveToken: the content of auth.json is accepted and the clean token is stored', async () => {
  const dir = await tmpDir();
  const t = goodToken();
  await saveToken(dir, JSON.stringify({ token: t, exp: 1, saved_at: 1 }), now);
  assert.deepEqual(JSON.parse(await fs.readFile(authFile(dir), 'utf8')), {
    token: t, exp: GOOD_EXP_SEC * 1000, saved_at: NOW,
  });
});

// ---- logout ----

const SIGNOUT = 'https://cre-auth.kufar.by/v1/auth/signout';
const VERSION = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const pendingFile = (dir) => path.join(dir, 'login-pending.json');
const writePending = (dir) => fs.writeFile(pendingFile(dir), JSON.stringify({
  code_token: 'ct-1', phone: '375291234567', requested_at: NOW, retry_after: 60,
}));
const gone = (file) => assert.rejects(fs.stat(file), { code: 'ENOENT' });

// state dir with a live key (the clock of logout is the real one) and a pending code
async function loggedIn() {
  const dir = await tmpDir();
  const token = liveToken();
  await saveToken(dir, token);
  await writePending(dir);
  return { dir, token };
}

test('logout: one GET on the exact signout address with the exact headers and redirect manual', async () => {
  const { dir, token } = await loggedIn();
  const fetchImpl = fakeFetch(() => emptyRes(204));
  await logout(dir, { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, SIGNOUT);
  assert.equal((init.method ?? 'GET').toUpperCase(), 'GET');
  assert.equal(init.body, undefined);
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(headersOf(init), {
    'user-agent': `kufar-skill/${VERSION}`,
    'accept-language': 'ru',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  });
  assertNoSignoutAll(fetchImpl.calls);
});

for (const status of [204, 200, 401]) {
  test(`logout: answer ${status} means revoked, auth.json and login-pending.json are removed`, async () => {
    const { dir, token } = await loggedIn();
    const fetchImpl = fakeFetch(() => (status === 200 ? jsonRes(200, {}) : emptyRes(status)));
    const result = await logout(dir, { fetchImpl });
    assert.deepEqual(result, { logged_in: false, revoked: true });
    assert.ok(!JSON.stringify(result).includes(token));
    await gone(authFile(dir));
    await gone(pendingFile(dir));
    assert.deepEqual(await authStatus(dir), { logged_in: false });
    assertNoSignoutAll(fetchImpl.calls);
  });
}

for (const status of [500, 503, 403, 404, 302, 429]) {
  test(`logout: answer ${status} -> REVOKE_FAILED with the status, auth.json stays, no key in the error`, async () => {
    const { dir, token } = await loggedIn();
    const fetchImpl = fakeFetch(() => new Response(`BODY-MARK ${token}`, { status }));
    await assert.rejects(logout(dir, { fetchImpl }), (e) => {
      assert.equal(e.name, 'KufarError');
      assert.equal(e.code, 'REVOKE_FAILED');
      assert.deepEqual(e.details, { status });
      assert.ok(!errText(e).includes(token));
      assert.ok(!errText(e).includes('BODY-MARK'));
      return true;
    });
    assert.equal(JSON.parse(await fs.readFile(authFile(dir), 'utf8')).token, token, 'auth.json must stay for a retry');
    assert.equal(fetchImpl.calls.length, 1);
    assertNoSignoutAll(fetchImpl.calls);
  });
}

test('logout: a throwing fetchImpl -> REVOKE_FAILED, auth.json stays, no key and no exception text in the error', async () => {
  const { dir, token } = await loggedIn();
  const fetchImpl = fakeFetch((url, init) => {
    throw new TypeError(`fetch failed EXC-MARK ${JSON.stringify(headersOf(init))} ${token}`);
  });
  await assert.rejects(logout(dir, { fetchImpl }), (e) => {
    assert.equal(e.code, 'REVOKE_FAILED');
    assert.ok(!errText(e).includes(token));
    assert.ok(!errText(e).includes('EXC-MARK'));
    return true;
  });
  assert.equal(JSON.parse(await fs.readFile(authFile(dir), 'utf8')).token, token);
});

test('logout: no answer within timeoutMs -> REVOKE_FAILED, auth.json stays', { timeout: 5000 }, async () => {
  const { dir, token } = await loggedIn();
  // never answers; fails only when the code under test aborts it
  const fetchImpl = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error(`ABORT-MARK ${token}`)));
  }));
  await assert.rejects(logout(dir, { fetchImpl, timeoutMs: 30 }), (e) => {
    assert.equal(e.code, 'REVOKE_FAILED');
    assert.ok(!errText(e).includes(token));
    assert.ok(!errText(e).includes('ABORT-MARK'));
    return true;
  });
  assert.equal(JSON.parse(await fs.readFile(authFile(dir), 'utf8')).token, token);
});

test('logout: a failed revoke can be repeated and then succeeds', async () => {
  const { dir } = await loggedIn();
  await rejectsCode(logout(dir, { fetchImpl: fakeFetch(() => emptyRes(500)) }), 'REVOKE_FAILED');
  assert.deepEqual(await logout(dir, { fetchImpl: fakeFetch(() => emptyRes(204)) }), { logged_in: false, revoked: true });
  await gone(authFile(dir));
});

test('logout: login-pending.json is removed even when the revoke fails', async () => {
  const { dir } = await loggedIn();
  await rejectsCode(logout(dir, { fetchImpl: fakeFetch(() => emptyRes(500)) }), 'REVOKE_FAILED');
  await gone(pendingFile(dir));
});

test('logout: no auth.json -> no network, logged_in false, login-pending.json removed', async () => {
  const dir = await tmpDir();
  await writePending(dir);
  const fetchImpl = fakeFetch(() => { throw new Error('network must not be used'); });
  assert.deepEqual(await logout(dir, { fetchImpl }), { logged_in: false });
  assert.equal(fetchImpl.calls.length, 0);
  await gone(pendingFile(dir));
});

const unusableFiles = {
  'a key that fails parseToken': { token: `${goodToken()}\nX-Evil: 1`, exp: GOOD_EXP_SEC * 1000 },
  'a token that is not a string': { token: 5 },
  'no token field': { exp: GOOD_EXP_SEC * 1000 },
  'an expired key': { token: makeToken(Math.floor((Date.now() - DAY) / 1000)), exp: Date.now() + DAY },
};
for (const [name, data] of Object.entries(unusableFiles)) {
  test(`logout: auth.json with ${name} -> no network, file removed, logged_in false`, async () => {
    const dir = await tmpDir();
    await writeAuth(dir, data);
    const fetchImpl = fakeFetch(() => { throw new Error('network must not be used'); });
    assert.deepEqual(await logout(dir, { fetchImpl }), { logged_in: false });
    assert.equal(fetchImpl.calls.length, 0);
    await gone(authFile(dir));
  });
}

test('logout: auth.json that is not JSON -> no network, file removed, logged_in false', async () => {
  const dir = await tmpDir();
  await fs.writeFile(authFile(dir), 'not json at all');
  const fetchImpl = fakeFetch(() => { throw new Error('network must not be used'); });
  assert.deepEqual(await logout(dir, { fetchImpl }), { logged_in: false });
  assert.equal(fetchImpl.calls.length, 0);
  await gone(authFile(dir));
});

test('logout: a missing state dir is not an error', async () => {
  const base = await tmpDir();
  assert.deepEqual(await logout(path.join(base, 'nope'), { fetchImpl: fakeFetch(() => emptyRes(204)) }), { logged_in: false });
});
