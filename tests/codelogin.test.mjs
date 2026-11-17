import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePhone, requestCode, confirmCode } from '../scripts/lib/codelogin.mjs';
import {
  tmpDir, rejectsCode, throwsCode, NOW, goodToken, makeToken, errText, DAY,
  fakeFetch, jsonRes, emptyRes, headersOf,
} from './helpers.mjs';

const T = { timeout: 5000 };
const now = () => NOW;
const HOST = 'https://cre-auth.kufar.by';
const CAPTCHA_URL = `${HOST}/v2/auth/signin/recaptcha_required`;
const PHONE = '375291234567';
const CODE_URL = `${HOST}/v3/auth/phone/code`;
const REQUEST_URL = `${CODE_URL}?phone=${PHONE}&viber=true`;
const VERSION = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const EXPECTED_HEADERS = { 'user-agent': `kufar-skill/${VERSION}`, 'accept-language': 'ru', 'content-type': 'application/json' };
const pendingFile = (dir) => path.join(dir, 'login-pending.json');
const authFile = (dir) => path.join(dir, 'auth.json');
const exists = (f) => fs.stat(f).then(() => true, () => false);
const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
const NO_NET = () => { throw new Error('network must not be used'); };
const GOOD_BODY = { code_token: 'ct-123', ttl: 90 };

// answers per URL: captcha first request, then the code request
function codeFetch({ captcha = jsonRes(200, { is_required: false }), code = jsonRes(200, GOOD_BODY) } = {}) {
  return fakeFetch((url) => {
    if (url === CAPTCHA_URL) return captcha instanceof Error ? (() => { throw captcha; })() : captcha;
    return code instanceof Error ? (() => { throw code; })() : code;
  });
}

// ---- normalizePhone ----

test('normalizePhone: the three notations give the same number', () => {
  for (const raw of ['+375 (29) 123-45-67', '375291234567', '80291234567', ' +375-29-123-45-67 ', '8 (029) 123-45-67']) {
    assert.equal(normalizePhone(raw), PHONE, raw);
  }
});

const badPhones = ['291234567', '29123456', '+80 29 1234567 8', '8029123456', '37529123456', '3752912345678', '71234567890', 'abc', '+375 29 12a 45 67', '', '   ', '+', '80'];
for (const raw of badPhones) {
  test(`normalizePhone: ${JSON.stringify(raw)} -> BAD_ARGS`, () => {
    throwsCode(() => normalizePhone(raw), 'BAD_ARGS');
  });
}

test('normalizePhone: not a string -> BAD_ARGS', () => {
  for (const raw of [undefined, null, 375291234567, {}, ['375291234567']]) throwsCode(() => normalizePhone(raw), 'BAD_ARGS');
});

test('normalizePhone: the passed string is not repeated in the error', () => {
  for (const raw of ['PHONE-MARK-123', '+375 (29) 123-45-6X', '12345']) {
    let err;
    try { normalizePhone(raw); } catch (e) { err = e; }
    assert.equal(err.code, 'BAD_ARGS');
    assert.ok(!errText(err).includes(raw));
    assert.ok(!errText(err).includes('PHONE-MARK'));
  }
});

// ---- requestCode ----

test('requestCode: two GET requests, exact addresses, exact headers, no Authorization, redirect manual', T, async () => {
  const dir = await tmpDir();
  const fetchImpl = codeFetch();
  await requestCode({ stateDir: dir, phone: PHONE, fetchImpl, now });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [CAPTCHA_URL, REQUEST_URL]);
  for (const { init } of fetchImpl.calls) {
    assert.equal((init.method ?? 'GET').toUpperCase(), 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(headersOf(init), EXPECTED_HEADERS);
  }
});

test('requestCode: a phone in any notation goes out as 375NNNNNNNNN', T, async () => {
  for (const raw of ['+375 (29) 123-45-67', '80291234567']) {
    const fetchImpl = codeFetch();
    await requestCode({ stateDir: await tmpDir(), phone: raw, fetchImpl, now });
    assert.equal(fetchImpl.calls[1].url, REQUEST_URL);
  }
});

