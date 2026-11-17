import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTransport } from '../scripts/lib/transport.mjs';
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
