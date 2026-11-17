import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePrice as estimate } from '../scripts/lib/price.mjs';
import {
  rejectsCode, rawAd, rawAdOf, series, fakeTransport, itemIdOf, pageOf, SEARCH_PATH, NOW, daysAgo, CLOCK,
} from './helpers.mjs';

const estimatePrice = (tr, o) => estimate(tr, { now: () => NOW, ...o });

// search(q) answers every search request; the card request returns `card`
const mk = (search, card = rawAd()) =>
  fakeTransport((p, q) => (itemIdOf(p) ? { result: card } : search(q)));
const searches = (tr) => tr.calls.filter((c) => c.path === SEARCH_PATH);
const P5 = { phm: '5380' };
const SIX = [500, 520, 540, 560, 580, 600];

test('no cat and no like is BAD_ARGS', async () => {
  await rejectsCode(estimatePrice(mk(() => pageOf([])), {}), 'BAD_ARGS');
});

test('cat without params and query is BAD_ARGS', async () => {
  const tr = mk(() => pageOf([]));
  await rejectsCode(estimatePrice(tr, { cat: '17010' }), 'BAD_ARGS');
  await rejectsCode(estimatePrice(tr, { cat: '17010', params: {} }), 'BAD_ARGS');
  assert.equal(tr.calls.length, 0);
});

test('like without by is NEEDS_BY with available', async () => {
  const tr = mk(() => pageOf([]));
  for (const by of [undefined, []]) {
    await assert.rejects(estimatePrice(tr, { like: '1000000001', by }), (e) => {
      assert.equal(e.code, 'NEEDS_BY');
      assert.ok(e.details.available.some((a) => a.filter === 'phm' && a.label === 'Модель' && a.text === 'iPhone 13'));
      return true;
    });
  }
});

test('by code missing on the ad is BAD_ARGS with available', async () => {
  await assert.rejects(estimatePrice(mk(() => pageOf([])), { like: '1000000001', by: ['zzz'] }), (e) => {
    assert.equal(e.code, 'BAD_ARGS');
    assert.ok(Array.isArray(e.details.available));
    return true;
  });
});

test('like takes cat and values from the card and excludes the ad itself', async () => {
  const tr = mk(() => pageOf(series(1000000001, [620, ...SIX])));
  const r = await estimatePrice(tr, { like: 'https://www.kufar.by/item/1000000001', by: ['phm'] });
  const s = searches(tr);
  assert.equal(s.length, 1);
  assert.equal(s[0].query.cat, '17010');
  assert.equal(s[0].query.phm, '5380');
  assert.equal(s[0].query.sort, 'lst.d');
  assert.equal(s[0].query.size, '200');
  assert.equal('query' in s[0].query, false);
  assert.deepEqual(r.group.params, { phm: '5380' });
  assert.equal(r.group.cat, '17010');
  assert.ok(!r.comparables.some((c) => c.id === '1000000001'));
  assert.equal(r.sample.used, 6);
  assert.equal(r.sample.fresh, 6);
  assert.deepEqual(r.subject.position, { vs_median_pct: 13, band: 'above_q3', suspicious_low: false });
  assert.equal(r.subject.id, '1000000001');
  assert.equal(r.subject.price_byn, 620);
  assert.equal(r.subject.title, 'iPhone 13 128 ГБ');
  assert.equal(r.subject.url, 'https://www.kufar.by/item/1000000001');
  assert.equal(r.subject.days, 0);
  assert.equal(r.subject.age_days, 0);
  assert.equal(r.subject.stale, false);
  assert.equal(r.subject.bumped, false);
});

test('subject is null without like; group has null query and regions', async () => {
  const r = await estimatePrice(mk(() => pageOf(series(1000000001, SIX))), { cat: '17010', params: P5 });
  assert.equal(r.subject, null);
  assert.deepEqual(r.group, { cat: '17010', params: P5, query: null, regions: null });
  assert.equal(typeof r.note, 'string');
  assert.ok(r.note.length > 0);
});