test('requestCode: result, and login-pending.json with mode 0600 and exactly three fields plus the time', T, async () => {
  const dir = await tmpDir();
  const result = await requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch(), now });
  assert.deepEqual(result, { code_sent: true, phone_tail: '67', retry_after: 90 });
  assert.equal((await fs.stat(pendingFile(dir))).mode & 0o777, 0o600);
  assert.deepEqual(await readJson(pendingFile(dir)), { code_token: 'ct-123', phone: PHONE, requested_at: NOW, retry_after: 90 });
});

test('requestCode: retry_after is the ttl when it is an integer 1..3600, else 60', T, async () => {
  const cases = [[1, 1], [3600, 3600], [45, 45], [0, 60], [3601, 60], [-5, 60], [1.5, 60], [null, 60], [undefined, 60]];
  for (const [ttl, expected] of cases) {
    const dir = await tmpDir();
    const body = ttl === undefined ? { code_token: 'ct-1' } : { code_token: 'ct-1', ttl };
    const result = await requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch({ code: jsonRes(200, body) }), now });
    assert.equal(result.retry_after, expected, `ttl ${JSON.stringify(ttl)}`);
    assert.equal((await readJson(pendingFile(dir))).retry_after, expected);
  }
});

test('requestCode: code_token of exactly 200 characters is accepted', T, async () => {
  const dir = await tmpDir();
  const code_token = 'x'.repeat(200);
  await requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch({ code: jsonRes(200, { code_token, ttl: 60 }) }), now });
  assert.equal((await readJson(pendingFile(dir))).code_token, code_token);
});

for (const [name, body] of [
  ['is_required true', { is_required: true }],
  ['is_required missing', {}],
  ['is_required a string', { is_required: 'false' }],
  ['is_required null', { is_required: null }],
  ['is_required 0', { is_required: 0 }],
]) {
  test(`requestCode: ${name} -> CAPTCHA_REQUIRED, no second request, no file`, T, async () => {
    const dir = await tmpDir();
    const fetchImpl = codeFetch({ captcha: jsonRes(200, body) });
    await rejectsCode(requestCode({ stateDir: dir, phone: PHONE, fetchImpl, now }), 'CAPTCHA_REQUIRED');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(await exists(pendingFile(dir)), false);
  });
}

for (const status of [500, 403, 404, 302, 201]) {
  test(`requestCode: the captcha check answers ${status} -> LOGIN_FAILED with the status, no second request`, T, async () => {
    const dir = await tmpDir();
    const fetchImpl = codeFetch({ captcha: new Response('{"is_required":false}', { status }) });
    await assert.rejects(requestCode({ stateDir: dir, phone: PHONE, fetchImpl, now }), (e) => {
      assert.equal(e.code, 'LOGIN_FAILED');
      assert.equal(e.details.status, status);
      return true;
    });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(await exists(pendingFile(dir)), false);
  });
}

test('requestCode: the captcha check answers 200 with a body that is not JSON -> LOGIN_FAILED', T, async () => {
  const fetchImpl = codeFetch({ captcha: new Response('<html>not json</html>', { status: 200 }) });
  await rejectsCode(requestCode({ stateDir: await tmpDir(), phone: PHONE, fetchImpl, now }), 'LOGIN_FAILED');
  assert.equal(fetchImpl.calls.length, 1);
});

test('requestCode: the code request answers 400 with a Kufar code -> LOGIN_FAILED with status and kufar_code only', T, async () => {
  const dir = await tmpDir();
  const body = { code: 'AUT0001', message: 'SECRET-MESSAGE-TEXT', code_token: 'CT-SECRET-MARK', extra: 'EXTRA-MARK' };
  await assert.rejects(
    requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch({ code: jsonRes(400, body) }), now }),
    (e) => {
      assert.equal(e.code, 'LOGIN_FAILED');
      assert.deepEqual(e.details, { status: 400, kufar_code: 'AUT0001' });
      for (const mark of ['SECRET-MESSAGE-TEXT', 'CT-SECRET-MARK', 'EXTRA-MARK']) assert.ok(!errText(e).includes(mark), mark);
      return true;
    },
  );
  assert.equal(await exists(pendingFile(dir)), false);
});

