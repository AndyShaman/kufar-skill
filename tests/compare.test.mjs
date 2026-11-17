import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAds, compare } from '../scripts/lib/compare.mjs';
import { normalizeAd } from '../scripts/lib/ads.mjs';
import { KufarError } from '../scripts/lib/errors.mjs';
import { mkAd, rawAdOf, fakeTransport, itemIdOf, rejectsCode } from './helpers.mjs';

const P = (value, text, label = null) => ({ label, value, text, filter: null });
const card = (id, params, over = {}) => mkAd(id, 100, { category: '17010', params, ...over });

// ---- compareAds ----

test('compareAds: a characteristic with different values goes to differs with the text of each card, in card order', () => {
  const r = compareAds([
    card(1000000001, { memory: P('20', '128 ГБ', 'Память') }),
    card(1000000002, { memory: P('30', '256 ГБ', 'Память') }),
    card(1000000003, { memory: P('20', '128 ГБ', 'Память') }),
  ]);
  assert.deepEqual(r.differs, [{ name: 'memory', label: 'Память', values: ['128 ГБ', '256 ГБ', '128 ГБ'] }]);
  assert.deepEqual(r.same, []);
});

test('compareAds: a characteristic with an equal value in every card goes to same', () => {
  const r = compareAds([
    card(1000000001, { color: P('1', 'Чёрный', 'Цвет') }),
    card(1000000002, { color: P('1', 'Чёрный', 'Цвет') }),
  ]);
  assert.deepEqual(r.same, [{ name: 'color', label: 'Цвет', text: 'Чёрный' }]);
  assert.deepEqual(r.differs, []);
});

test('compareAds: a characteristic one card lacks is in differs with null at its place', () => {
  const r = compareAds([
    card(1000000001, { year: P('2019', '2019', 'Год') }),
    card(1000000002, {}),
    card(1000000003, { year: P('2020', '2020', 'Год') }),
  ]);
  assert.deepEqual(r.differs, [{ name: 'year', label: 'Год', values: ['2019', null, '2020'] }]);
  assert.deepEqual(r.same, []);
});

test('compareAds: a characteristic missing in a card is in differs even when the others agree', () => {
  const r = compareAds([
    card(1000000001, {}),
    card(1000000002, { year: P('2019', '2019', 'Год') }),
    card(1000000003, { year: P('2019', '2019', 'Год') }),
  ]);
  assert.deepEqual(r.differs, [{ name: 'year', label: 'Год', values: [null, '2019', '2019'] }]);
  assert.deepEqual(r.same, []);
});

test('compareAds: a text that is null shows the value', () => {
  const r = compareAds([
    card(1000000001, { km: P('120000', null, 'Пробег') }),
    card(1000000002, { km: P('95000', '95 тыс.', 'Пробег') }),
  ]);
  assert.deepEqual(r.differs, [{ name: 'km', label: 'Пробег', values: ['120000', '95 тыс.'] }]);
});

test('compareAds: the order is the order of first appearance, card by card', () => {
  const r = compareAds([
    card(1000000001, { b: P('1', 'b1', 'B'), a: P('1', 'a1', 'A') }),
    card(1000000002, { c: P('2', 'c2', 'C'), a: P('2', 'a2', 'A'), b: P('2', 'b2', 'B') }),
  ]);
  assert.deepEqual(r.differs.map((x) => x.name), ['b', 'a', 'c']);
});

test('compareAds: the order of same follows the same rule', () => {
  const r = compareAds([
    card(1000000001, { y: P('1', 'Y', 'Y'), x: P('1', 'X', 'X') }),
    card(1000000002, { x: P('1', 'X', 'X'), y: P('1', 'Y', 'Y') }),
  ]);
  assert.deepEqual(r.same.map((x) => x.name), ['y', 'x']);
});

test('compareAds: differs and same together, each characteristic in one of them', () => {
  const r = compareAds([
    card(1000000001, { color: P('1', 'Чёрный', 'Цвет'), memory: P('20', '128 ГБ', 'Память') }),
    card(1000000002, { color: P('1', 'Чёрный', 'Цвет'), memory: P('30', '256 ГБ', 'Память') }),
  ]);
  assert.deepEqual(r.differs.map((x) => x.name), ['memory']);
  assert.deepEqual(r.same.map((x) => x.name), ['color']);
});

