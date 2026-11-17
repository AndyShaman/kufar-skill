import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTransport } from '../scripts/lib/transport.mjs';
import { KufarError } from '../scripts/lib/errors.mjs';
import { tmpDir, rejectsCode } from './helpers.mjs';

const NOW = 1_000_000;
const readNetwork = async (dir) => JSON.parse(await fs.readFile(path.join(dir, 'network.json'), 'utf8'));
const COUNT = '/search-api/v2/search/count';

function res(status, body = '{}', headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

async function setup({ responses = [res(200, { ok: true })], last, random = () => 0 } = {}) {
  const stateDir = await tmpDir();
  if (last !== undefined) await fs.writeFile(path.join(stateDir, 'network.json'), JSON.stringify({ last }));
  const fetches = [];
  const sleeps = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r instanceof Error) throw r;
    return r;
  };
  const transport = createTransport({
    stateDir, fetchImpl, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, random,
  });
  return { stateDir, fetches, sleeps, transport };
}

test('path outside allow list is rejected before fetch', async () => {
  for (const p of ['/foo', '/search-api/v2/item/abc/rendered', '/search-api/v2/item//rendered', '/search-api/v2/search']) {
    const { transport, fetches } = await setup();
    await rejectsCode(transport.getJson(p), 'PATH_NOT_ALLOWED');
    assert.equal(fetches.length, 0);
  }
});

test('item path with digits is allowed', async () => {
  const { transport, fetches } = await setup();
  await transport.getJson('/search-api/v2/item/1000000001/rendered', { lang: 'ru' });
  assert.equal(fetches[0].url, 'https://api.kufar.by/search-api/v2/item/1000000001/rendered?lang=ru');
});

test('request url, method, redirect and headers', async () => {
  const { transport, fetches } = await setup();
  const r = await transport.getJson(COUNT, { cat: '17010', a: undefined, b: null, lang: 'ru' });
  assert.deepEqual(r, { ok: true });
  const { url, init } = fetches[0];
  assert.equal(url, 'https://api.kufar.by/search-api/v2/search/count?cat=17010&lang=ru');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Accept, 'application/json');
  assert.equal(init.headers['Accept-Language'], 'ru');
  assert.match(init.headers['User-Agent'], /^kufar-skill\/\S+/);
});

test('pause with random 0 waits remaining interval', async () => {
  const { transport, sleeps } = await setup({ last: NOW - 100 });
  await transport.getJson(COUNT);
  assert.deepEqual(sleeps, [400]);
});

test('pause with random 0.5 adds half of jitter', async () => {
  const { transport, sleeps } = await setup({ last: NOW - 100, random: () => 0.5 });
  await transport.getJson(COUNT);
  assert.deepEqual(sleeps, [600]);
});

test('no network.json means no sleep', async () => {
  const { transport, sleeps } = await setup();
  await transport.getJson(COUNT);
  assert.deepEqual(sleeps, []);
});

test('last request time is saved after request', async () => {
  const { transport, stateDir } = await setup();
  await transport.getJson(COUNT);
  assert.equal((await readNetwork(stateDir)).last, NOW);
});

test('saved last equals planned start, not time after sleep', async () => {
  const { transport, stateDir } = await setup({ last: NOW - 100 });
  await transport.getJson(COUNT);
  assert.equal((await readNetwork(stateDir)).last, NOW + 400);
});

test('network.json is written before sleep', async () => {
  const stateDir = await tmpDir();
  await fs.writeFile(path.join(stateDir, 'network.json'), JSON.stringify({ last: NOW - 100 }));
  const seen = [];
  const transport = createTransport({
    stateDir,
    fetchImpl: async () => res(200, { ok: true }),
    now: () => NOW,
    random: () => 0,
    sleep: async (ms) => { seen.push({ ms, last: (await readNetwork(stateDir)).last }); },
  });
  await transport.getJson(COUNT);
  assert.deepEqual(seen, [{ ms: 400, last: NOW + 400 }]);
});

test('no sleep when interval already passed', async () => {
  const { transport, sleeps, stateDir } = await setup({ last: NOW - 10_000 });
  await transport.getJson(COUNT);
  assert.deepEqual(sleeps, []);
  assert.equal((await readNetwork(stateDir)).last, NOW);
});