const PAGES = [
  { label: 'self', num: 1, token: null },
  { label: 'next', num: 2, token: 'c2' },
];

test('old slice: sort lst.a without cursor when total exceeds the fresh slice', async () => {
  const tr = mk((q) => (q.sort === 'lst.a'
    ? pageOf(series(1000000201, [700, 720, 740, 760, 780], { listTime: daysAgo(40) }), 1009, PAGES)
    : pageOf(series(1000000001, SIX), 1009, PAGES)));
  const r = await estimatePrice(tr, { cat: '17010', params: P5 });
  const s = searches(tr);
  assert.equal(s.length, 2);
  assert.equal(s[0].query.sort, 'lst.d');
  assert.equal(s[1].query.sort, 'lst.a');
  assert.equal('cursor' in s[1].query, false);
  assert.equal(s[1].query.phm, '5380');
  assert.equal(s[1].query.size, '200');
  assert.equal(r.total_on_site, 1009);
  assert.equal(r.sample.fresh, 6);
  assert.equal(r.sample.old, 5);
  assert.equal(r.sample.used, 11);
  assert.equal(r.sample.live, 6);
  assert.equal(r.stats.all.median, 550);
  assert.equal(r.stale.n, 5);
  assert.equal(r.stale.median, 740);
  assert.equal(r.stale.vs_live_pct, 35);
});

test('old slice is not requested when total equals the number of fresh ads', async () => {
  const a = mk(() => pageOf(series(1000000001, SIX), 6, PAGES));
  const r = await estimatePrice(a, { cat: '17010', params: P5 });
  assert.equal(searches(a).length, 1);
  assert.equal(r.sample.old, 0);
  assert.equal(r.stale.n, 0);
});

test('slices are merged without repeated ids', async () => {
  const tr = mk((q) => (q.sort === 'lst.a'
    ? pageOf(series(1000000006, [600, 700, 720, 740, 760]), 1009, PAGES)
    : pageOf(series(1000000001, SIX), 1009, PAGES)));
  const r = await estimatePrice(tr, { cat: '17010', params: P5 });
  const ids = r.comparables.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 10);
  assert.equal(r.sample.fresh, 6);
  assert.equal(r.sample.old, 4);
  assert.equal(r.sample.used, 10);
});

test('sample.old is 0 without an old slice', async () => {
  const r = await estimatePrice(mk(() => pageOf(series(1000000001, SIX), 100)), { cat: '17010', params: P5 });
  assert.equal(r.sample.old, 0);
});

test('sample.fresh counts ads before cleaning', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...series(1000000001, SIX), rawAdOf({ id: 1000000050, price: null })])),
    { cat: '17010', params: P5 },
  );
  assert.equal(r.sample.fresh, 7);
  assert.equal(r.sample.used, 6);
});

test('words mode: query without params, single slice with query', async () => {
  const tr = mk(() => pageOf(series(1000000001, SIX), 6));
  const r = await estimatePrice(tr, { cat: '17010', query: 'iphone 13' });
  const s = searches(tr);
  assert.equal(s.length, 1);
  assert.equal(s[0].query.query, 'iphone 13');
  assert.equal(s[0].query.cat, '17010');
  assert.equal(s[0].query.sort, 'lst.d');
  assert.equal(s[0].query.size, '200');
  assert.equal('phm' in s[0].query, false);
  assert.deepEqual(r.unclassified, []);
  assert.deepEqual(r.group.params, {});
  assert.equal(r.group.query, 'iphone 13');
  assert.equal(r.sample.used, 6);
});

