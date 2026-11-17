import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchQuery, search, flagAds, ageDays, STALE_DAYS,
} from '../scripts/lib/search.mjs';
import {
  rejectsCode, throwsCode, plain, mkAd, rawAd, fakeTransport, SEARCH_PATH, NOW, DAY, daysAgo,
} from './helpers.mjs';

const base = { lang: 'ru', sort: 'lst.d', size: '30' };
const q = (opts) => plain(buildSearchQuery(opts));

test('defaults: cat only', () => {
  assert.deepStrictEqual(q({ cat: '17010' }), { cat: '17010', ...base });
});

test('query only', () => {
  assert.deepStrictEqual(q({ query: 'iphone' }), { query: 'iphone', ...base });
});

test('needs cat or query', () => {
  throwsCode(() => buildSearchQuery({}), 'BAD_ARGS');
});

test('sort values', () => {
  assert.equal(q({ cat: '1', sort: 'cheap' }).sort, 'prc.a');
  assert.equal(q({ cat: '1', sort: 'expensive' }).sort, 'prc.d');
  assert.equal(q({ cat: '1', sort: 'new' }).sort, 'lst.d');
  throwsCode(() => buildSearchQuery({ cat: '1', sort: 'random' }), 'BAD_ARGS');
});

test('limit becomes size', () => {
  assert.equal(q({ cat: '1', limit: 200 }).size, '200');
  assert.equal(q({ cat: '1', limit: 1 }).size, '1');
});

test('bad limit', () => {
  for (const limit of [0, 201, 1.5]) throwsCode(() => buildSearchQuery({ cat: '1', limit }), 'BAD_ARGS');
});

test('regions', () => {
  assert.equal(q({ cat: '1', regions: ['7'] }).rgn, '7');
  assert.equal(q({ cat: '1', regions: ['5', '7'] }).rgn, 'v.or:5,7');
});

test('price range in kopecks, open ends filled', () => {
  assert.equal(q({ cat: '1', priceMin: 100 }).prc, 'r:10000,2000000000');
  assert.equal(q({ cat: '1', priceMax: 50 }).prc, 'r:0,5000');
  assert.equal(q({ cat: '1', priceMin: 10.5, priceMax: 20 }).prc, 'r:1050,2000');
});

test('bad price', () => {
  throwsCode(() => buildSearchQuery({ cat: '1', priceMin: -1 }), 'BAD_ARGS');
  throwsCode(() => buildSearchQuery({ cat: '1', priceMax: -5 }), 'BAD_ARGS');
  throwsCode(() => buildSearchQuery({ cat: '1', priceMin: 10, priceMax: 5 }), 'BAD_ARGS');
});

test('condition, seller, delivery', () => {
  assert.equal(q({ cat: '1', condition: 'used' }).cnd, '1');
  assert.equal(q({ cat: '1', condition: 'new' }).cnd, '2');
  assert.equal(q({ cat: '1', seller: 'private' }).cmp, '0');
  assert.equal(q({ cat: '1', seller: 'company' }).cmp, '1');
  assert.equal(q({ cat: '1', delivery: true }).dle, '1');
  assert.equal('dle' in q({ cat: '1', delivery: false }), false);
});

test('params are passed as strings', () => {
  const r = q({ cat: '1', params: { phm: '5380', ppm: 20 } });
  assert.equal(r.phm, '5380');
  assert.equal(r.ppm, '20');
});

test('bad params keys', () => {
  for (const k of ['Phm', '1a', 'a-b', 'abcdefghijklmnopq', '']) {
    throwsCode(() => buildSearchQuery({ cat: '1', params: { [k]: '1' } }), 'BAD_ARGS');
  }
});

test('reserved params keys', () => {
  for (const k of ['cat', 'query', 'lang', 'sort', 'size', 'cursor', 'prc', 'rgn']) {
    throwsCode(() => buildSearchQuery({ cat: '1', params: { [k]: '1' } }), 'BAD_ARGS');
  }
});

test('params may carry cnd, cmp, dle codes on their own', () => {
  const r = q({ cat: '1', params: { cnd: '2', cmp: '1', dle: '1' } });
  assert.equal(r.cnd, '2');
  assert.equal(r.cmp, '1');
  assert.equal(r.dle, '1');
});

test('option and the same code in params conflict', () => {
  throwsCode(() => buildSearchQuery({ cat: '1', condition: 'used', params: { cnd: '1' } }), 'BAD_ARGS');
  throwsCode(() => buildSearchQuery({ cat: '1', seller: 'private', params: { cmp: '0' } }), 'BAD_ARGS');
  throwsCode(() => buildSearchQuery({ cat: '1', delivery: true, params: { dle: '1' } }), 'BAD_ARGS');
});

test('cursor', () => {
  assert.equal(q({ cat: '1', cursor: 'abc' }).cursor, 'abc');
});

const pages = [
  { label: 'prev', num: 1, token: 't1' },
  { label: 'self', num: 2, token: null },
  { label: 'next', num: 3, token: 't3' },
  { label: '', num: 4, token: 't4' },
];

test('search calls the endpoint once and maps the response', async () => {
  const tr = fakeTransport(() => ({ ads: [rawAd()], total: 1009, pagination: { pages } }));
  const opts = { cat: '17010', params: { phm: '5380' } };
  const r = await search(tr, opts, { now: () => NOW });
  assert.equal(tr.calls.length, 1);
  assert.equal(tr.calls[0].path, SEARCH_PATH);
  assert.deepEqual(plain(tr.calls[0].query), q(opts));
  assert.equal(r.total, 1009);
  assert.equal(r.next_cursor, 't3');
  assert.deepEqual(r.pages, [{ num: 1, cursor: 't1' }, { num: 3, cursor: 't3' }, { num: 4, cursor: 't4' }]);
  assert.equal(r.ads[0].id, '1000000001');
  assert.equal(r.ads[0].price_byn, 620);
  assert.deepEqual(r.ads[0].flags, []);
});