test('404 is NOT_FOUND', async () => {
  const { transport } = await setup({ responses: [res(404)] });
  await rejectsCode(transport.getJson(COUNT), 'NOT_FOUND');
});

test('403 with restriction text is GEO_BLOCKED', async () => {
  const { transport } = await setup({ responses: [res(403, '<html>Доступ ограничен</html>')] });
  await rejectsCode(transport.getJson(COUNT), 'GEO_BLOCKED');
});

test('403 without restriction text is FORBIDDEN', async () => {
  const { transport } = await setup({ responses: [res(403, 'nope')] });
  await rejectsCode(transport.getJson(COUNT), 'FORBIDDEN');
});

for (const status of [429, 503]) {
  test(`${status} then 200 retries once, sleeping Retry-After`, async () => {
    const { transport, fetches, sleeps } = await setup({
      responses: [res(status, '', { 'Retry-After': '3' }), res(200, { ok: 1 })],
    });
    assert.deepEqual(await transport.getJson(COUNT), { ok: 1 });
    assert.equal(fetches.length, 2);
    assert.ok(sleeps.includes(3000));
  });

  test(`${status} twice is RATE_LIMITED after one retry`, async () => {
    const { transport, fetches } = await setup({ responses: [res(status)] });
    await rejectsCode(transport.getJson(COUNT), 'RATE_LIMITED');
    assert.equal(fetches.length, 2);
  });
}

test('429 without Retry-After sleeps 5 seconds', async () => {
  const { transport, sleeps } = await setup({ responses: [res(429), res(200)] });
  await transport.getJson(COUNT);
  assert.ok(sleeps.includes(5000));
});

test('Retry-After is capped at 30 seconds', async () => {
  const { transport, sleeps } = await setup({ responses: [res(429, '', { 'Retry-After': '120' }), res(200)] });
  await transport.getJson(COUNT);
  assert.ok(sleeps.includes(30000));
  assert.ok(!sleeps.some((s) => s > 30000));
});

test('500 is HTTP_ERROR with status', async () => {
  const { transport } = await setup({ responses: [res(500)] });
  await assert.rejects(transport.getJson(COUNT), (e) => {
    assert.equal(e.code, 'HTTP_ERROR');
    assert.equal(e.details.status, 500);
    return true;
  });
});

test('302 is HTTP_ERROR', async () => {
  const { transport } = await setup({ responses: [res(302)] });
  await rejectsCode(transport.getJson(COUNT), 'HTTP_ERROR');
});

test('non-JSON 200 is BAD_RESPONSE', async () => {
  const { transport } = await setup({ responses: [res(200, 'not json')] });
  await rejectsCode(transport.getJson(COUNT), 'BAD_RESPONSE');
});

test('TimeoutError is TIMEOUT', async () => {
  const e = new Error('slow');
  e.name = 'TimeoutError';
  const { transport } = await setup({ responses: [e] });
  await rejectsCode(transport.getJson(COUNT), 'TIMEOUT');
});

test('other fetch exception is NETWORK', async () => {
  const { transport } = await setup({ responses: [new TypeError('fetch failed')] });
  await rejectsCode(transport.getJson(COUNT), 'NETWORK');
});

// ---- step 2: paths under login and the Authorization header ----

const KEY = 'SECRET-KEY-AAAA.SECRET-KEY-BBBB.SECRET-KEY-CCCC';
const UUID = '11111111-2222-4333-8444-555555555555';
const LOGIN_PATHS = [
  '/my-items-v2/v1/items/count',
  '/my-items-v2/v2/items',
  '/messaging-api/v1/counter',
  '/messaging-api/v4/conversations',
  `/messaging-api/v4/conversations/${UUID}/messages`,
];
const OPEN_PATHS = [COUNT, '/search-api/v2/item/1000000001/rendered', '/search-api/v2/search/rendered-paginated', '/insertion/v1/meta/bootstrap'];