test('words mode: old slice also carries query', async () => {
  const tr = mk((q) => (q.sort === 'lst.a'
    ? pageOf(series(1000000201, [700, 720, 740, 760, 780]), 1009, PAGES)
    : pageOf(series(1000000001, SIX), 1009, PAGES)));
  const r = await estimatePrice(tr, { cat: '17010', query: 'iphone' });
  const s = searches(tr);
  assert.equal(s.length, 2);
  assert.ok(s.every((c) => c.query.query === 'iphone'));
  assert.equal(s[1].query.sort, 'lst.a');
  assert.equal('cursor' in s[1].query, false);
  assert.deepEqual(r.unclassified, []);
});

test('like without by but with query is words mode on the card category', async () => {
  const tr = mk(() => pageOf(series(1000000001, [620, ...SIX])));
  const r = await estimatePrice(tr, { like: '1000000001', query: 'iphone 13' });
  const s = searches(tr);
  assert.equal(s.length, 1);
  assert.equal(s[0].query.cat, '17010');
  assert.equal(s[0].query.query, 'iphone 13');
  assert.equal('phm' in s[0].query, false);
  assert.deepEqual(r.group.params, {});
  assert.ok(!r.comparables.some((c) => c.id === '1000000001'));
  assert.equal(r.subject.id, '1000000001');
});

test('words slice runs only with query and without params', async () => {
  const none = mk(() => pageOf(series(1000000001, SIX)));
  await estimatePrice(none, { cat: '17010', params: P5 });
  assert.equal(searches(none).length, 1);

  const tr = mk((q) => (q.query ? pageOf([]) : pageOf(series(1000000001, SIX))));
  const r = await estimatePrice(tr, { cat: '17010', params: P5, query: 'iphone 13' });
  const w = searches(tr).find((c) => c.query.query);
  assert.equal(w.query.query, 'iphone 13');
  assert.equal(w.query.cat, '17010');
  assert.equal(w.query.size, '200');
  assert.equal(w.query.sort, 'lst.d');
  assert.equal('phm' in w.query, false);
  assert.equal(r.group.query, 'iphone 13');
});

test('unclassified rule and include', async () => {
  const words = [
    rawAdOf({ id: 1000000101, price: 500, phm: null }),
    rawAdOf({ id: 1000000102, price: 500, phm: 9999 }),
    rawAdOf({ id: 1000000103, price: 520, phm: null }),
    rawAdOf({ id: 1000000001, price: 500, phm: null }),
    rawAdOf({ id: 1000000104, price: 500, phm: 5380 }),
  ];
  const tr = mk((q) => (q.query ? pageOf(words) : pageOf(series(1000000001, SIX))));
  const r = await estimatePrice(tr, { cat: '17010', params: P5, query: 'iphone', include: ['1000000103'] });
  assert.deepEqual(r.unclassified.map((u) => u.id), ['1000000101']);
  assert.deepEqual(Object.keys(r.unclassified[0]).sort(), ['id', 'price_byn', 'title', 'url']);
  const ids = r.comparables.map((c) => c.id);
  assert.ok(ids.includes('1000000103'));
  assert.ok(!ids.includes('1000000102'));
  assert.ok(!ids.includes('1000000104'));
  assert.equal(r.sample.used, 7);
});

test('unclassified: list value v.or accepts listed values, drops others', async () => {
  const words = [
    rawAdOf({ id: 1000000201, price: 500, phm: 5381 }),
    rawAdOf({ id: 1000000202, price: 500, phm: 9999 }),
    rawAdOf({ id: 1000000203, price: 500, phm: null }),
  ];
  const tr = mk((q) => (q.query ? pageOf(words) : pageOf(series(1000000001, SIX))));
  const r = await estimatePrice(tr, { cat: '17010', params: { phm: 'v.or:5380,5381' }, query: 'iphone' });
  assert.deepEqual(r.unclassified.map((u) => u.id), ['1000000203']);
  const ids = r.comparables.map((c) => c.id);
  assert.ok(!ids.includes('1000000201'));
  assert.ok(!ids.includes('1000000202'));
  assert.ok(!ids.includes('1000000203'));
});

