import test from 'node:test';
import assert from 'node:assert/strict';
import { quantile, priceStats, cleanForPricing, reliability, position } from '../skills/kufar/scripts/lib/stats.mjs';
import { mkAd } from './helpers.mjs';

test('quantile interpolates linearly', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.75), 4);
});

test('quantile of one element and of empty', () => {
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([], 0.5), null);
});

test('priceStats even n', () => {
  assert.deepEqual(priceStats([3, 1, 2, 4]), { n: 4, min: 1, q1: 1.75, median: 2.5, q3: 3.25, max: 4 });
});

test('priceStats odd n', () => {
  assert.deepEqual(priceStats([5, 1, 3]), { n: 3, min: 1, q1: 2, median: 3, q3: 4, max: 5 });
});

test('priceStats empty', () => {
  assert.deepEqual(priceStats([]), { n: 0, min: null, q1: null, median: null, q3: null, max: null });
});

const reasons = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.reason]));
const f = (id, price, flags, over = {}) => mkAd(id, price, { flags, ...over });
const ok = (n, price = 100) => Array.from({ length: n }, (_, i) => f(`ok${i}`, price, []));

test('cleanForPricing: each reason', () => {
  const r = cleanForPricing([
    ...ok(5),
    f('a', null, ['no_price']),
    f('b', 100, ['not_sell']),
    f('c', 100, ['suspect_title']),
    f('d', 100, ['duplicate']),
    f('e', 100, []),
  ], { exclude: ['e'] });
  assert.deepEqual(reasons(r), { a: 'no_price', b: 'not_sell', c: 'suspect_title', d: 'duplicate', e: 'excluded' });
  assert.equal(r.kept.length, 5);
  assert.deepEqual(r.dropped.find((d) => d.id === 'a'), { id: 'a', title: 'Товар a', price_byn: null, reason: 'no_price' });
});

test('cleanForPricing: reason order picks the first flag', () => {
  const r = cleanForPricing([...ok(5), f('x', null, ['duplicate', 'suspect_title', 'not_sell', 'no_price'])]);
  assert.equal(reasons(r).x, 'no_price');
  const r2 = cleanForPricing([...ok(5), f('y', 100, ['duplicate', 'suspect_title'])]);
  assert.equal(reasons(r2).y, 'suspect_title');
});

test('cleanForPricing: include keeps suspect_title only', () => {
  const r = cleanForPricing([
    ...ok(5),
    f('s', 100, ['suspect_title']),
    f('n', null, ['no_price']),
    f('t', 100, ['not_sell']),
    f('d', 100, ['duplicate']),
  ], { include: ['s', 'n', 't', 'd'] });
  assert.deepEqual(reasons(r), { n: 'no_price', t: 'not_sell', d: 'duplicate' });
  assert.ok(r.kept.some((a) => a.id === 's'));
});

test('cleanForPricing: include removes only suspect_title, duplicate still applies', () => {
  const r = cleanForPricing([
    ...ok(5),
    f('sd', 100, ['suspect_title', 'duplicate']),
    f('so', 100, ['suspect_title']),
  ], { include: ['sd', 'so'] });
  assert.deepEqual(reasons(r), { sd: 'duplicate' });
  assert.ok(r.kept.some((a) => a.id === 'so'));
});

test('cleanForPricing: exclude beats include', () => {
  const r = cleanForPricing([...ok(5), f('s', 100, ['suspect_title'])], { exclude: ['s'], include: ['s'] });
  assert.equal(reasons(r).s, 'excluded');
});

test('cleanForPricing: outliers at 0.3x and 3x median', () => {
  const ads = [
    f('p29', 29, []), f('p100a', 100, []), f('p30', 30, []), f('p100b', 100, []),
    f('p301', 301, []), f('p100c', 100, []), f('p300', 300, []), f('p100d', 100, []), f('p100e', 100, []),
  ];
  const r = cleanForPricing(ads);
  assert.deepEqual(reasons(r), { p29: 'outlier', p301: 'outlier' });
  assert.deepEqual(r.kept.map((a) => a.id), ['p100a', 'p30', 'p100b', 'p100c', 'p300', 'p100d', 'p100e']);
});