async function setupAuth({ responses = [res(200, { ok: true })], last, getToken, random = () => 0 } = {}) {
  const stateDir = await tmpDir();
  if (last !== undefined) await fs.writeFile(path.join(stateDir, 'network.json'), JSON.stringify({ last }));
  const fetches = [];
  const sleeps = [];
  const tokenCalls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r instanceof Error) throw r;
    return r;
  };
  const transport = createTransport({
    stateDir, fetchImpl, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, random,
    ...(getToken === null ? {} : { getToken: getToken ?? (async () => { tokenCalls.push(1); return KEY; }) }),
  });
  return { stateDir, fetches, sleeps, tokenCalls, transport };
}

const authHeader = (init) => {
  const k = Object.keys(init.headers).find((h) => h.toLowerCase() === 'authorization');
  return k === undefined ? undefined : init.headers[k];
};
const errText = (e) => JSON.stringify({ message: e.message, details: e.details });

test('paths under login are allowed', async () => {
  for (const p of LOGIN_PATHS) {
    const { transport, fetches } = await setupAuth();
    await transport.getJson(p, { limit: 5 });
    assert.equal(fetches.length, 1, p);
    assert.equal(new URL(fetches[0].url).origin, 'https://api.kufar.by');
    assert.equal(new URL(fetches[0].url).pathname, p);
  }
});

test('conversation path accepts upper-case hex in the uuid', async () => {
  const { transport, fetches } = await setupAuth();
  await transport.getJson('/messaging-api/v4/conversations/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE/messages');
  assert.equal(fetches.length, 1);
});

test('login paths with a bad shape are rejected before fetch and before getToken', async () => {
  const bad = [
    '/messaging-api/v4/conversations/not-a-uuid/messages',
    '/messaging-api/v4/conversations//messages',
    `/messaging-api/v4/conversations/${UUID}`,
    `/messaging-api/v4/conversations/${UUID}/messages/extra`,
    `/messaging-api/v4/conversations/${UUID}x/messages`,
    '/messaging-api/v4/conversations/11111111-2222-4333-8444-55555555555/messages',
    '/my-items-v2/v2/items/1',
    '/my-items-v2/v1/items',
    '/messaging-api/v1/counter/x',
  ];
  for (const p of bad) {
    const { transport, fetches, tokenCalls } = await setupAuth();
    await rejectsCode(transport.getJson(p), 'PATH_NOT_ALLOWED');
    assert.equal(fetches.length, 0, p);
    assert.equal(tokenCalls.length, 0, p);
  }
});

test('login path gets Authorization: Bearer <key>, GET and redirect manual', async () => {
  for (const p of LOGIN_PATHS) {
    const { transport, fetches, tokenCalls } = await setupAuth();
    await transport.getJson(p);
    assert.equal(authHeader(fetches[0].init), `Bearer ${KEY}`, p);
    assert.equal(fetches[0].init.method, 'GET');
    assert.equal(fetches[0].init.redirect, 'manual');
    assert.equal(tokenCalls.length, 1);
  }
});

test('open path never gets Authorization even when getToken is given, and getToken is not called', async () => {
  for (const p of OPEN_PATHS) {
    const { transport, fetches, tokenCalls } = await setupAuth();
    await transport.getJson(p);
    assert.equal(authHeader(fetches[0].init), undefined, p);
    assert.ok(!JSON.stringify(fetches[0]).includes(KEY));
    assert.equal(tokenCalls.length, 0, p);
  }
});

test('login path without getToken is AUTH_REQUIRED and makes no network call', async () => {
  for (const p of LOGIN_PATHS) {
    const { transport, fetches } = await setupAuth({ getToken: null });
    await rejectsCode(transport.getJson(p), 'AUTH_REQUIRED');
    assert.equal(fetches.length, 0, p);
  }
});

test('open path without getToken still works', async () => {
  const { transport, fetches } = await setupAuth({ getToken: null });
  await transport.getJson(COUNT);
  assert.equal(fetches.length, 1);
});

