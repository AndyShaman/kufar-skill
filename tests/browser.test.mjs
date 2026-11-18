import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  browserCandidates, findBrowser, displayAvailable, createPipeConnection, readKufarToken, waitForLogin, loginWindow,
  sweepLoginProfiles, loginWindowStatus, startLogin, runLoginWorker, stopLoginWindow,
} from '../skills/kufar/scripts/lib/browser.mjs';
import {
  tmpDir, rejectsCode, errText, goodToken, cookie, pipeEnds, fakeConn, kufarResponder, fakeBrowserProcess,
  processHandler, fakeClock, assertCookieRequestsSafe, failure, pollResponder, NOW, makeToken, DAY,
} from './helpers.mjs';

const T = { timeout: 5000 }; // a test must not hang when the code under test never answers
const KJWT = goodToken();

// ---- browserCandidates ----

test('browserCandidates darwin: four app paths in order', () => {
  assert.deepEqual(browserCandidates({ platform: 'darwin', env: {} }), [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ]);
});

test('browserCandidates linux: names in the outer loop, PATH dirs in the inner loop', () => {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const expected = names.flatMap((n) => [`/usr/bin/${n}`, `/opt/bin/${n}`]);
  assert.deepEqual(browserCandidates({ platform: 'linux', env: { PATH: '/usr/bin:/opt/bin' } }), expected);
});

test('browserCandidates linux: empty PATH entries are skipped', () => {
  const got = browserCandidates({ platform: 'linux', env: { PATH: ':/usr/bin::' } });
  assert.equal(got.length, 6);
  assert.ok(got.every((p) => p.startsWith('/usr/bin/')));
});

test('browserCandidates linux: directories under /snap/ are skipped, look-alikes are not', () => {
  const got = browserCandidates({ platform: 'linux', env: { PATH: '/snap/bin:/usr/bin:/snap/chromium/current/bin:/snapshot/bin' } });
  assert.equal(got.length, 12);
  assert.ok(got.every((p) => p.startsWith('/usr/bin/') || p.startsWith('/snapshot/bin/')));
  assert.ok(!got.some((p) => p.startsWith('/snap/')));
  assert.deepEqual(got.slice(0, 2), ['/usr/bin/google-chrome', '/snapshot/bin/google-chrome']);
});

test('browserCandidates linux: PATH made only of snap directories gives []', () => {
  assert.deepEqual(browserCandidates({ platform: 'linux', env: { PATH: '/snap/bin:/snap/chromium/current/bin' } }), []);
});

test('browserCandidates linux: empty or missing PATH gives []', () => {
  assert.deepEqual(browserCandidates({ platform: 'linux', env: { PATH: '' } }), []);
  assert.deepEqual(browserCandidates({ platform: 'linux', env: {} }), []);
});

test('browserCandidates win32: browsers in the outer loop, set bases in the inner loop, path.win32.join', () => {
  const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
  const rel = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA];
  const expected = rel.flatMap((r) => bases.map((b) => path.win32.join(b, r)));
  assert.deepEqual(browserCandidates({ platform: 'win32', env }), expected);
});

test('browserCandidates win32: unset bases are skipped; none set gives []', () => {
  const got = browserCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } });
  assert.equal(got.length, 3);
  assert.ok(got.every((p) => p.startsWith('C:\\L')));
  assert.deepEqual(browserCandidates({ platform: 'win32', env: {} }), []);
});

test('browserCandidates: unknown platform gives []', () => {
  assert.deepEqual(browserCandidates({ platform: 'freebsd', env: { PATH: '/usr/bin' } }), []);
});

// ---- findBrowser ----

const existsOnly = (...paths) => async (p) => paths.includes(p);

test('findBrowser: the first existing candidate wins', async () => {
  const c = browserCandidates({ platform: 'darwin', env: {} });
  const got = await findBrowser({ platform: 'darwin', env: {}, exists: existsOnly(c[1], c[3]) });
  assert.equal(got, c[1]);
});

test('findBrowser: no candidate exists -> BROWSER_NOT_FOUND', async () => {
  await rejectsCode(findBrowser({ platform: 'darwin', env: {}, exists: existsOnly() }), 'BROWSER_NOT_FOUND');
});

test('findBrowser: unknown platform has no candidates -> BROWSER_NOT_FOUND', async () => {
  await rejectsCode(findBrowser({ platform: 'freebsd', env: {}, exists: async () => true }), 'BROWSER_NOT_FOUND');
});

test('findBrowser: KUFAR_BROWSER absolute and existing wins over the candidates', async () => {
  const mine = '/opt/test-browser/bin/browser';
  const c = browserCandidates({ platform: 'darwin', env: {} });
  const got = await findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: mine }, exists: existsOnly(mine, c[0]) });
  assert.equal(got, mine);
});

test('findBrowser: an empty KUFAR_BROWSER counts as not set', async () => {
  const c = browserCandidates({ platform: 'darwin', env: {} });
  const got = await findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: '' }, exists: existsOnly(c[2]) });
  assert.equal(got, c[2]);
  await rejectsCode(findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: '' }, exists: existsOnly() }), 'BROWSER_NOT_FOUND');
});

test('findBrowser: KUFAR_BROWSER relative -> BAD_ARGS', async () => {
  const seen = [];
  const exists = async (p) => { seen.push(p); return true; };
  await rejectsCode(findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: 'chrome' }, exists }), 'BAD_ARGS');
  await rejectsCode(findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: './chrome' }, exists }), 'BAD_ARGS');
});

test('findBrowser: KUFAR_BROWSER missing -> BROWSER_NOT_FOUND and the other candidates are not tried', async () => {
  const mine = '/opt/test-browser/bin/missing';
  const seen = [];
  const exists = async (p) => { seen.push(p); return p !== mine; };
  await rejectsCode(findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: mine }, exists }), 'BROWSER_NOT_FOUND');
  assert.ok(seen.every((p) => p === mine), `other paths checked: ${seen}`);
});

test('findBrowser: the default exists checks the real file system', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'fake-browser');
  await fsp.writeFile(file, '');
  assert.equal(await findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: file } }), file);
  await rejectsCode(
    findBrowser({ platform: 'darwin', env: { KUFAR_BROWSER: path.join(dir, 'nope') } }), 'BROWSER_NOT_FOUND',
  );
});

// ---- displayAvailable ----