test('cleanForPricing: median ignores items dropped for other reasons', () => {
  const r = cleanForPricing([
    ...ok(5), f('junk1', 1, ['suspect_title']), f('junk2', 1, ['suspect_title']),
    f('junk3', 1, ['suspect_title']), f('junk4', 1, ['suspect_title']), f('junk5', 1, ['suspect_title']), f('junk6', 1, ['suspect_title']),
    f('high', 250, []),
  ]);
  assert.equal(reasons(r).high, undefined);
  assert.equal(reasons(r).junk1, 'suspect_title');
});

test('cleanForPricing: included ads are never outliers', () => {
  const r = cleanForPricing([...ok(5), f('cheap', 1, [])], { include: ['cheap'] });
  assert.deepEqual(r.dropped, []);
  assert.equal(r.kept.length, 6);
});

const st = (n, q1, median, q3) => ({ n, q1, median, q3 });

test('reliability levels by n', () => {
  assert.deepEqual(reliability(st(4, 99, 100, 101)), { level: 'insufficient', reasons: ['too_few'] });
  assert.deepEqual(reliability(st(5, 99, 100, 101)), { level: 'low', reasons: ['few'] });
  assert.deepEqual(reliability(st(9, 99, 100, 101)), { level: 'low', reasons: ['few'] });
  assert.deepEqual(reliability(st(10, 99, 100, 101)), { level: 'ok', reasons: [] });
});

test('reliability wide spread lowers ok to low', () => {
  assert.deepEqual(reliability(st(10, 80, 100, 130)), { level: 'low', reasons: ['wide_spread'] });
});

test('reliability wide spread with few adds a reason', () => {
  const r = reliability(st(5, 80, 100, 130));
  assert.equal(r.level, 'low');
  assert.deepEqual([...r.reasons].sort(), ['few', 'wide_spread']);
});

test('reliability ignores spread when n < 5', () => {
  assert.deepEqual(reliability(st(4, 80, 100, 130)), { level: 'insufficient', reasons: ['too_few'] });
});

const S = { n: 9, q1: 90, median: 100, q3: 110 };

test('position bands and boundaries', () => {
  assert.equal(position(80, S).band, 'below_q1');
  assert.equal(position(90, S).band, 'q1_median');
  assert.equal(position(99, S).band, 'q1_median');
  assert.equal(position(100, S).band, 'median_q3');
  assert.equal(position(110, S).band, 'median_q3');
  assert.equal(position(111, S).band, 'above_q3');
});

test('position vs_median_pct is rounded', () => {
  assert.equal(position(80, S).vs_median_pct, -20);
  assert.equal(position(104.6, S).vs_median_pct, 5);
});

test('position suspicious_low below half of median', () => {
  assert.equal(position(49, S).suspicious_low, true);
  assert.equal(position(50, S).suspicious_low, false);
});

test('position with n=0', () => {
  assert.deepEqual(position(100, { n: 0, q1: null, median: null, q3: null }), {
    vs_median_pct: null, band: null, suspicious_low: false,
  });
});

test('cleanForPricing: stale flag alone is not a reason to drop', () => {
  const r = cleanForPricing([...ok(5), f('old', 100, ['stale'])]);
  assert.equal(r.dropped.length, 0);
  assert.equal(r.kept.length, 6);
  assert.ok(r.kept.some((a) => a.id === 'old'));
});

test('cleanForPricing: (guard) an ad whose only flag is suspect_text is kept', () => {
  const r = cleanForPricing([...ok(5), f('t', 100, ['suspect_text'])]);
  assert.equal(r.kept.length, 6);
  assert.ok(r.kept.some((a) => a.id === 't'));
  assert.deepEqual(r.dropped, []);
});
