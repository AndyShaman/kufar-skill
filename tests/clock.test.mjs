import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KufarError } from '../scripts/lib/errors.mjs';
import { loadClock, ageByClock, CLOCK_TTL_MS, AGE_CAP_DAYS } from '../scripts/lib/clock.mjs';
import { tmpDir, fakeTransport, pageOf, SEARCH_PATH, NOW, DAY, daysAgo } from './helpers.mjs';

const T = NOW;
const clock = { id: 1000000, ms: T, per_day: 1000 };
const now = T + 2 * DAY;

test('constants', () => {
  assert.equal(CLOCK_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(AGE_CAP_DAYS, 365);
});

test('ageByClock: the four contract examples', () => {
  assert.equal(ageByClock(clock, '990000', 1, now), 12);
  assert.equal(ageByClock(clock, '1000500', 0, now), 1);
  assert.equal(ageByClock(clock, '100', 3, now), 365);
  assert.equal(ageByClock(clock, '999000', 40, now), 40);
});

test('ageByClock: no clock or a bad id gives days', () => {
  assert.equal(ageByClock(null, '990000', 7, now), 7);
  assert.equal(ageByClock(null, '990000', null, now), null);
  assert.equal(ageByClock(clock, 'abc', 7, now), 7);
  assert.equal(ageByClock(clock, undefined, 7, now), 7);
  assert.equal(ageByClock(clock, 'abc', null, now), null);
});

test('ageByClock: days null with a clock is estimated by the clock', () => {
  assert.equal(ageByClock(clock, '990000', null, now), 12);
});

test('ageByClock: an ad newer than the clock is 0', () => {
  assert.equal(ageByClock(clock, '1005000', 0, T), 0);
  assert.equal(ageByClock(clock, '1005000', null, T), 0);
});

// top is the newest ad of the site, anchor the youngest-by-id among the longest unbumped
const top = { ad_id: 2000000, list_time: new Date(T).toISOString() };
const anchor = { ad_id: 1900000, list_time: daysAgo(100) };
const junk = { ad_id: 9999999, list_time: 'мусор' };
const answers = () => ({
  'lst.d': pageOf([{ ad_id: 1999000, list_time: daysAgo(0) }, junk, top, { ad_id: 1999500, list_time: daysAgo(0) }]),
  'lst.a': pageOf([{ ad_id: 1800000, list_time: daysAgo(101) }, anchor, { ad_id: 1850000, list_time: daysAgo(101) }]),
});

async function setup(handler) {
  const stateDir = await tmpDir();
  const transport = fakeTransport(handler);
  return { stateDir, transport };
}
const cacheFile = (stateDir) => path.join(stateDir, 'cache', 'id-clock.json');

test('loadClock: two requests with the contract query, result by the formula', async () => {
  const a = answers();
  const { stateDir, transport } = await setup((p, q) => a[q.sort]);
  const c = await loadClock({ transport, stateDir, now: () => T });
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.calls.every((x) => x.path === SEARCH_PATH));
  assert.deepEqual({ ...transport.calls[0].query }, { lang: 'ru', sort: 'lst.d', size: '30' });
  assert.deepEqual({ ...transport.calls[1].query }, { lang: 'ru', sort: 'lst.a', size: '200' });
  assert.deepEqual(c, { id: 2000000, ms: T, per_day: 1000 });
  await fs.access(cacheFile(stateDir));
});

test('loadClock: repeat within 24 hours is cached, after that it asks again', async () => {
  const a = answers();
  const { stateDir, transport } = await setup((p, q) => a[q.sort]);
  const first = await loadClock({ transport, stateDir, now: () => T });
  const again = await loadClock({ transport, stateDir, now: () => T + CLOCK_TTL_MS - 1000 });
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(again, first);
  await loadClock({ transport, stateDir, now: () => T + CLOCK_TTL_MS + 1000 });
  assert.equal(transport.calls.length, 4);
});

const bad = {
  'empty answer': () => pageOf([]),
  'no usable ads': () => pageOf([junk, { ad_id: 'x', list_time: daysAgo(1) }]),
};
for (const [name, h] of Object.entries(bad)) {
  test(`loadClock: ${name} gives null and no cache file`, async () => {
    const { stateDir, transport } = await setup(h);
    assert.equal(await loadClock({ transport, stateDir, now: () => T }), null);
    await assert.rejects(fs.access(cacheFile(stateDir)), { code: 'ENOENT' });
  });
}

test('loadClock: non-positive per_day gives null and no cache file', async () => {
  // anchor is newer by id than top
  const { stateDir, transport } = await setup((p, q) => (q.sort === 'lst.d'
    ? pageOf([top])
    : pageOf([{ ad_id: 2100000, list_time: daysAgo(100) }])));
  assert.equal(await loadClock({ transport, stateDir, now: () => T }), null);
  await assert.rejects(fs.access(cacheFile(stateDir)), { code: 'ENOENT' });
});

test('loadClock: KufarError from the transport gives null', async () => {
  const { stateDir, transport } = await setup(() => { throw new KufarError('RATE_LIMITED', 'x'); });
  assert.equal(await loadClock({ transport, stateDir, now: () => T }), null);
  await assert.rejects(fs.access(cacheFile(stateDir)), { code: 'ENOENT' });
});

test('loadClock: a plain Error is not swallowed', async () => {
  const { stateDir, transport } = await setup(() => { throw new Error('boom'); });
  await assert.rejects(loadClock({ transport, stateDir, now: () => T }), { message: 'boom' });
});