test('requestCode: a Kufar code of the wrong shape is not passed on', T, async () => {
  for (const code of ['aut0001', 'A1', 'AUTHEN0001', 'AUT1', 'AUT0000001', 'AUT 0001', 'AUT0001\nX', 5, null, ['AUT0001']]) {
    await assert.rejects(
      requestCode({ stateDir: await tmpDir(), phone: PHONE, fetchImpl: codeFetch({ code: jsonRes(400, { code }) }), now }),
      (e) => {
        assert.equal(e.code, 'LOGIN_FAILED');
        assert.deepEqual(e.details, { status: 400 }, JSON.stringify(code));
        return true;
      },
    );
  }
});

test('requestCode: Kufar codes AA12 and ABCDE123456 have the right shape', T, async () => {
  for (const code of ['AB12', 'ABCDE123456']) {
    await assert.rejects(
      requestCode({ stateDir: await tmpDir(), phone: PHONE, fetchImpl: codeFetch({ code: jsonRes(429, { code }) }), now }),
      (e) => e.details.kufar_code === code && e.details.status === 429,
    );
  }
});

test('requestCode: 400 with a body that is not JSON -> LOGIN_FAILED with the status', T, async () => {
  const fetchImpl = codeFetch({ code: new Response('oops', { status: 400 }) });
  await assert.rejects(requestCode({ stateDir: await tmpDir(), phone: PHONE, fetchImpl, now }), (e) => {
    assert.equal(e.code, 'LOGIN_FAILED');
    assert.equal(e.details.status, 400);
    return true;
  });
});

test('requestCode: a redirect on the code request is LOGIN_FAILED with the status', T, async () => {
  await assert.rejects(
    requestCode({ stateDir: await tmpDir(), phone: PHONE, fetchImpl: codeFetch({ code: emptyRes(302) }), now }),
    (e) => e.code === 'LOGIN_FAILED' && e.details.status === 302,
  );
});

test('requestCode: 200 without a usable code_token -> LOGIN_FAILED, no file', T, async () => {
  for (const body of [{}, { code_token: '' }, { code_token: 5 }, { code_token: null }, { code_token: 'x'.repeat(201) }, { ttl: 60 }]) {
    const dir = await tmpDir();
    await assert.rejects(requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch({ code: jsonRes(200, body) }), now }), (e) => {
      assert.equal(e.code, 'LOGIN_FAILED');
      assert.equal(e.details.status, 200);
      return true;
    });
    assert.equal(await exists(pendingFile(dir)), false, JSON.stringify(body));
  }
});

test('requestCode: a failed request leaves an existing login-pending.json byte for byte', T, async () => {
  const dir = await tmpDir();
  const old = JSON.stringify({ code_token: 'OLD', phone: PHONE, requested_at: NOW - 10 * DAY, retry_after: 60 });
  await fs.writeFile(pendingFile(dir), old);
  await rejectsCode(requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch({ code: jsonRes(400, {}) }), now }), 'LOGIN_FAILED');
  assert.equal(await fs.readFile(pendingFile(dir), 'utf8'), old);
});

test('requestCode: fetchImpl throws -> NETWORK with the fixed message, no exception text', T, async () => {
  for (const which of ['captcha', 'code']) {
    const boom = new TypeError('fetch failed EXC-MARK-123');
    const fetchImpl = codeFetch({ [which]: boom });
    const dir = await tmpDir();
    await assert.rejects(requestCode({ stateDir: dir, phone: PHONE, fetchImpl, now }), (e) => {
      assert.equal(e.code, 'NETWORK');
      assert.equal(e.message, 'Сетевая ошибка');
      assert.ok(!errText(e).includes('EXC-MARK'));
      return true;
    });
    assert.equal(await exists(pendingFile(dir)), false);
  }
});

test('requestCode: no answer within timeoutMs -> NETWORK', T, async () => {
  const fetchImpl = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('ABORT-MARK')));
  }));
  await assert.rejects(requestCode({ stateDir: await tmpDir(), phone: PHONE, fetchImpl, now, timeoutMs: 30 }), (e) => {
    assert.equal(e.code, 'NETWORK');
    assert.ok(!errText(e).includes('ABORT-MARK'));
    return true;
  });
});