test('error from getToken is passed on as is, with no network call and no pause', async () => {
  const boom = new KufarError('AUTH_EXPIRED', 'ключ просрочен');
  const { transport, fetches, sleeps } = await setupAuth({ getToken: async () => { throw boom; }, last: NOW - 100 });
  await assert.rejects(transport.getJson(LOGIN_PATHS[0]), (e) => e === boom);
  assert.equal(fetches.length, 0);
  assert.deepEqual(sleeps, []);
});

test('getToken runs before the pause', async () => {
  const order = [];
  const stateDir = await tmpDir();
  await fs.writeFile(path.join(stateDir, 'network.json'), JSON.stringify({ last: NOW - 100 }));
  const transport = createTransport({
    stateDir,
    fetchImpl: async () => { order.push('fetch'); return res(200, { ok: true }); },
    now: () => NOW,
    random: () => 0,
    sleep: async () => { order.push('sleep'); },
    getToken: async () => { order.push('token'); return KEY; },
  });
  await transport.getJson(LOGIN_PATHS[0]);
  assert.deepEqual(order, ['token', 'sleep', 'fetch']);
});

test('401 on a login path is AUTH_EXPIRED with status 401', async () => {
  const { transport } = await setupAuth({ responses: [res(401, '')] });
  await assert.rejects(transport.getJson(LOGIN_PATHS[0]), (e) => {
    assert.equal(e.name, 'KufarError');
    assert.equal(e.code, 'AUTH_EXPIRED');
    assert.equal(e.details.status, 401);
    return true;
  });
});

for (const status of [429, 503]) {
  test(`${status} then 200 on a login path: getToken once, same header on the retry`, async () => {
    const { transport, fetches, tokenCalls } = await setupAuth({ responses: [res(status, '', { 'Retry-After': '1' }), res(200, { ok: 1 })] });
    assert.deepEqual(await transport.getJson(LOGIN_PATHS[2]), { ok: 1 });
    assert.equal(fetches.length, 2);
    assert.equal(tokenCalls.length, 1);
    assert.equal(authHeader(fetches[0].init), `Bearer ${KEY}`);
    assert.equal(authHeader(fetches[1].init), `Bearer ${KEY}`);
  });
}

test('redirect on a login path is HTTP_ERROR and is not followed', async () => {
  const { transport, fetches } = await setupAuth({ responses: [res(302, '', { Location: 'https://example.com/x' })] });
  await rejectsCode(transport.getJson(LOGIN_PATHS[0]), 'HTTP_ERROR');
  assert.equal(fetches.length, 1);
});

test('error text and details never contain the key (401, 403, 404, 500, 302, 429, bad JSON)', async () => {
  const cases = [
    [res(401, `unauthorized ${KEY}`)],
    [res(403, `forbidden ${KEY}`)],
    [res(403, `Доступ ограничен ${KEY}`)],
    [res(404, `missing ${KEY}`)],
    [res(500, `boom ${KEY}`)],
    [res(302, '', { Location: `https://example.com/?k=${KEY}` })],
    [res(429, `slow ${KEY}`)],
    [res(200, `not json ${KEY}`)],
  ];
  for (const responses of cases) {
    const { transport } = await setupAuth({ responses });
    let err;
    try { await transport.getJson(LOGIN_PATHS[1]); } catch (e) { err = e; }
    assert.ok(err, 'must throw');
    assert.equal(err.name, 'KufarError');
    assert.ok(!errText(err).includes(KEY), `${err.code} leaks the key`);
    assert.ok(!errText(err).includes('SECRET-KEY'), `${err.code} leaks part of the key`);
  }
});

test('fetch TypeError with the key in its text on a login path is NETWORK with a fixed message', async () => {
  const { transport } = await setupAuth({ responses: [new TypeError(`fetch failed, headers: Authorization: Bearer ${KEY}`)] });
  await assert.rejects(transport.getJson(LOGIN_PATHS[1]), (e) => {
    assert.equal(e.code, 'NETWORK');
    assert.equal(e.message, 'Сетевая ошибка');
    assert.ok(!errText(e).includes('SECRET-KEY'));
    return true;
  });
});