test('unclassified: range value never contradicts, missing code is unclassified', async () => {
  const noPpm = rawAdOf({ id: 1000000301, price: 500 });
  noPpm.ad_parameters = noPpm.ad_parameters.filter((p) => p.pu !== 'ppm');
  const words = [
    noPpm, // phm 5380 matches, ppm missing
    rawAdOf({ id: 1000000302, price: 500, phm: null }), // ppm=20 is outside r:1,5 but not a contradiction; phm missing
    rawAdOf({ id: 1000000303, price: 500 }), // both present: not selected
  ];
  const tr = mk((q) => (q.query ? pageOf(words) : pageOf(series(1000000001, SIX))));
  const r = await estimatePrice(tr, { cat: '17010', params: { phm: '5380', ppm: 'r:1,5' }, query: 'iphone' });
  assert.deepEqual(r.unclassified.map((u) => u.id).sort(), ['1000000301', '1000000302']);
  assert.ok(!r.comparables.some((c) => c.id === '1000000303'));
});

test('basis is private with 5+ private ads', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...series(1000000001, SIX), ...series(1000000101, [540, 560], { company: true })])),
    { cat: '17010', params: P5 },
  );
  assert.equal(r.suggest.basis, 'private');
  assert.equal(r.stats.private.n, 6);
  assert.equal(r.stats.company.n, 2);
  assert.equal(r.stats.all.n, 8);
  assert.deepEqual(r.reliability, { level: 'low', reasons: ['few'] });
  assert.deepEqual(r.suggest, { fast: 525, market: 550, high: 575, basis: 'private' });
});

test('basis is all with fewer than 5 private ads', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...series(1000000001, [500, 520, 540]), ...series(1000000101, [560, 580, 600], { company: true })])),
    { cat: '17010', params: P5 },
  );
  assert.equal(r.suggest.basis, 'all');
  assert.equal(r.stats.all.n, 6);
});

test('suggest is null when insufficient', async () => {
  const r = await estimatePrice(mk(() => pageOf(series(1000000001, [500, 520, 540]))), { cat: '17010', params: P5 });
  assert.equal(r.reliability.level, 'insufficient');
  assert.equal(r.suggest, null);
});

test('suggest rounds to integers for median >= 20', async () => {
  const r = await estimatePrice(
    mk(() => pageOf(series(1000000001, [499.4, 500.4, 501.4, 502.6, 503.6]))),
    { cat: '17010', params: P5 },
  );
  assert.deepEqual(r.suggest, { fast: 500, market: 501, high: 503, basis: 'private' });
});

test('suggest keeps 2 decimals for median < 20', async () => {
  const r = await estimatePrice(
    mk(() => pageOf(series(1000000001, [1.0, 1.0, 1.03, 1.07, 1.1, 1.2]))),
    { cat: '17010', params: P5 },
  );
  assert.deepEqual(r.suggest, { fast: 1.01, market: 1.05, high: 1.09, basis: 'private' });
});

test('comparables ascending by price with the contract keys', async () => {
  const r = await estimatePrice(mk(() => pageOf(series(1000000001, [580, 500, 560, 520, 600, 540]))), { cat: '17010', params: P5 });
  assert.deepEqual(r.comparables.map((c) => c.price_byn), [500, 520, 540, 560, 580, 600]);
  assert.deepEqual(Object.keys(r.comparables[0]).sort(), ['age_days', 'bumped', 'company', 'days', 'id', 'listed_at', 'price_byn', 'stale', 'title', 'url']);
});

test('dropped ads are reported with a reason', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...series(1000000001, SIX), rawAdOf({ id: 1000000050, price: null })])),
    { cat: '17010', params: P5 },
  );
  assert.deepEqual(r.dropped, [{ id: '1000000050', title: 'Телефон 1000000050', price_byn: null, reason: 'no_price' }]);
});

test('exclude removes an ad from the sample', async () => {
  const r = await estimatePrice(mk(() => pageOf(series(1000000001, SIX))), { cat: '17010', params: P5, exclude: ['1000000001'] });
  assert.equal(r.sample.used, 5);
  assert.equal(r.dropped[0].reason, 'excluded');
});