test('requestCode: a bad phone -> BAD_ARGS before any network call', T, async () => {
  const fetchImpl = fakeFetch(NO_NET);
  await rejectsCode(requestCode({ stateDir: await tmpDir(), phone: '12345', fetchImpl, now }), 'BAD_ARGS');
  assert.equal(fetchImpl.calls.length, 0);
});

test('requestCode: a second request before retry_after -> CODE_ALREADY_SENT with seconds_left, no network, file unchanged', T, async () => {
  const dir = await tmpDir();
  await requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch(), now }); // retry_after 90 at NOW
  const before = await fs.readFile(pendingFile(dir), 'utf8');
  const fetchImpl = fakeFetch(NO_NET);
  await assert.rejects(requestCode({ stateDir: dir, phone: PHONE, fetchImpl, now: () => NOW + 40_000 }), (e) => {
    assert.equal(e.code, 'CODE_ALREADY_SENT');
    assert.deepEqual(e.details, { seconds_left: 50 });
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(await fs.readFile(pendingFile(dir), 'utf8'), before);
});

test('requestCode: at retry_after and later a new request goes through and the file is updated', T, async () => {
  for (const later of [90_000, 3_600_000]) {
    const dir = await tmpDir();
    await requestCode({ stateDir: dir, phone: PHONE, fetchImpl: codeFetch(), now });
    const fetchImpl = codeFetch({ code: jsonRes(200, { code_token: 'ct-NEW', ttl: 30 }) });
    const result = await requestCode({ stateDir: dir, phone: PHONE, fetchImpl, now: () => NOW + later });
    assert.equal(fetchImpl.calls.length, 2);
    assert.deepEqual(result, { code_sent: true, phone_tail: '67', retry_after: 30 });
    assert.deepEqual(await readJson(pendingFile(dir)), { code_token: 'ct-NEW', phone: PHONE, requested_at: NOW + later, retry_after: 30 });
  }
});

test('requestCode: a damaged login-pending.json does not block a new request', T, async () => {
  for (const content of ['garbage', '{}', '[]']) {
    const dir = await tmpDir();
    await fs.writeFile(pendingFile(dir), content);
    const fetchImpl = codeFetch();
    await requestCode({ stateDir: dir, phone: PHONE, fetchImpl, now });
    assert.equal(fetchImpl.calls.length, 2, content);
    assert.equal((await readJson(pendingFile(dir))).code_token, 'ct-123');
  }
});

// ---- confirmCode ----

const writePending = (dir, over = {}) => fs.writeFile(pendingFile(dir), JSON.stringify({
  code_token: 'ct-123', phone: PHONE, requested_at: NOW, retry_after: 60, ...over,
}));

async function pendingDir(over) {
  const dir = await tmpDir();
  await writePending(dir, over);
  return dir;
}

test('confirmCode: one POST on the exact address, exact body, exact headers, redirect manual', T, async () => {
  const dir = await pendingDir();
  const fetchImpl = fakeFetch(() => jsonRes(200, { jwt: goodToken(), 'session-id': 'SESSION-MARK' }));
  await confirmCode({ stateDir: dir, code: '1234', fetchImpl, now });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, CODE_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(headersOf(init), EXPECTED_HEADERS);
  assert.deepEqual(JSON.parse(init.body), {
    channel: 'viber_sms', code: '1234', code_token: 'ct-123', phone: '+375 (29) 123 45 67',
  });
});

test('confirmCode: the phone is written the way the site sends it', T, async () => {
  const dir = await pendingDir({ phone: '375447654321' });
  const fetchImpl = fakeFetch(() => jsonRes(200, { jwt: goodToken() }));
  await confirmCode({ stateDir: dir, code: '1234', fetchImpl, now });
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).phone, '+375 (44) 765 43 21');
});