test('compareAds: cards without characteristics give empty lists', () => {
  const r = compareAds([card(1000000001, {}), card(1000000002, {})]);
  assert.deepEqual(r, { differs: [], same: [], mixed_categories: false });
});

test('compareAds: values has one entry per card', () => {
  const cards = [1, 2, 3, 4, 5].map((n) => card(1000000000 + n, { n: P(String(n), `n${n}`, 'N') }));
  assert.equal(compareAds(cards).differs[0].values.length, 5);
});

test('compareAds: mixed_categories is false for one category and true for several', () => {
  assert.equal(compareAds([card(1000000001, {}), card(1000000002, {})]).mixed_categories, false);
  assert.equal(compareAds([card(1000000001, {}), card(1000000002, {}, { category: '2040' })]).mixed_categories, true);
  assert.equal(compareAds([card(1000000001, {}), card(1000000002, {}), card(1000000003, {}, { category: '2040' })]).mixed_categories, true);
});

test('compareAds: the cards are not changed', () => {
  const cards = [card(1000000001, { a: P('1', 'x', 'A') }), card(1000000002, { a: P('2', 'y', 'A') })];
  const before = structuredClone(cards);
  compareAds(cards);
  assert.deepEqual(cards, before);
});

// ---- compare ----

const IDS = ['1000000001', '1000000002', '1000000003'];
const priceOf = { 1000000001: 300, 1000000002: 400, 1000000003: 500 };

function market(gone = [], boom = null) {
  return fakeTransport((p) => {
    const id = itemIdOf(p);
    if (boom === id) throw new KufarError('RATE_LIMITED', 'too many');
    if (gone.includes(id)) throw new KufarError('NOT_FOUND', 'Не найдено', { status: 404 });
    return { result: rawAdOf({ id: Number(id), price: priceOf[id] }) };
  });
}
const cardOf = (id) => normalizeAd(rawAdOf({ id: Number(id), price: priceOf[id] }));

test('compare: the cards come in the order of the refs, ids and links alike, fetched one after another', async () => {
  const tr = market();
  const r = await compare(tr, [IDS[2], `https://www.kufar.by/item/${IDS[0]}`, IDS[1]]);
  assert.deepEqual(r.ads.map((a) => a.id), [IDS[2], IDS[0], IDS[1]]);
  assert.deepEqual(r.ads, [cardOf(IDS[2]), cardOf(IDS[0]), cardOf(IDS[1])]);
  assert.deepEqual(tr.calls.map((c) => itemIdOf(c.path)), [IDS[2], IDS[0], IDS[1]]);
  assert.equal(r.count, 3);
  assert.deepEqual(r.missing, []);
});

test('compare: the answer has exactly count, ads, missing, differs, same, mixed_categories', async () => {
  const r = await compare(market(), IDS.slice(0, 2));
  assert.deepEqual(Object.keys(r).sort(), ['ads', 'count', 'differs', 'mixed_categories', 'missing', 'same']);
});

test('compare: differs, same and mixed_categories are those of compareAds over the fetched cards', async () => {
  const r = await compare(market(), IDS);
  const want = compareAds(IDS.map(cardOf));
  assert.deepEqual(r.differs, want.differs);
  assert.deepEqual(r.same, want.same);
  assert.equal(r.mixed_categories, want.mixed_categories);
});

test('compare: a listing Kufar no longer has goes to missing and the rest are compared', async () => {
  const r = await compare(market([IDS[1]]), IDS);
  assert.deepEqual(r.missing, [IDS[1]]);
  assert.equal(r.count, 2);
  assert.deepEqual(r.ads.map((a) => a.id), [IDS[0], IDS[2]]);
  assert.deepEqual(r.differs, compareAds([cardOf(IDS[0]), cardOf(IDS[2])]).differs);
});

test('compare: two of three missing -> NOT_FOUND with the missing ids', async () => {
  await assert.rejects(compare(market([IDS[0], IDS[2]]), IDS), (e) => {
    assert.equal(e.name, 'KufarError');
    assert.equal(e.code, 'NOT_FOUND');
    assert.deepEqual(e.details.missing, [IDS[0], IDS[2]]);
    return true;
  });
});

test('compare: both of two missing -> NOT_FOUND', async () => {
  await rejectsCode(compare(market([IDS[0], IDS[1]]), IDS.slice(0, 2)), 'NOT_FOUND');
});

test('compare: another error is thrown as it is', async () => {
  await rejectsCode(compare(market([], IDS[1]), IDS), 'RATE_LIMITED');
});