test('TimeoutError with the key in its text on a login path does not leak it', async () => {
  const e = new Error(`slow ${KEY}`);
  e.name = 'TimeoutError';
  const { transport } = await setupAuth({ responses: [e] });
  await assert.rejects(transport.getJson(LOGIN_PATHS[1]), (err) => {
    assert.equal(err.code, 'TIMEOUT');
    assert.ok(!errText(err).includes('SECRET-KEY'));
    return true;
  });
});

test('fetch TypeError on an open path is still NETWORK', async () => {
  const { transport } = await setupAuth({ responses: [new TypeError('fetch failed')] });
  await rejectsCode(transport.getJson(COUNT), 'NETWORK');
});

// ---- step 3e: the saved listing is read under login ----

test('the load path of a saved listing is under login: GET with the key', async () => {
  const { transport, fetches, tokenCalls } = await setupAuth();
  await transport.getJson('/insertion/v1/processing/load/123');
  assert.equal(new URL(fetches[0].url).origin, 'https://api.kufar.by');
  assert.equal(new URL(fetches[0].url).pathname, '/insertion/v1/processing/load/123');
  assert.equal(authHeader(fetches[0].init), `Bearer ${KEY}`);
  assert.equal(fetches[0].init.method, 'GET');
  assert.equal(tokenCalls.length, 1);
});

test('the load path without getToken is AUTH_REQUIRED and makes no network call', async () => {
  const { transport, fetches } = await setupAuth({ getToken: null });
  await rejectsCode(transport.getJson('/insertion/v1/processing/load/123'), 'AUTH_REQUIRED');
  assert.equal(fetches.length, 0);
});

test('a load path with non-digits is rejected before fetch and before getToken', async () => {
  for (const p of [
    '/insertion/v1/processing/load/12a',
    '/insertion/v1/processing/load/',
    '/insertion/v1/processing/load',
    '/insertion/v1/processing/load/123/x',
    '/insertion/v1/processing/load/../update/123',
    '/insertion/v1/processing/update/123',
  ]) {
    const { transport, fetches, tokenCalls } = await setupAuth();
    await rejectsCode(transport.getJson(p), 'PATH_NOT_ALLOWED');
    assert.equal(fetches.length, 0, p);
    assert.equal(tokenCalls.length, 0, p);
  }
});

// ---- step 3g: the paths of the first message ----

const AD_LOGIN_PATHS = ['/messaging-api/v1/conversations/check/1000000001', '/messaging-api/v3/conversations/info/1000000001'];

test('step 3g: the check and info paths with digits are allowed under login', async () => {
  for (const p of AD_LOGIN_PATHS) {
    const { transport, fetches } = await setupAuth();
    await transport.getJson(p);
    assert.equal(fetches.length, 1, p);
    assert.equal(new URL(fetches[0].url).origin, 'https://api.kufar.by');
    assert.equal(new URL(fetches[0].url).pathname, p);
    assert.equal(authHeader(fetches[0].init), `Bearer ${KEY}`, p);
  }
});

test('step 3g: the check and info paths with a bad tail are rejected before fetch and before getToken', async () => {
  const bad = [];
  for (const base of ['/messaging-api/v1/conversations/check', '/messaging-api/v3/conversations/info']) {
    bad.push(`${base}/`, `${base}/abc`, `${base}/100000000x`, `${base}/${UUID}`, `${base}/1000000001/extra`, `${base}/1000000001/`, `${base}/-1`);
  }
  bad.push('/messaging-api/v2/conversations/check/1000000001', '/messaging-api/v1/conversations/info/1000000001', '/messaging-api/v3/conversations/check/1000000001');
  for (const p of bad) {
    const { transport, fetches, tokenCalls } = await setupAuth();
    await rejectsCode(transport.getJson(p), 'PATH_NOT_ALLOWED');
    assert.equal(fetches.length, 0, p);
    assert.equal(tokenCalls.length, 0, p);
  }
});

test('step 3g: the check and info paths without getToken are AUTH_REQUIRED and make no network call', async () => {
  for (const p of AD_LOGIN_PATHS) {
    const { transport, fetches } = await setupAuth({ getToken: null });
    await rejectsCode(transport.getJson(p), 'AUTH_REQUIRED');
    assert.equal(fetches.length, 0, p);
  }
});