const LIVE = () => series(1000000001, SIX);
const OLD = (prices, start = 1000000101) => series(start, prices, { listTime: daysAgo(40) });

test('live ads form the basis; stale ads are reported separately', async () => {
  const r = await estimatePrice(mk(() => pageOf([...LIVE(), ...OLD([700, 720, 740])])), { cat: '17010', params: P5 });
  assert.equal(r.stats.all.n, 6);
  assert.equal(r.stats.all.median, 550);
  assert.deepEqual(r.suggest, { fast: 525, market: 550, high: 575, basis: 'private' });
  assert.deepEqual(r.reliability, { level: 'low', reasons: ['few'] });
  assert.equal(r.sample.used, 9);
  assert.equal(r.sample.live, 6);
  assert.equal(r.stale.days, 30);
  assert.equal(r.stale.n, 3);
  assert.equal(r.stale.median, 720);
  assert.equal(r.stale.vs_live_pct, 31);
});

test('fewer than 5 live: basis is all kept, stale_sample, level low', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...series(1000000001, [500, 505, 510]), ...OLD([700, 720, 740])])),
    { cat: '17010', params: P5 },
  );
  assert.equal(r.stats.all.n, 6);
  assert.equal(r.sample.live, 3);
  assert.equal(r.reliability.level, 'low');
  assert.ok(r.reliability.reasons.includes('stale_sample'));
  assert.notEqual(r.suggest, null);
});

test('stale_sample caps a narrow 10+ sample at low', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([
      ...series(1000000001, [500, 505, 510, 515]),
      ...OLD([520, 525, 530, 535, 540, 545, 550]),
    ])),
    { cat: '17010', params: P5 },
  );
  assert.equal(r.sample.used, 11);
  assert.equal(r.sample.live, 4);
  assert.deepEqual(r.reliability, { level: 'low', reasons: ['stale_sample'] });
  assert.equal(r.suggest.market, 525);
});

test('fewer than 5 kept is insufficient even with stale ads', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...series(1000000001, [500, 520]), ...OLD([700, 720])])),
    { cat: '17010', params: P5 },
  );
  assert.equal(r.sample.used, 4);
  assert.equal(r.reliability.level, 'insufficient');
  assert.ok(r.reliability.reasons.includes('too_few'));
  assert.equal(r.suggest, null);
});

test('stale.cheap: stale ads at or below the live median, ascending, at most 10', async () => {
  const cheap = Array.from({ length: 12 }, (_, i) => 430 + 10 * ((i * 5) % 12)); // 430..540, shuffled
  const r = await estimatePrice(
    mk(() => pageOf([...LIVE(), ...OLD(cheap), ...OLD([560, 700], 1000000201)])),
    { cat: '17010', params: P5 },
  );
  assert.equal(r.stale.n, 14);
  assert.deepEqual(r.stale.cheap.map((c) => c.price_byn), [430, 440, 450, 460, 470, 480, 490, 500, 510, 520]);
  for (const c of r.stale.cheap) {
    assert.deepEqual(Object.keys(c).sort(), ['age_days', 'bumped', 'days', 'id', 'price_byn', 'title', 'url']);
    assert.equal(c.days, 40);
    assert.equal(c.age_days, 40);
    assert.equal(c.bumped, false);
    assert.equal(c.url, `https://www.kufar.by/item/${c.id}`);
  }
});

test('stale.cheap includes a price equal to the live median, not above it', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...LIVE(), ...OLD([550, 551])])),
    { cat: '17010', params: P5 },
  );
  assert.deepEqual(r.stale.cheap.map((c) => c.price_byn), [550]);
});