test('search tolerates missing pagination and total', async () => {
  const tr = fakeTransport(() => ({ ads: [] }));
  const r = await search(tr, { cat: '1' }, { now: () => NOW });
  assert.equal(r.total, 0);
  assert.equal(r.next_cursor, null);
  assert.deepEqual(r.pages, []);
  assert.deepEqual(r.ads, []);
});

test('search validates before calling transport', async () => {
  const tr = fakeTransport(() => ({ ads: [] }));
  await rejectsCode(search(tr, {}, { now: () => NOW }), 'BAD_ARGS');
  assert.equal(tr.calls.length, 0);
});

test('flagAds: clean ad has empty flags', () => {
  assert.deepEqual(flagAds([mkAd(1, 100)], NOW).map((a) => a.flags), [[]]);
});

test('flagAds: no_price and not_sell', () => {
  assert.deepEqual(flagAds([mkAd(1, null)], NOW)[0].flags, ['no_price']);
  assert.deepEqual(flagAds([mkAd(1, 100, { type: 'buy' })], NOW)[0].flags, ['not_sell']);
});

test('flagAds: each suspect title word', () => {
  for (const w of ['запчаст', 'на разбор', 'на детали', 'куплю', 'заблокирован', 'iCloud', 'не включается', 'под восстановление']) {
    assert.deepEqual(flagAds([mkAd(1, 100, { title: `Телефон ${w.toUpperCase()} срочно` })], NOW)[0].flags, ['suspect_title'], w);
  }
});

test('flagAds: flag order', () => {
  const [a] = flagAds([mkAd(1, null, { type: 'buy', title: 'Куплю запчасти' })], NOW);
  assert.deepEqual(a.flags, ['no_price', 'not_sell', 'suspect_title']);
});

test('flagAds: duplicate only for second and later', () => {
  const r = flagAds([
    mkAd(1, 100, { seller_key: 's', title: 'Телефон' }),
    mkAd(2, 100, { seller_key: 's', title: '  телефон ' }),
    mkAd(3, 100, { seller_key: 's', title: 'ТЕЛЕФОН' }),
  ], NOW);
  assert.deepEqual(r.map((a) => a.flags), [[], ['duplicate'], ['duplicate']]);
});

test('flagAds: not duplicate with different price, seller or empty key', () => {
  const r = flagAds([
    mkAd(1, 100, { seller_key: 's', title: 'T' }),
    mkAd(2, 101, { seller_key: 's', title: 'T' }),
    mkAd(3, 100, { seller_key: 'other', title: 'T' }),
    mkAd(4, 100, { seller_key: '', title: 'T' }),
    mkAd(5, 100, { seller_key: '', title: 'T' }),
  ], NOW);
  assert.deepEqual(r.map((a) => a.flags), [[], [], [], [], []]);
});

test('STALE_DAYS is 30', () => {
  assert.equal(STALE_DAYS, 30);
});

test('ageDays: whole days, floor', () => {
  assert.equal(ageDays(daysAgo(30), NOW), 30);
  assert.equal(ageDays(new Date(NOW - 30 * DAY + 3_600_000).toISOString(), NOW), 29);
  assert.equal(ageDays(daysAgo(0), NOW), 0);
});

test('ageDays: future date is 0', () => {
  assert.equal(ageDays(new Date(NOW + 5 * DAY).toISOString(), NOW), 0);
});

test('ageDays: missing or not a date is null', () => {
  for (const v of [null, undefined, 'мусор', '']) assert.equal(ageDays(v, NOW), null, String(v));
});

test('flagAds: every ad gets days; stale from 30 days, not at 29', () => {
  const r = flagAds([
    mkAd(1, 100, { listed_at: daysAgo(29) }),
    mkAd(2, 100, { listed_at: daysAgo(30) }),
    mkAd(3, 100, { listed_at: daysAgo(40) }),
    mkAd(4, 100),
  ], NOW);
  assert.deepEqual(r.map((a) => a.days), [29, 30, 40, 0]);
  assert.deepEqual(r.map((a) => a.flags), [[], ['stale'], ['stale'], []]);
});

test('flagAds: no listed_at gives days null and no stale flag', () => {
  const [a] = flagAds([mkAd(1, 100, { listed_at: null })], NOW);
  assert.equal(a.days, null);
  assert.deepEqual(a.flags, []);
});

test('flagAds: stale goes last after the other flags', () => {
  const [a] = flagAds([mkAd(1, null, { type: 'buy', title: 'Куплю запчасти', listed_at: daysAgo(40) })], NOW);
  assert.deepEqual(a.flags, ['no_price', 'not_sell', 'suspect_title', 'stale']);
  const r = flagAds([
    mkAd(1, 100, { seller_key: 's', title: 'T', listed_at: daysAgo(40) }),
    mkAd(2, 100, { seller_key: 's', title: 'T', listed_at: daysAgo(40) }),
  ], NOW);
  assert.deepEqual(r[1].flags, ['duplicate', 'stale']);
});

test('search passes now to the flags', async () => {
  const tr = fakeTransport(() => ({ ads: [rawAd({ list_time: daysAgo(40) })] }));
  const a = (await search(tr, { cat: '1' }, { now: () => NOW })).ads[0];
  assert.equal(a.days, 40);
  assert.deepEqual(a.flags, ['stale']);
  const b = (await search(tr, { cat: '1' }, { now: () => NOW - 35 * DAY })).ads[0];
  assert.equal(b.days, 5);
  assert.deepEqual(b.flags, []);
});