test('confirmCode: success -> auth.json saved, login-pending.json removed, the result is the status without the key', T, async () => {
  const dir = await pendingDir();
  const jwt = goodToken();
  const result = await confirmCode({
    stateDir: dir, code: '12345678', fetchImpl: fakeFetch(() => jsonRes(200, { jwt, 'session-id': 'SESSION-MARK' })), now,
  });
  assert.deepEqual(result, { logged_in: true, expires_at: new Date(NOW + 30 * DAY).toISOString(), days_left: 30 });
  assert.ok(!JSON.stringify(result).includes(jwt));
  assert.equal((await readJson(authFile(dir))).token, jwt);
  assert.equal((await fs.stat(authFile(dir))).mode & 0o777, 0o600);
  assert.equal(await exists(pendingFile(dir)), false);
});

test('confirmCode: the session-id is saved nowhere and the key only in auth.json', T, async () => {
  const dir = await pendingDir();
  const jwt = goodToken();
  await confirmCode({ stateDir: dir, code: '1234', fetchImpl: fakeFetch(() => jsonRes(200, { jwt, 'session-id': 'SESSION-MARK' })), now });
  for (const f of await fs.readdir(dir)) {
    const text = await fs.readFile(path.join(dir, f), 'utf8');
    assert.ok(!text.includes('SESSION-MARK'), `${f} has the session id`);
    if (f !== 'auth.json') assert.ok(!text.includes(jwt), `${f} has the key`);
  }
});

test('confirmCode: a code that is not 4..8 digits -> BAD_ARGS before any network call', T, async () => {
  for (const code of ['123', '123456789', 'abcd', '12 34', '12a4', '', 1234, undefined, null, '１２３４']) {
    const dir = await pendingDir();
    const fetchImpl = fakeFetch(NO_NET);
    await rejectsCode(confirmCode({ stateDir: dir, code, fetchImpl, now }), 'BAD_ARGS');
    assert.equal(fetchImpl.calls.length, 0, JSON.stringify(code));
  }
});

test('confirmCode: leading zeros are kept', T, async () => {
  const dir = await pendingDir();
  const fetchImpl = fakeFetch(() => jsonRes(200, { jwt: goodToken() }));
  await confirmCode({ stateDir: dir, code: '0012', fetchImpl, now });
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).code, '0012');
});

test('confirmCode: a bad code with no pending login is BAD_ARGS (the code is checked first)', T, async () => {
  await rejectsCode(confirmCode({ stateDir: await tmpDir(), code: 'abc', fetchImpl: fakeFetch(NO_NET), now }), 'BAD_ARGS');
});

test('confirmCode: no login-pending.json -> NO_PENDING_LOGIN without network', T, async () => {
  const fetchImpl = fakeFetch(NO_NET);
  await rejectsCode(confirmCode({ stateDir: await tmpDir(), code: '1234', fetchImpl, now }), 'NO_PENDING_LOGIN');
  assert.equal(fetchImpl.calls.length, 0);
});

test('confirmCode: a damaged login-pending.json -> NO_PENDING_LOGIN without network', T, async () => {
  const cases = [
    'garbage', '{}', '[]', JSON.stringify({ code_token: 'ct-1' }), JSON.stringify({ phone: PHONE }),
    JSON.stringify({ code_token: 5, phone: PHONE }), JSON.stringify({ code_token: 'ct-1', phone: 375291234567 }),
    JSON.stringify({ code_token: 'ct-1', phone: '37529123456' }), JSON.stringify({ code_token: 'ct-1', phone: '+375291234567' }),
  ];
  for (const content of cases) {
    const dir = await tmpDir();
    await fs.writeFile(pendingFile(dir), content);
    const fetchImpl = fakeFetch(NO_NET);
    await rejectsCode(confirmCode({ stateDir: dir, code: '1234', fetchImpl, now }), 'NO_PENDING_LOGIN');
    assert.equal(fetchImpl.calls.length, 0, content);
    assert.equal(await exists(authFile(dir)), false);
  }
});