test('no stale ads: empty stale block', async () => {
  const r = await estimatePrice(mk(() => pageOf(LIVE())), { cat: '17010', params: P5 });
  assert.deepEqual(r.stale, { days: 30, n: 0, median: null, vs_live_pct: null, bumped: { n: 0, median: null }, cheap: [] });
  assert.equal(r.sample.live, 6);
});

test('no live ads at all: no comparison with live, basis is stale ads', async () => {
  const r = await estimatePrice(mk(() => pageOf(OLD(SIX))), { cat: '17010', params: P5 });
  assert.equal(r.sample.live, 0);
  assert.equal(r.sample.used, 6);
  assert.equal(r.stale.n, 6);
  assert.equal(r.stale.vs_live_pct, null);
  assert.deepEqual(r.stale.cheap, []);
  assert.equal(r.reliability.level, 'low');
  assert.ok(r.reliability.reasons.includes('stale_sample'));
});

test('comparables hold live and stale ads with days and stale', async () => {
  const r = await estimatePrice(mk(() => pageOf([...LIVE(), ...OLD([700, 720])])), { cat: '17010', params: P5 });
  assert.equal(r.comparables.length, 8);
  assert.deepEqual(r.comparables.map((c) => c.price_byn), [500, 520, 540, 560, 580, 600, 700, 720]);
  for (const c of r.comparables) {
    assert.deepEqual(Object.keys(c).sort(), ['age_days', 'bumped', 'company', 'days', 'id', 'listed_at', 'price_byn', 'stale', 'title', 'url']);
    assert.equal(typeof c.days, 'number');
    assert.equal(typeof c.stale, 'boolean');
    assert.equal(typeof c.age_days, 'number');
    assert.equal(typeof c.bumped, 'boolean');
  }
  assert.deepEqual(r.comparables.map((c) => c.stale), [false, false, false, false, false, false, true, true]);
  assert.equal(r.comparables[6].days, 40);
});

test('subject: days and stale from the card, position from the live basis', async () => {
  const card = rawAd({ list_time: daysAgo(45) });
  const tr = mk(() => pageOf([...series(1000000002, SIX), ...OLD([900, 920, 940])]), card);
  const r = await estimatePrice(tr, { like: '1000000001', by: ['phm'] });
  assert.deepEqual(Object.keys(r.subject).sort(), ['age_days', 'bumped', 'days', 'id', 'position', 'price_byn', 'stale', 'title', 'url']);
  assert.equal(r.subject.days, 45);
  assert.equal(r.subject.age_days, 45);
  assert.equal(r.subject.stale, true);
  assert.equal(r.subject.bumped, false);
  assert.deepEqual(r.subject.position, { vs_median_pct: 13, band: 'above_q3', suspicious_low: false });
});

test('result has no slices field', async () => {
  const r = await estimatePrice(mk(() => pageOf(LIVE())), { cat: '17010', params: P5 });
  assert.equal('slices' in r, false);
});

// ads numbered 1959900.. are 40 days old by CLOCK; listTime today means they were bumped
const BUMPED = (prices, start = 1959900) => series(start, prices, { listTime: daysAgo(0) });

test('clock reaches every search: an ad bumped today with an old id is stale, not in the basis', async () => {
  const tr = mk((q) => (q.sort === 'lst.a'
    ? pageOf(BUMPED([700, 720, 740], 1959800), 100, PAGES)
    : pageOf([...LIVE(), ...BUMPED([700, 720, 740])], 100, PAGES)));
  const r = await estimatePrice(tr, { cat: '17010', params: P5, clock: CLOCK });
  assert.equal(r.stats.all.n, 6);
  assert.equal(r.stats.all.median, 550);
  assert.equal(r.sample.live, 6);
  assert.equal(r.stale.n, 6);
  const c = r.comparables.find((x) => x.id === '1959900');
  assert.equal(c.days, 0);
  assert.equal(c.age_days, 40);
  assert.equal(c.stale, true);
  assert.equal(c.bumped, true);
});