test('displayAvailable linux: DISPLAY or WAYLAND_DISPLAY is enough, nothing is not', () => {
  assert.equal(displayAvailable({ platform: 'linux', env: { DISPLAY: ':0' } }), true);
  assert.equal(displayAvailable({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), true);
  assert.equal(displayAvailable({ platform: 'linux', env: {} }), false);
  assert.equal(displayAvailable({ platform: 'linux', env: { PATH: '/usr/bin' } }), false);
});

test('displayAvailable linux: empty DISPLAY and WAYLAND_DISPLAY do not count', () => {
  assert.equal(displayAvailable({ platform: 'linux', env: { DISPLAY: '', WAYLAND_DISPLAY: '' } }), false);
  assert.equal(displayAvailable({ platform: 'linux', env: { DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' } }), true);
});

for (const platform of ['darwin', 'win32']) {
  test(`displayAvailable ${platform}: an SSH session has no screen, otherwise there is one`, () => {
    assert.equal(displayAvailable({ platform, env: {} }), true);
    assert.equal(displayAvailable({ platform, env: { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' } }), false);
    assert.equal(displayAvailable({ platform, env: { SSH_TTY: '/dev/ttys001' } }), false);
    assert.equal(displayAvailable({ platform, env: { SSH_CONNECTION: 'x', SSH_TTY: 'y' } }), false);
  });
}

test('displayAvailable: other platforms -> true', () => {
  assert.equal(displayAvailable({ platform: 'freebsd', env: {} }), true);
});

// ---- createPipeConnection ----

function connWithPipe(opts = { timeoutMs: 1000 }) {
  const ends = pipeEnds();
  const conn = createPipeConnection(ends.writable, ends.readable, opts);
  return { ends, conn };
}
const tick = () => new Promise((r) => setImmediate(r));

test('pipe: send writes one JSON line ending with \\0, params default {}, no sessionId', T, async () => {
  const { ends, conn } = connWithPipe();
  const p = conn.send('Target.getTargets');
  await tick();
  assert.equal(ends.chunks.join(''), `${JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} })}\0`);
  ends.push({ id: 1, result: { ok: true } });
  assert.deepEqual(await p, { ok: true });
});

test('pipe: sessionId is in the message only when passed', T, async () => {
  const { ends, conn } = connWithPipe();
  const p1 = conn.send('A.b', { x: 1 }, 'SESS-1');
  const p2 = conn.send('C.d', { y: 2 });
  await tick();
  assert.deepEqual(ends.messages[0], { id: 1, method: 'A.b', params: { x: 1 }, sessionId: 'SESS-1' });
  assert.deepEqual(ends.messages[1], { id: 2, method: 'C.d', params: { y: 2 } });
  assert.ok(!('sessionId' in ends.messages[1]));
  ends.push({ id: 1, result: {} });
  ends.push({ id: 2, result: {} });
  await Promise.all([p1, p2]);
});

test('pipe: ids are 1, 2, 3 in call order and replies find their own call', T, async () => {
  const { ends, conn } = connWithPipe();
  const ps = [conn.send('M.one'), conn.send('M.two'), conn.send('M.three')];
  await tick();
  assert.deepEqual(ends.messages.map((m) => m.id), [1, 2, 3]);
  ends.push({ id: 3, result: { n: 3 } });
  ends.push({ id: 1, result: { n: 1 } });
  ends.push({ id: 2, result: { n: 2 } });
  assert.deepEqual(await Promise.all(ps), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('pipe: a reply cut into chunks, even in the middle of a multibyte character', T, async () => {
  const { ends, conn } = connWithPipe();
  const p = conn.send('M.one');
  await tick();
  const buf = Buffer.from(`${JSON.stringify({ id: 1, result: { text: 'Привет, мир' } })}\0`);
  const cut = buf.indexOf(Buffer.from('Привет')) + 3; // inside the second letter
  ends.push(buf.subarray(0, 5));
  await tick();
  ends.push(buf.subarray(5, cut));
  await tick();
  ends.push(buf.subarray(cut));
  assert.deepEqual(await p, { text: 'Привет, мир' });
});

test('pipe: two replies in one chunk', T, async () => {
  const { ends, conn } = connWithPipe();
  const p1 = conn.send('M.one');
  const p2 = conn.send('M.two');
  await tick();
  ends.push(`${JSON.stringify({ id: 1, result: { a: 1 } })}\0${JSON.stringify({ id: 2, result: { b: 2 } })}\0`);
  assert.deepEqual(await Promise.all([p1, p2]), [{ a: 1 }, { b: 2 }]);
});

test('pipe: events, unknown ids and non-JSON are skipped', T, async () => {
  const { ends, conn } = connWithPipe();
  const p = conn.send('M.one');
  await tick();
  ends.push({ method: 'Target.targetCreated', params: {} });
  ends.push('this is not json\0');
  ends.push({ id: 99, result: { wrong: true } });
  ends.push('{"id": 1, "result": \0');
  ends.push({ id: 1, result: { right: true } });
  assert.deepEqual(await p, { right: true });
});

test('pipe: reply with error -> BROWSER_UNAVAILABLE; no browser text and no sent message in the error', T, async () => {
  const { ends, conn } = connWithPipe();
  const p = conn.send('Test.secretMethod', { k: 'SECRET-PARAM' }, 'SECRET-SESSION');
  await tick();
  ends.push({ id: 1, error: { code: -32000, message: 'SECRET-BROWSER-TEXT' } });
  await assert.rejects(p, (e) => {
    assert.equal(e.name, 'KufarError');
    assert.equal(e.code, 'BROWSER_UNAVAILABLE');
    const text = errText(e);
    for (const s of ['SECRET-BROWSER-TEXT', 'SECRET-PARAM', 'SECRET-SESSION', 'secretMethod']) assert.ok(!text.includes(s), s);
    return true;
  });
});

test('pipe: no reply within timeoutMs -> BROWSER_UNAVAILABLE', T, async () => {
  const { conn } = connWithPipe({ timeoutMs: 30 });
  await rejectsCode(conn.send('M.one', { k: 'SECRET-PARAM' }), 'BROWSER_UNAVAILABLE');
});

test('pipe: the timeout error does not contain the sent message', T, async () => {
  const { conn } = connWithPipe({ timeoutMs: 30 });
  await assert.rejects(conn.send('Test.secretMethod', { k: 'SECRET-PARAM' }), (e) => {
    assert.ok(!errText(e).includes('SECRET-PARAM'));
    assert.ok(!errText(e).includes('secretMethod'));
    return true;
  });
});

test('pipe: end of the readable rejects the waiting call and every later send', T, async () => {
  const { ends, conn } = connWithPipe();
  const waiting = conn.send('M.one');
  await tick();
  ends.readable.end();
  await rejectsCode(waiting, 'BROWSER_UNAVAILABLE');
  await rejectsCode(conn.send('M.two'), 'BROWSER_UNAVAILABLE');
});

test('pipe: close of the readable rejects the waiting call and every later send', T, async () => {
  const { ends, conn } = connWithPipe();
  const waiting = conn.send('M.one');
  await tick();
  ends.readable.destroy();
  await rejectsCode(waiting, 'BROWSER_UNAVAILABLE');
  await rejectsCode(conn.send('M.two'), 'BROWSER_UNAVAILABLE');
});

test('pipe: close() rejects the waiting call and every later send', T, async () => {
  const { conn } = connWithPipe();
  const waiting = conn.send('M.one');
  conn.close();
  await rejectsCode(waiting, 'BROWSER_UNAVAILABLE');
  await rejectsCode(conn.send('M.two'), 'BROWSER_UNAVAILABLE');
});

test('pipe: closed is false until the readable ends, true after the end', T, async () => {
  const { ends, conn } = connWithPipe();
  assert.equal(conn.closed, false);
  const p = conn.send('M.one');
  await tick();
  ends.push({ id: 1, result: {} });
  await p;
  assert.equal(conn.closed, false);
  ends.readable.end();
  await tick();
  assert.equal(conn.closed, true);
});

test('pipe: closed is true after the readable is destroyed', T, async () => {
  const { ends, conn } = connWithPipe();
  assert.equal(conn.closed, false);
  ends.readable.destroy();
  await tick();
  assert.equal(conn.closed, true);
});

test('pipe: closed is true after close()', T, async () => {
  const { conn } = connWithPipe();
  assert.equal(conn.closed, false);
  conn.close();
  assert.equal(conn.closed, true);
});

// ---- readKufarToken ----

const responder = (over) => kufarResponder({ cookiesSeq: [[cookie('k_jwt', KJWT, '.kufar.by')]], ...over });
const URLS = ['https://www.kufar.by/', 'https://api.kufar.by/'];

test('readKufarToken: a page with k_jwt -> { page: true, token } with the raw value', T, async () => {
  const conn = fakeConn(responder());
  assert.deepEqual(await readKufarToken(conn), { page: true, token: KJWT });
  assertCookieRequestsSafe(conn.calls);
});

test('readKufarToken: four calls in order with exact parameters', T, async () => {
  const conn = fakeConn(responder());
  await readKufarToken(conn);
  assert.deepEqual(conn.calls, [
    { method: 'Target.getTargets', params: {}, sessionId: undefined },
    { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true }, sessionId: undefined },
    { method: 'Network.getCookies', params: { urls: URLS }, sessionId: 'S1' },
    { method: 'Target.detachFromTarget', params: { sessionId: 'S1' }, sessionId: undefined },
  ]);
});

test('readKufarToken: the first page target is used, other target types are ignored', T, async () => {
  const targetInfos = [
    { targetId: 'B', type: 'browser' }, { targetId: 'W', type: 'service_worker' },
    { targetId: 'P1', type: 'page' }, { targetId: 'P2', type: 'page' },
  ];
  const conn = fakeConn(responder({ targetInfos }));
  await readKufarToken(conn);
  assert.equal(conn.calls[1].params.targetId, 'P1');
});

test('readKufarToken: no page target -> { page: false, token: null } and no cookies requested', T, async () => {
  for (const targetInfos of [[], [{ targetId: 'B', type: 'browser' }]]) {
    const conn = fakeConn(responder({ targetInfos }));
    assert.deepEqual(await readKufarToken(conn), { page: false, token: null });
    assert.deepEqual(conn.calls.map((c) => c.method), ['Target.getTargets']);
  }
});

test('readKufarToken: no k_jwt cookie -> { page: true, token: null } (other cookies, other names)', T, async () => {
  for (const cookies of [[], [cookie('session', 'abc', '.kufar.by')], [cookie('k_jwt_old', KJWT, 'kufar.by')]]) {
    const conn = fakeConn(responder({ cookiesSeq: [cookies] }));
    assert.deepEqual(await readKufarToken(conn), { page: true, token: null });
    assertCookieRequestsSafe(conn.calls);
  }
});

test('readKufarToken: k_jwt of a foreign domain does not count', T, async () => {
  for (const domain of ['example.com', 'evilkufar.by', 'kufar.by.example.com', '.example.com', 'kufar.by.evil.test']) {
    const conn = fakeConn(responder({ cookiesSeq: [[cookie('k_jwt', KJWT, domain)]] }));
    assert.deepEqual(await readKufarToken(conn), { page: true, token: null }, domain);
  }
});

test('readKufarToken: kufar.by, .kufar.by and subdomains are accepted', T, async () => {
  for (const domain of ['kufar.by', '.kufar.by', 'www.kufar.by', 'auth.kufar.by']) {
    const conn = fakeConn(responder({ cookiesSeq: [[cookie('k_jwt', KJWT, domain)]] }));
    assert.deepEqual(await readKufarToken(conn), { page: true, token: KJWT }, domain);
  }
});

test('readKufarToken: a k_jwt value that fails parseToken -> { page: true, token: null }', T, async () => {
  for (const value of ['garbage', 'a.b', `${KJWT}\nmore`, '']) {
    const conn = fakeConn(responder({ cookiesSeq: [[cookie('k_jwt', value, '.kufar.by')]] }));
    assert.deepEqual(await readKufarToken(conn), { page: true, token: null }, JSON.stringify(value));
  }
});

test('readKufarToken: picks the valid kufar k_jwt among foreign, invalid and other cookies', T, async () => {
  const cookies = [
    cookie('k_jwt', 'FOREIGN.TOKEN.sig', 'example.com'),
    cookie('k_jwt', KJWT, 'example.com'),
    cookie('session', 'abc', '.kufar.by'),
    cookie('k_jwt', 'garbage', '.kufar.by'),
    cookie('k_jwt', KJWT, 'www.kufar.by'),
  ];
  const conn = fakeConn(responder({ cookiesSeq: [cookies] }));
  assert.deepEqual(await readKufarToken(conn), { page: true, token: KJWT });
});

test('readKufarToken: detach is called when the cookie call fails, and the cookie error is passed on', T, async () => {
  const boom = failure('BROWSER_UNAVAILABLE');
  const conn = fakeConn(responder({ failCookies: boom }));
  await assert.rejects(readKufarToken(conn), (e) => e === boom);
  assert.deepEqual(conn.calls.map((c) => c.method), [
    'Target.getTargets', 'Target.attachToTarget', 'Network.getCookies', 'Target.detachFromTarget',
  ]);
  assertCookieRequestsSafe(conn.calls);
});

test('readKufarToken: a failing detach is swallowed', T, async () => {
  const conn = fakeConn(responder({ failDetach: failure() }));
  assert.deepEqual(await readKufarToken(conn), { page: true, token: KJWT });
});

test('readKufarToken: a failing detach does not hide the cookie error', T, async () => {
  const boom = failure('BROWSER_UNAVAILABLE');
  const conn = fakeConn(responder({ failCookies: boom, failDetach: failure('NETWORK') }));
  await assert.rejects(readKufarToken(conn), (e) => e === boom);
});

test('readKufarToken: an error before attach is passed on', T, async () => {
  const boom = failure();
  const conn = fakeConn(() => { throw boom; });
  await assert.rejects(readKufarToken(conn), (e) => e === boom);
});

// ---- waitForLogin ----

const wait = (steps, over = {}) => {
  const conn = fakeConn(pollResponder(steps, KJWT));
  const clock = fakeClock();
  return { conn, clock, run: () => waitForLogin(conn, { ...clock, waitMs: 60000, pollMs: 1000, ...over }) };
};
const polls = (conn) => conn.calls.filter((c) => c.method === 'Target.getTargets').length;

test('waitForLogin: the key from the third poll, sleeping pollMs between polls', T, async () => {
  const w = wait(['page', 'page', 'token']);
  assert.equal(await w.run(), KJWT);
  assert.deepEqual(w.clock.sleeps, [1000, 1000]);
  assert.equal(polls(w.conn), 3);
  assertCookieRequestsSafe(w.conn.calls);
});

test('waitForLogin: never logged in -> LOGIN_TIMEOUT after waitMs of (fake) time', T, async () => {
  const w = wait(['page'], { waitMs: 3000 });
  await rejectsCode(w.run(), 'LOGIN_TIMEOUT');
  assert.ok(w.clock.sleeps.length >= 2 && w.clock.sleeps.length <= 3, `sleeps: ${w.clock.sleeps.length}`);
  assert.ok(w.clock.sleeps.every((ms) => ms === 1000));
});

test('waitForLogin: a key found on the last poll still wins (read comes before the timeout check)', T, async () => {
  const w = wait(['token'], { waitMs: 0 });
  assert.equal(await w.run(), KJWT);
});

test('waitForLogin: signal already aborted -> LOGIN_CANCELLED and the browser is not asked', T, async () => {
  const ac = new AbortController();
  ac.abort();
  const w = wait(['page'], { signal: ac.signal });
  await rejectsCode(w.run(), 'LOGIN_CANCELLED');
  assert.equal(w.conn.calls.length, 0);
});

test('waitForLogin: signal aborted while waiting -> LOGIN_CANCELLED', T, async () => {
  const ac = new AbortController();
  const w = wait(['page'], { signal: ac.signal });
  const baseSleep = w.clock.sleep;
  w.clock.sleep = async (ms) => { await baseSleep(ms); if (w.clock.sleeps.length === 2) ac.abort(); };
  await rejectsCode(waitForLogin(w.conn, { ...w.clock, waitMs: 60000, pollMs: 1000, signal: ac.signal }), 'LOGIN_CANCELLED');
  assert.equal(polls(w.conn), 2);
});

test('waitForLogin: isClosed before the first answer -> BROWSER_UNAVAILABLE and the browser is not asked', T, async () => {
  const w = wait(['page'], { isClosed: () => true });
  await rejectsCode(w.run(), 'BROWSER_UNAVAILABLE');
  assert.equal(w.conn.calls.length, 0);
});

test('waitForLogin: isClosed after a successful poll -> LOGIN_CANCELLED', T, async () => {
  let closed = false;
  const w = wait(['page'], { isClosed: () => closed });
  const baseSleep = w.clock.sleep;
  w.clock.sleep = async (ms) => { await baseSleep(ms); closed = true; };
  await rejectsCode(waitForLogin(w.conn, { ...w.clock, waitMs: 60000, pollMs: 1000, isClosed: () => closed }), 'LOGIN_CANCELLED');
  assert.equal(polls(w.conn), 1);
});

test('waitForLogin: a poll error and then isClosed -> BROWSER_UNAVAILABLE when nothing was answered yet', T, async () => {
  const conn = fakeConn(() => { throw failure('NETWORK'); });
  const isClosed = () => conn.calls.length > 0;
  await rejectsCode(waitForLogin(conn, { ...fakeClock(), waitMs: 60000, pollMs: 10, isClosed }), 'BROWSER_UNAVAILABLE');
});

test('waitForLogin: a poll error and then isClosed -> LOGIN_CANCELLED after an answered poll', T, async () => {
  const conn = fakeConn(pollResponder(['page', failure()], KJWT));
  const isClosed = () => polls(conn) >= 2;
  await rejectsCode(waitForLogin(conn, { ...fakeClock(), waitMs: 60000, pollMs: 10, isClosed }), 'LOGIN_CANCELLED');
});

test('waitForLogin: a poll error and then an aborted signal -> LOGIN_CANCELLED', T, async () => {
  const ac = new AbortController();
  const conn = fakeConn(() => { ac.abort(); throw failure(); });
  await rejectsCode(waitForLogin(conn, { ...fakeClock(), waitMs: 60000, pollMs: 10, signal: ac.signal }), 'LOGIN_CANCELLED');
});

test('waitForLogin: a poll error before the first answer within startMs -> keeps waiting, the next poll returns the key', T, async () => {
  const w = wait([failure(), failure(), 'token'], { startMs: 30000 });
  assert.equal(await w.run(), KJWT);
  assert.deepEqual(w.clock.sleeps, [1000, 1000]);
});

test('waitForLogin: the same error after startMs is passed on as is', T, async () => {
  const boom = failure('BROWSER_UNAVAILABLE');
  const w = wait([boom], { startMs: 3000 });
  await assert.rejects(w.run(), (e) => e === boom);
  assert.ok(w.clock.sleeps.length >= 2 && w.clock.sleeps.length <= 4, `sleeps: ${w.clock.sleeps.length}`);
  assert.ok(w.clock.sleeps.every((ms) => ms === 1000));
});

test('waitForLogin: a poll error after the first answer with a live browser is passed on at once', T, async () => {
  const boom = failure('BROWSER_UNAVAILABLE');
  const w = wait(['page', boom]);
  await assert.rejects(w.run(), (e) => e === boom);
  assert.deepEqual(w.clock.sleeps, [1000]);
});

test('waitForLogin: a page that was there and is gone for two polls in a row -> LOGIN_CANCELLED', T, async () => {
  const w = wait(['page', 'nopage', 'nopage', 'token']);
  await rejectsCode(w.run(), 'LOGIN_CANCELLED');
  assert.equal(polls(w.conn), 3);
});

test('waitForLogin: a page gone for one poll and back -> waiting goes on, the key is returned', T, async () => {
  const w = wait(['page', 'nopage', 'page', 'token']);
  assert.equal(await w.run(), KJWT);
});

test('waitForLogin: a page that comes and goes, never twice in a row, is not a cancel (timeout instead)', T, async () => {
  const w = wait(['page', 'nopage', 'page', 'nopage', 'page', 'nopage'], { waitMs: 5000 });
  await assert.rejects(w.run(), (e) => e.code === 'LOGIN_TIMEOUT');
});

test('waitForLogin: no page since the start is no cancel; the page may still appear', T, async () => {
  const w = wait(['nopage', 'nopage', 'nopage', 'page', 'token']);
  assert.equal(await w.run(), KJWT);
});

test('waitForLogin: no page at all until the time is up -> LOGIN_TIMEOUT, not LOGIN_CANCELLED', T, async () => {
  const w = wait(['nopage'], { waitMs: 4000 });
  await rejectsCode(w.run(), 'LOGIN_TIMEOUT');
});

// ---- loginWindow ----

const BIN = '/opt/test-browser/bin/browser';
const PROFILE_RE = /^login-profile-[0-9a-f]{12}$/;
const readProfileArg = (args) => args.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
const left = async (stateDir) => (await fsp.readdir(stateDir)).filter((n) => n.startsWith('login-profile'));
const exists = (p) => fs.existsSync(p);
const withPoll = (steps) => processHandler(pollResponder(steps, KJWT));

// stateDir in a temp dir; every collaborator is a fake; `proc` may be a custom fake process
async function setup({
  proc, handler, platform = 'darwin', env = {}, waitMs = 3000, pollMs = 1000, closeWaitMs = 40, findImpl, beforeSpawn, signal,
} = {}) {
  const stateDir = await tmpDir();
  const clock = fakeClock();
  const child = proc ?? fakeBrowserProcess({ handler: handler ?? withPoll(['page', 'token']) });
  const spawned = [];
  const finds = [];
  const spawnImpl = (bin, args, opts) => {
    const profile = readProfileArg(args);
    const st = profile ? fs.statSync(profile, { throwIfNoEntry: false }) : undefined;
    spawned.push({ bin, args, opts, profile, profileMode: st && (st.mode & 0o777), profileIsDir: st?.isDirectory() });
    beforeSpawn?.(profile);
    return child;
  };
  const findBrowserImpl = findImpl ?? (async (a) => { finds.push(a); return BIN; });
  const run = () => loginWindow({
    stateDir, waitMs, pollMs, closeWaitMs, platform, env, spawnImpl, findBrowserImpl, now: clock.now, sleep: clock.sleep, signal,
  });
  return { stateDir, child, spawned, finds, clock, run };
}

test('loginWindow: success returns the raw key; the window is closed; no profile left; nothing written to the state dir', T, async () => {
  const s = await setup();
  assert.equal(await s.run(), KJWT);
  assert.ok(s.child.sent.some((m) => m.method === 'Browser.close'), 'Browser.close not sent');
  assert.equal(s.child.killed, 0, 'a browser that exited by itself is not killed');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('loginWindow: spawn gets the exact binary, arguments and stdio', T, async () => {
  const s = await setup();
  await s.run();
  assert.equal(s.spawned.length, 1);
  const { bin, args, opts, profile } = s.spawned[0];
  assert.equal(bin, BIN);
  assert.deepEqual(args, [
    `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--window-size=520,820', 'https://www.kufar.by/login/',
  ]);
  assert.ok(!args.some((a) => a.startsWith('--remote-debugging-port') || a.startsWith('--headless')));
  assert.deepEqual(opts, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
});

test('loginWindow: findBrowserImpl gets platform and env', T, async () => {
  const env = { KUFAR_BROWSER: BIN };
  const s = await setup({ env });
  await s.run();
  assert.deepEqual(s.finds, [{ platform: 'darwin', env }]);
});

test('loginWindow: the profile is login-profile-<12 hex> inside the state dir, a 0700 directory at spawn time', T, async () => {
  const s = await setup();
  await s.run();
  const { profile, profileIsDir, profileMode } = s.spawned[0];
  assert.equal(path.dirname(profile), s.stateDir);
  assert.match(path.basename(profile), PROFILE_RE);
  assert.equal(profileIsDir, true);
  assert.equal(profileMode, 0o700);
});

test('loginWindow: two runs use two different profile directories', T, async () => {
  const stateDir = await tmpDir();
  const profiles = [];
  for (let i = 0; i < 2; i += 1) {
    const clock = fakeClock();
    const child = fakeBrowserProcess({ handler: withPoll(['page', 'token']) });
    await loginWindow({
      stateDir, waitMs: 3000, pollMs: 1000, closeWaitMs: 40, platform: 'darwin', env: {}, now: clock.now, sleep: clock.sleep,
      findBrowserImpl: async () => BIN,
      spawnImpl: (bin, args) => { profiles.push(readProfileArg(args)); return child; },
    });
  }
  assert.equal(profiles.length, 2);
  assert.notEqual(profiles[0], profiles[1]);
  for (const p of profiles) assert.match(path.basename(p), PROFILE_RE);
});

test('loginWindow: a profile of another run in the state dir is not touched', T, async () => {
  let other;
  const s = await setup({
    beforeSpawn: (profile) => { other = path.join(path.dirname(profile), 'login-profile-000000000000'); fs.mkdirSync(other); },
  });
  await s.run();
  assert.equal(exists(other), true);
  assert.deepEqual(await left(s.stateDir), ['login-profile-000000000000']);
});

test('loginWindow: files the browser put into the profile are removed with it', T, async () => {
  const s = await setup({
    beforeSpawn: (profile) => {
      fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'Default', 'Cookies'), `k_jwt=${KJWT}`);
    },
  });
  await s.run();
  assert.deepEqual(await left(s.stateDir), []);
});

test('loginWindow: the only cookie request is Network.getCookies with kufar.by urls', T, async () => {
  const s = await setup();
  await s.run();
  assert.ok(s.child.sent.some((m) => m.method === 'Network.getCookies'));
  assertCookieRequestsSafe(s.child.sent);
});

test('loginWindow: polls with pollMs until the key appears', T, async () => {
  const s = await setup();
  await s.run();
  assert.deepEqual(s.clock.sleeps, [1000]);
});

test('loginWindow: a failing Browser.close is swallowed, the key is still returned', T, async () => {
  const base = withPoll(['token']);
  const handler = (msg) => (msg.method === 'Browser.close' ? { error: { code: -32000, message: 'fake' } } : base(msg));
  const s = await setup({ handler, proc: fakeBrowserProcess({ handler, exitOnClose: false }) });
  assert.equal(await s.run(), KJWT);
  assert.deepEqual(await left(s.stateDir), []);
});

test('loginWindow: a browser that does not exit on Browser.close is killed, the key is still returned', T, async () => {
  const proc = fakeBrowserProcess({ handler: withPoll(['token']), exitOnClose: false });
  const s = await setup({ proc });
  assert.equal(await s.run(), KJWT);
  assert.ok(proc.sent.some((m) => m.method === 'Browser.close'));
  assert.equal(proc.killed, 1);
  assert.deepEqual(await left(s.stateDir), []);
});

test('loginWindow: a kill that throws does not replace the key', T, async () => {
  const proc = fakeBrowserProcess({ handler: withPoll(['token']), exitOnClose: false });
  proc.kill = () => { proc.killed += 1; throw new Error('kill failed'); };
  const s = await setup({ proc });
  assert.equal(await s.run(), KJWT);
  assert.deepEqual(await left(s.stateDir), []);
});

test('loginWindow: nobody logs in -> LOGIN_TIMEOUT, window closed, no profile left', T, async () => {
  const s = await setup({ handler: withPoll(['page']), waitMs: 2000 });
  await rejectsCode(s.run(), 'LOGIN_TIMEOUT');
  assert.ok(s.child.sent.some((m) => m.method === 'Browser.close'), 'Browser.close not sent');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
  assertCookieRequestsSafe(s.child.sent);
});

test('loginWindow: a timeout does not leave the profile even when the browser filled it', T, async () => {
  const s = await setup({
    handler: withPoll(['page']), waitMs: 2000,
    beforeSpawn: (profile) => { fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.writeFileSync(path.join(profile, 'Default', 'x'), 'y'); },
  });
  await rejectsCode(s.run(), 'LOGIN_TIMEOUT');
  assert.deepEqual(await left(s.stateDir), []);
});

test('loginWindow: signal aborted while waiting -> LOGIN_CANCELLED, window closed, no profile left', T, async () => {
  const ac = new AbortController();
  let getTargets = 0;
  const base = withPoll(['page']);
  const handler = (msg) => { if (msg.method === 'Target.getTargets' && ++getTargets === 2) ac.abort(); return base(msg); };
  const s = await setup({ handler, signal: ac.signal, waitMs: 60000 });
  await rejectsCode(s.run(), 'LOGIN_CANCELLED');
  assert.ok(s.child.sent.some((m) => m.method === 'Browser.close'), 'Browser.close not sent');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('loginWindow: the window is closed after a poll was answered -> LOGIN_CANCELLED, no profile left', T, async () => {
  let getTargets = 0;
  const base = withPoll(['page']);
  const proc = fakeBrowserProcess({ handler: (msg, p) => { if (msg.method === 'Target.getTargets' && ++getTargets === 2) { p.die(0); return undefined; } return base(msg); } });
  const s = await setup({ proc, waitMs: 60000 });
  await rejectsCode(s.run(), 'LOGIN_CANCELLED');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('loginWindow: a browser that is already gone is not sent Browser.close and not killed', T, async () => {
  let getTargets = 0;
  const base = withPoll(['page']);
  const proc = fakeBrowserProcess({ handler: (msg, p) => { if (msg.method === 'Target.getTargets' && ++getTargets === 2) { p.die(0); return undefined; } return base(msg); } });
  const s = await setup({ proc, waitMs: 60000 });
  await rejectsCode(s.run(), 'LOGIN_CANCELLED');
  assert.ok(!proc.sent.some((m) => m.method === 'Browser.close'));
  assert.equal(proc.killed, 0);
});

test('loginWindow: the process exits before it answered anything -> BROWSER_UNAVAILABLE, no profile left', T, async () => {
  const proc = fakeBrowserProcess({ handler: (msg, p) => { p.die(1); } });
  const s = await setup({ proc, waitMs: 60000 });
  await rejectsCode(s.run(), 'BROWSER_UNAVAILABLE');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('loginWindow: the channel ends before the exit event after answered polls -> LOGIN_CANCELLED, the process is killed', T, async () => {
  let getTargets = 0;
  const base = withPoll(['page']);
  const proc = fakeBrowserProcess({
    exitOnClose: false,
    handler: (msg, p) => {
      const out = base(msg);
      if (msg.method === 'Target.getTargets' && ++getTargets === 2) setImmediate(() => p.stdio[4].end());
      return out;
    },
  });
  const s = await setup({ proc, waitMs: 60000 });
  await rejectsCode(s.run(), 'LOGIN_CANCELLED');
  assert.equal(proc.killed, 1, 'still running without a channel: killed');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('loginWindow: spawn error event -> BROWSER_UNAVAILABLE, no profile left, no Browser.close', T, async () => {
  const proc = fakeBrowserProcess();
  const s = await setup({ proc });
  // the spawn failure arrives once the code under test listens for `error`
  proc.on('newListener', (ev) => { if (ev === 'error') setImmediate(() => proc.fail(new Error('spawn ENOENT'))); });
  await rejectsCode(s.run(), 'BROWSER_UNAVAILABLE');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
  assert.ok(!proc.sent.some((m) => m.method === 'Browser.close'));
});

test('loginWindow: linux without DISPLAY and WAYLAND_DISPLAY -> NO_DISPLAY before anything else', T, async () => {
  const s = await setup({ platform: 'linux', env: { PATH: '/usr/bin' } });
  await rejectsCode(s.run(), 'NO_DISPLAY');
  assert.equal(s.spawned.length, 0);
  assert.equal(s.finds.length, 0, 'the browser is not even looked for');
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('loginWindow: darwin over SSH -> NO_DISPLAY, spawn not called', T, async () => {
  const s = await setup({ platform: 'darwin', env: { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' } });
  await rejectsCode(s.run(), 'NO_DISPLAY');
  assert.equal(s.spawned.length, 0);
});

test('loginWindow: linux with DISPLAY or with WAYLAND_DISPLAY opens the window', T, async () => {
  for (const env of [{ DISPLAY: ':99' }, { WAYLAND_DISPLAY: 'wayland-99' }]) {
    const s = await setup({ platform: 'linux', env });
    assert.equal(await s.run(), KJWT);
    assert.equal(s.spawned.length, 1);
  }
});

test('loginWindow: other platforms need no DISPLAY', T, async () => {
  for (const platform of ['darwin', 'win32']) {
    const s = await setup({ platform, env: {} });
    assert.equal(await s.run(), KJWT);
  }
});

test('loginWindow: browser not found -> the error is passed on, nothing spawned, no profile made', T, async () => {
  const s = await setup({ findImpl: async () => { throw failure('BROWSER_NOT_FOUND'); } });
  await rejectsCode(s.run(), 'BROWSER_NOT_FOUND');
  assert.equal(s.spawned.length, 0);
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

// ---- sweepLoginProfiles ----

test('sweepLoginProfiles: removes login-profile and login-profile-* directories, nothing else', T, async () => {
  const dir = await tmpDir();
  for (const d of ['login-profile-aaa', 'login-profile', 'login-profile-0123456789ab', 'cache', 'other-profile', 'my-login-profile']) {
    await fsp.mkdir(path.join(dir, d, 'Default'), { recursive: true });
    await fsp.writeFile(path.join(dir, d, 'Default', 'Cookies'), 'x');
  }
  for (const f of ['auth.json', 'login-pending.json', 'login-window.json']) await fsp.writeFile(path.join(dir, f), '{}');
  assert.equal(await sweepLoginProfiles(dir), undefined);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['auth.json', 'cache', 'login-pending.json', 'login-window.json', 'my-login-profile', 'other-profile']);
});

test('sweepLoginProfiles: a missing state dir is not an error', T, async () => {
  const base = await tmpDir();
  assert.equal(await sweepLoginProfiles(path.join(base, 'nope')), undefined);
});

test('sweepLoginProfiles: an empty state dir is not an error and stays empty', T, async () => {
  const dir = await tmpDir();
  assert.equal(await sweepLoginProfiles(dir), undefined);
  assert.deepEqual(await fsp.readdir(dir), []);
});

// ---- loginWindowStatus ----

const WINDOW_FILE = (dir) => path.join(dir, 'login-window.json');
const writeWindow = (dir, data) => fsp.writeFile(WINDOW_FILE(dir), typeof data === 'string' ? data : JSON.stringify(data));
const waiting = (over = {}) => ({ state: 'waiting', pid: 4242, started_at: NOW, deadline: NOW + 90_000, ...over });
const alive = (...pids) => (pid) => pids.includes(pid);

test('loginWindowStatus: no file -> null', T, async () => {
  assert.equal(await loginWindowStatus(await tmpDir(), { now: () => NOW, isAlive: alive() }), null);
});

test('loginWindowStatus: a file of the wrong kind -> null', T, async () => {
  for (const content of ['garbage', '', '[]', '{}', '42', 'null', '{"state":"bogus"}', '{"state":5}']) {
    const dir = await tmpDir();
    await writeWindow(dir, content);
    assert.equal(await loginWindowStatus(dir, { now: () => NOW, isAlive: alive(4242) }), null, JSON.stringify(content));
  }
});

test('loginWindowStatus: waiting with a live pid -> seconds_left rounded up', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, waiting({ deadline: NOW + 90_500 }));
  const seen = [];
  const isAlive = (pid) => { seen.push(pid); return true; };
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW, isAlive }), { state: 'waiting', seconds_left: 91 });
  assert.deepEqual(seen, [4242]);
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW + 90_000, isAlive }), { state: 'waiting', seconds_left: 1 });
});

test('loginWindowStatus: waiting past the deadline but within 30 s of it, pid alive -> waiting with 0 seconds left', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, waiting());
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW + 90_000, isAlive: alive(4242) }), { state: 'waiting', seconds_left: 0 });
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW + 100_000, isAlive: alive(4242) }), { state: 'waiting', seconds_left: 0 });
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW + 120_000, isAlive: alive(4242) }), { state: 'waiting', seconds_left: 0 });
});

test('loginWindowStatus: waiting more than 30 s past the deadline -> failed BROWSER_UNAVAILABLE even if the pid is alive', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, waiting());
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW + 120_001, isAlive: alive(4242) }), { state: 'failed', code: 'BROWSER_UNAVAILABLE' });
});

test('loginWindowStatus: waiting with a dead pid -> failed BROWSER_UNAVAILABLE', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, waiting());
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW, isAlive: alive(1) }), { state: 'failed', code: 'BROWSER_UNAVAILABLE' });
});

test('loginWindowStatus: failed -> the code from the file and nothing else', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, { state: 'failed', code: 'LOGIN_TIMEOUT', at: NOW - 5000 });
  assert.deepEqual(await loginWindowStatus(dir, { now: () => NOW, isAlive: alive() }), { state: 'failed', code: 'LOGIN_TIMEOUT' });
});

test('loginWindowStatus: reading changes nothing in the state dir', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, waiting());
  const before = await fsp.readFile(WINDOW_FILE(dir), 'utf8');
  await loginWindowStatus(dir, { now: () => NOW + 500_000, isAlive: alive() });
  assert.equal(await fsp.readFile(WINDOW_FILE(dir), 'utf8'), before);
});

// ---- startLogin ----

function startSetup({ platform = 'darwin', env = {}, pid = 4242, waitMs = 90_000, findImpl, isAlive = alive() } = {}) {
  return tmpDir().then((stateDir) => {
    const spawns = [];
    const finds = [];
    const seenAtSpawn = [];
    const spawnWorker = () => {
      spawns.push(1);
      seenAtSpawn.push(fs.readdirSync(stateDir));
      return pid;
    };
    const findBrowserImpl = findImpl ?? (async (a) => { finds.push(a); return BIN; });
    const run = (over = {}) => startLogin({
      stateDir, waitMs, platform, env, findBrowserImpl, spawnWorker, now: () => NOW, isAlive, ...over,
    });
    return { stateDir, spawns, finds, seenAtSpawn, run };
  });
}

test('startLogin: success starts the worker once, writes the waiting state with its pid and deadline, answers window_opened', T, async () => {
  const s = await startSetup();
  assert.deepEqual(await s.run(), { login: 'window_opened', seconds_left: 90 });
  assert.equal(s.spawns.length, 1);
  assert.deepEqual(JSON.parse(await fsp.readFile(WINDOW_FILE(s.stateDir), 'utf8')), {
    state: 'waiting', pid: 4242, started_at: NOW, deadline: NOW + 90_000,
  });
  assert.equal((await fsp.stat(WINDOW_FILE(s.stateDir))).mode & 0o777, 0o600);
  assert.deepEqual(s.finds, [{ platform: 'darwin', env: {} }]);
});

test('startLogin: the default wait is 300 seconds', T, async () => {
  const stateDir = await tmpDir();
  const r = await startLogin({
    stateDir, platform: 'darwin', env: {}, findBrowserImpl: async () => BIN, spawnWorker: () => 7, now: () => NOW, isAlive: alive(),
  });
  assert.deepEqual(r, { login: 'window_opened', seconds_left: 300 });
  assert.equal(JSON.parse(await fsp.readFile(WINDOW_FILE(stateDir), 'utf8')).deadline, NOW + 300_000);
});

test('startLogin: a login already waiting -> waiting, no second worker, the state file is unchanged', T, async () => {
  const s = await startSetup({ isAlive: alive(555) });
  await writeWindow(s.stateDir, waiting({ pid: 555, deadline: NOW + 60_000 }));
  const before = await fsp.readFile(WINDOW_FILE(s.stateDir), 'utf8');
  assert.deepEqual(await s.run(), { login: 'waiting', seconds_left: 60 });
  assert.equal(s.spawns.length, 0);
  assert.equal(s.finds.length, 0);
  assert.equal(await fsp.readFile(WINDOW_FILE(s.stateDir), 'utf8'), before);
});

test('startLogin: a previous failure or a vanished worker does not block a new login', T, async () => {
  for (const prev of [{ state: 'failed', code: 'LOGIN_TIMEOUT', at: NOW - 1000 }, waiting({ pid: 555 })]) {
    const s = await startSetup({ isAlive: alive() });
    await writeWindow(s.stateDir, prev);
    assert.deepEqual(await s.run(), { login: 'window_opened', seconds_left: 90 });
    assert.equal(s.spawns.length, 1);
    assert.equal(JSON.parse(await fsp.readFile(WINDOW_FILE(s.stateDir), 'utf8')).state, 'waiting');
  }
});

test('startLogin: no display -> NO_DISPLAY, no worker, no state file, the browser is not looked for', T, async () => {
  const s = await startSetup({ platform: 'linux', env: { PATH: '/usr/bin' } });
  await rejectsCode(s.run(), 'NO_DISPLAY');
  assert.equal(s.spawns.length, 0);
  assert.equal(s.finds.length, 0);
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('startLogin: darwin over SSH -> NO_DISPLAY', T, async () => {
  const s = await startSetup({ platform: 'darwin', env: { SSH_TTY: '/dev/ttys001' } });
  await rejectsCode(s.run(), 'NO_DISPLAY');
  assert.equal(s.spawns.length, 0);
});

test('startLogin: the error of findBrowserImpl is passed on, no worker, no state file', T, async () => {
  const s = await startSetup({ findImpl: async () => { throw failure('BROWSER_NOT_FOUND'); } });
  await rejectsCode(s.run(), 'BROWSER_NOT_FOUND');
  assert.equal(s.spawns.length, 0);
  assert.deepEqual(await fsp.readdir(s.stateDir), []);
});

test('startLogin: old login-profile* directories are removed before the worker starts; other files stay', T, async () => {
  const s = await startSetup();
  for (const d of ['login-profile', 'login-profile-aaaaaaaaaaaa']) await fsp.mkdir(path.join(s.stateDir, d, 'Default'), { recursive: true });
  await fsp.writeFile(path.join(s.stateDir, 'auth.json'), '{}');
  await s.run();
  assert.deepEqual(s.seenAtSpawn, [['auth.json']]);
});

// ---- runLoginWorker ----

async function workerSetup({ withWindowFile = true } = {}) {
  const stateDir = await tmpDir();
  if (withWindowFile) await writeWindow(stateDir, waiting());
  return stateDir;
}

test('runLoginWorker: success -> auth.json saved, login-window.json removed, nothing thrown', T, async () => {
  const stateDir = await workerSetup();
  const calls = [];
  const ac = new AbortController();
  const loginWindowImpl = async (args) => { calls.push(args); return KJWT; };
  assert.equal(await runLoginWorker({ stateDir, waitMs: 90_000, now: () => NOW, loginWindowImpl, signal: ac.signal, pollMs: 7 }), undefined);
  assert.equal(JSON.parse(await fsp.readFile(path.join(stateDir, 'auth.json'), 'utf8')).token, KJWT);
  assert.equal(exists(WINDOW_FILE(stateDir)), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stateDir, stateDir);
  assert.equal(calls[0].waitMs, 90_000);
  assert.equal(calls[0].signal, ac.signal);
  assert.equal(calls[0].pollMs, 7, 'other arguments are passed on');
});

for (const [name, impl, code] of [
  ['LOGIN_TIMEOUT', async () => { throw failure('LOGIN_TIMEOUT'); }, 'LOGIN_TIMEOUT'],
  ['LOGIN_CANCELLED', async () => { throw failure('LOGIN_CANCELLED'); }, 'LOGIN_CANCELLED'],
  ['BROWSER_UNAVAILABLE', async () => { throw failure('BROWSER_UNAVAILABLE'); }, 'BROWSER_UNAVAILABLE'],
  ['a plain Error', async () => { throw new Error('SECRET-TEXT-MARK'); }, 'INTERNAL'],
  ['a TypeError', async () => { throw new TypeError('SECRET-TEXT-MARK'); }, 'INTERNAL'],
]) {
  test(`runLoginWorker: loginWindowImpl throws ${name} -> state failed/${code}, no auth.json, nothing thrown`, T, async () => {
    const stateDir = await workerSetup();
    assert.equal(await runLoginWorker({ stateDir, waitMs: 90_000, now: () => NOW, loginWindowImpl: impl }), undefined);
    const text = await fsp.readFile(WINDOW_FILE(stateDir), 'utf8');
    assert.deepEqual(JSON.parse(text), { state: 'failed', code, at: NOW });
    assert.ok(!text.includes('SECRET-TEXT-MARK'));
    assert.equal(exists(path.join(stateDir, 'auth.json')), false);
  });
}

test('runLoginWorker: a key that fails parseToken -> failed/BAD_TOKEN, no auth.json, the value is not written anywhere', T, async () => {
  const stateDir = await workerSetup();
  await runLoginWorker({ stateDir, waitMs: 90_000, now: () => NOW, loginWindowImpl: async () => 'KEY-MARK-garbage.only' });
  const text = await fsp.readFile(WINDOW_FILE(stateDir), 'utf8');
  assert.deepEqual(JSON.parse(text), { state: 'failed', code: 'BAD_TOKEN', at: NOW });
  assert.equal(exists(path.join(stateDir, 'auth.json')), false);
  for (const f of await fsp.readdir(stateDir)) assert.ok(!(await fsp.readFile(path.join(stateDir, f), 'utf8')).includes('KEY-MARK'));
});

test('runLoginWorker: an expired key -> failed/AUTH_EXPIRED, no auth.json', T, async () => {
  const stateDir = await workerSetup();
  const expired = makeToken(Math.floor((NOW - DAY) / 1000));
  await runLoginWorker({ stateDir, waitMs: 90_000, now: () => NOW, loginWindowImpl: async () => expired });
  assert.deepEqual(JSON.parse(await fsp.readFile(WINDOW_FILE(stateDir), 'utf8')), { state: 'failed', code: 'AUTH_EXPIRED', at: NOW });
  assert.equal(exists(path.join(stateDir, 'auth.json')), false);
});

test('runLoginWorker: a failure replaces the waiting state, also when there was no file before', T, async () => {
  const stateDir = await workerSetup({ withWindowFile: false });
  await runLoginWorker({ stateDir, waitMs: 90_000, now: () => NOW, loginWindowImpl: async () => { throw failure('LOGIN_TIMEOUT'); } });
  assert.deepEqual(await loginWindowStatus(stateDir, { now: () => NOW, isAlive: alive() }), { state: 'failed', code: 'LOGIN_TIMEOUT' });
});

test('runLoginWorker: stopped through the signal -> no failure is recorded, the state file is left as it was', T, async () => {
  for (const withWindowFile of [true, false]) {
    const stateDir = await workerSetup({ withWindowFile });
    const before = withWindowFile ? await fsp.readFile(WINDOW_FILE(stateDir), 'utf8') : null;
    const ac = new AbortController();
    const loginWindowImpl = async () => { ac.abort(); throw failure('LOGIN_CANCELLED'); };
    assert.equal(await runLoginWorker({ stateDir, waitMs: 90_000, now: () => NOW, loginWindowImpl, signal: ac.signal }), undefined);
    assert.equal(exists(WINDOW_FILE(stateDir)), withWindowFile);
    if (withWindowFile) assert.equal(await fsp.readFile(WINDOW_FILE(stateDir), 'utf8'), before);
    assert.equal(exists(path.join(stateDir, 'auth.json')), false);
  }
});

// ---- stopLoginWindow ----

test('stopLoginWindow: a login that is waiting -> kill(pid, SIGTERM) and the file removed', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, waiting({ pid: 555 }));
  const kills = [];
  assert.equal(await stopLoginWindow(dir, { now: () => NOW, isAlive: alive(555), kill: (...a) => { kills.push(a); } }), undefined);
  assert.deepEqual(kills, [[555, 'SIGTERM']]);
  assert.equal(exists(WINDOW_FILE(dir)), false);
});

test('stopLoginWindow: no login, a dead worker or a failed state -> kill not called, the file removed', T, async () => {
  const noFile = await tmpDir();
  const dead = await tmpDir();
  await writeWindow(dead, waiting({ pid: 555 }));
  const failed = await tmpDir();
  await writeWindow(failed, { state: 'failed', code: 'LOGIN_TIMEOUT', at: NOW });
  const garbage = await tmpDir();
  await writeWindow(garbage, 'garbage');
  const kills = [];
  const kill = (...a) => { kills.push(a); };
  for (const dir of [noFile, dead, failed, garbage]) {
    assert.equal(await stopLoginWindow(dir, { now: () => NOW, isAlive: alive(), kill }), undefined);
    assert.equal(exists(WINDOW_FILE(dir)), false);
  }
  assert.deepEqual(kills, []);
});

test('stopLoginWindow: a kill that throws is swallowed and the file is removed', T, async () => {
  const dir = await tmpDir();
  await writeWindow(dir, waiting({ pid: 555 }));
  const kill = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
  assert.equal(await stopLoginWindow(dir, { now: () => NOW, isAlive: alive(555), kill }), undefined);
  assert.equal(exists(WINDOW_FILE(dir)), false);
});

test('stopLoginWindow: a missing state dir is not an error', T, async () => {
  const base = await tmpDir();
  assert.equal(await stopLoginWindow(path.join(base, 'nope'), { now: () => NOW, isAlive: alive(), kill: () => {} }), undefined);
});