test('confirmCode: answer 400 -> LOGIN_FAILED with status and kufar_code, pending stays, no auth.json', T, async () => {
  const dir = await pendingDir({ code_token: 'CT-SECRET-MARK' });
  const body = { code: 'AUT0002', message: 'SECRET-MESSAGE-TEXT' };
  await assert.rejects(confirmCode({ stateDir: dir, code: '1234', fetchImpl: fakeFetch(() => jsonRes(400, body)), now }), (e) => {
    assert.equal(e.code, 'LOGIN_FAILED');
    assert.deepEqual(e.details, { status: 400, kufar_code: 'AUT0002' });
    for (const mark of ['SECRET-MESSAGE-TEXT', 'CT-SECRET-MARK']) assert.ok(!errText(e).includes(mark), mark);
    return true;
  });
  assert.equal((await readJson(pendingFile(dir))).code_token, 'CT-SECRET-MARK');
  assert.equal(await exists(authFile(dir)), false);
});

test('confirmCode: a redirect, and 200 without a jwt string -> LOGIN_FAILED, pending stays', T, async () => {
  for (const res of [emptyRes(302), jsonRes(200, {}), jsonRes(200, { jwt: 5 }), jsonRes(200, { jwt: null }), new Response('nope', { status: 200 })]) {
    const dir = await pendingDir();
    await rejectsCode(confirmCode({ stateDir: dir, code: '1234', fetchImpl: fakeFetch(() => res), now }), 'LOGIN_FAILED');
    assert.equal(await exists(pendingFile(dir)), true);
    assert.equal(await exists(authFile(dir)), false);
  }
});

test('confirmCode: a jwt that fails parseToken -> BAD_TOKEN, no auth.json, the value is not in the error', T, async () => {
  const dir = await pendingDir();
  const jwt = 'JWT-MARK-ZZZZ.not-a-key';
  await assert.rejects(confirmCode({ stateDir: dir, code: '1234', fetchImpl: fakeFetch(() => jsonRes(200, { jwt })), now }), (e) => {
    assert.equal(e.code, 'BAD_TOKEN');
    assert.ok(!errText(e).includes('JWT-MARK'));
    return true;
  });
  assert.equal(await exists(authFile(dir)), false);
});

test('confirmCode: an expired jwt -> AUTH_EXPIRED, no auth.json', T, async () => {
  const dir = await pendingDir();
  const jwt = makeToken(Math.floor((NOW - DAY) / 1000));
  await assert.rejects(confirmCode({ stateDir: dir, code: '1234', fetchImpl: fakeFetch(() => jsonRes(200, { jwt })), now }), (e) => {
    assert.equal(e.code, 'AUTH_EXPIRED');
    assert.ok(!errText(e).includes(jwt));
    return true;
  });
  assert.equal(await exists(authFile(dir)), false);
});

test('confirmCode: fetchImpl throws -> NETWORK with the fixed message, pending stays', T, async () => {
  const dir = await pendingDir();
  const fetchImpl = fakeFetch(() => { throw new TypeError('fetch failed EXC-MARK-123 ct-123'); });
  await assert.rejects(confirmCode({ stateDir: dir, code: '1234', fetchImpl, now }), (e) => {
    assert.equal(e.code, 'NETWORK');
    assert.equal(e.message, 'Сетевая ошибка');
    assert.ok(!errText(e).includes('EXC-MARK'));
    return true;
  });
  assert.equal(await exists(pendingFile(dir)), true);
});

test('confirmCode: no answer within timeoutMs -> NETWORK', T, async () => {
  const dir = await pendingDir();
  const fetchImpl = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('ABORT-MARK')));
  }));
  await rejectsCode(confirmCode({ stateDir: dir, code: '1234', fetchImpl, now, timeoutMs: 30 }), 'NETWORK');
});

test('no request of requestCode and confirmCode carries Authorization or goes to another host', T, async () => {
  const dir = await tmpDir();
  const req = codeFetch();
  await requestCode({ stateDir: dir, phone: PHONE, fetchImpl: req, now });
  const conf = fakeFetch(() => jsonRes(200, { jwt: goodToken() }));
  await confirmCode({ stateDir: dir, code: '1234', fetchImpl: conf, now });
  for (const { url, init } of [...req.calls, ...conf.calls]) {
    assert.equal(new URL(url).origin, HOST);
    assert.equal(headersOf(init).authorization, undefined);
    assert.ok(!url.includes('signout'));
  }
});