test('clock reaches the words slice and the old slice', async () => {
  const seen = [];
  const tr = mk((q) => {
    seen.push(q.sort + (q.query ? '+query' : ''));
    if (q.query) return pageOf(series(1959700, [700], { listTime: daysAgo(0), phm: null }));
    if (q.sort === 'lst.a') return pageOf(BUMPED([720], 1959800), 1009, PAGES);
    return pageOf([...LIVE(), ...BUMPED([700])], 1009, PAGES);
  });
  const r = await estimatePrice(tr, { cat: '17010', params: P5, query: 'iphone', include: ['1959700'], clock: CLOCK });
  assert.deepEqual(seen.sort(), ['lst.a', 'lst.d', 'lst.d+query']);
  const byId = Object.fromEntries(r.comparables.map((c) => [c.id, c]));
  assert.equal(byId['1959800'].age_days, 40);
  assert.equal(byId['1959700'].age_days, 40);
  assert.equal(byId['1959700'].stale, true);
});

test('company ads with old ids stay live and enter stats.company and stats.all', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...LIVE(), ...series(1959900, [540, 560], { company: true, listTime: daysAgo(0) })])),
    { cat: '17010', params: P5, clock: CLOCK },
  );
  assert.equal(r.stats.company.n, 2);
  assert.equal(r.stats.all.n, 8);
  assert.equal(r.sample.live, 8);
  assert.equal(r.stale.n, 0);
  const c = r.comparables.find((x) => x.id === '1959900');
  assert.equal(c.age_days, 40);
  assert.equal(c.stale, false);
  assert.equal(c.bumped, false);
});

test('stale.bumped counts stale ads with the bumped flag', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...LIVE(), ...BUMPED([700, 740]), ...OLD([900, 920, 940])])),
    { cat: '17010', params: P5, clock: CLOCK },
  );
  assert.equal(r.stale.n, 5);
  assert.deepEqual(r.stale.bumped, { n: 2, median: 720 });
});

test('stale.bumped is {n: 0, median: null} when no stale ad is bumped', async () => {
  const r = await estimatePrice(mk(() => pageOf([...LIVE(), ...OLD([700, 720])])), { cat: '17010', params: P5 });
  assert.equal(r.stale.n, 2);
  assert.deepEqual(r.stale.bumped, { n: 0, median: null });
});

test('stale.cheap marks bumped ads', async () => {
  const r = await estimatePrice(
    mk(() => pageOf([...LIVE(), ...BUMPED([500]), ...OLD([510], 1000000101)])),
    { cat: '17010', params: P5, clock: CLOCK },
  );
  assert.deepEqual(r.stale.cheap.map((c) => [c.id, c.bumped, c.age_days]), [['1959900', true, 40], ['1000000101', false, 40]]);
});

test('subject with a clock: age_days, stale and bumped by the clock', async () => {
  const card = rawAd({ ad_id: 1959900, list_time: daysAgo(0) });
  const tr = mk(() => pageOf(series(1000000002, SIX)), card);
  const r = await estimatePrice(tr, { like: '1959900', by: ['phm'], clock: CLOCK });
  assert.equal(r.subject.days, 0);
  assert.equal(r.subject.age_days, 40);
  assert.equal(r.subject.stale, true);
  assert.equal(r.subject.bumped, true);
});

test('like with user params: the search carries the by characteristic and the user params', async () => {
  const tr = mk(() => pageOf(series(1000000001, [620, ...SIX])));
  await estimatePrice(tr, { like: '1000000001', by: ['phm'], params: { cnd: '1' } });
  const q = searches(tr)[0].query;
  assert.equal(q.phm, '5380');
  assert.equal(q.cnd, '1');
});

test('like with user params: the user value wins over a by characteristic with the same code', async () => {
  const tr = mk(() => pageOf(series(1000000001, [620, ...SIX])));
  await estimatePrice(tr, { like: '1000000001', by: ['phm'], params: { phm: '9999' } });
  assert.equal(searches(tr)[0].query.phm, '9999');
});
