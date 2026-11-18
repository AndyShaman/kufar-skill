import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAds, compare, pickBest, compareBest } from '../skills/kufar/scripts/lib/compare.mjs';
import { normalizeAd } from '../skills/kufar/scripts/lib/ads.mjs';
import { KufarError } from '../skills/kufar/scripts/lib/errors.mjs';
import { mkAd, rawAdOf, fakeTransport, itemIdOf, rejectsCode, pageOf, SEARCH_PATH, NOW, CLOCK } from './helpers.mjs';

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
  assert.deepEqual(Object.keys(r).sort(), ['ads', 'count', 'differs', 'missing', 'mixed_categories', 'same']);
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

// ---- pickBest ----

// an estimate in the shape estimatePrice returns; each comparable is [price] or [price, 'stale']
function estimateOf(median, rows, level = 'good', total = rows.length) {
  return {
    stats: { all: { median }, private: {}, company: {} },
    // the median that `price` names: null when the estimate is not reliable enough
    suggest: level === 'insufficient' ? null : { fast: median, market: median, high: median, basis: 'all' },
    reliability: { level, reasons: [] },
    total_on_site: total,
    comparables: rows.map(([price, stale], i) => ({
      id: `${2000000001 + i}`, title: `Товар ${i}`, price_byn: price, company: false, listed_at: '2026-11-15T12:00:00.000Z',
      days: stale ? 100 : 2, age_days: stale ? 100 : 2, stale: stale === 'stale', bumped: false, url: `https://www.kufar.by/item/${2000000001 + i}`,
    })),
  };
}
const idAt = (i) => `${2000000001 + i}`;

test('pickBest: a price of half the median or less is too cheap, the cheapest top of the rest are picked with their distance from the median', () => {
  const r = pickBest(estimateOf(400, [[150], [200], [250], [300], [380], [420]]), 3);
  assert.equal(r.median, 400);
  assert.deepEqual(r.skipped.too_cheap.map((x) => x.id), [idAt(0), idAt(1)]);
  assert.deepEqual(r.picked, [
    { id: idAt(2), price_byn: 250, vs_median_pct: -37, stale: false },
    { id: idAt(3), price_byn: 300, vs_median_pct: -25, stale: false },
    { id: idAt(4), price_byn: 380, vs_median_pct: -5, stale: false },
  ]);
  assert.equal(r.skipped.other, 1);
  assert.equal(r.skipped.stale, 0);
});

test('pickBest: too_cheap entries carry id, price_byn and url only', () => {
  const r = pickBest(estimateOf(400, [[150], [300], [350], [380]]), 3);
  assert.deepEqual(r.skipped.too_cheap, [{ id: idAt(0), price_byn: 150, url: `https://www.kufar.by/item/${idAt(0)}` }]);
});

test('pickBest: the result has exactly median, picked, skipped', () => {
  const r = pickBest(estimateOf(400, [[300], [350]]), 3);
  assert.deepEqual(Object.keys(r).sort(), ['median', 'picked', 'skipped']);
  assert.deepEqual(Object.keys(r.skipped).sort(), ['cheaper', 'other', 'stale', 'too_cheap']);
});

test('pickBest: not stale listings come first, the cheapest stale ones fill the rest', () => {
  const r = pickBest(estimateOf(400, [[250, 'stale'], [260, 'stale'], [300], [380], [390, 'stale']]), 3);
  assert.deepEqual(r.picked.map((x) => x.id), [idAt(2), idAt(3), idAt(0)]);
  assert.deepEqual(r.picked.map((x) => x.stale), [false, false, true]);
  assert.equal(r.skipped.stale, 2);
  assert.equal(r.skipped.other, 0);
});

test('pickBest: a stale listing is not picked while enough not stale ones exist', () => {
  const r = pickBest(estimateOf(400, [[250, 'stale'], [300], [320], [340], [360]]), 3);
  assert.deepEqual(r.picked.map((x) => x.id), [idAt(1), idAt(2), idAt(3)]);
  assert.equal(r.skipped.stale, 1);
  assert.equal(r.skipped.other, 1);
});

test('pickBest: a too cheap listing is not counted as stale or other even when it is stale', () => {
  const r = pickBest(estimateOf(400, [[100, 'stale'], [300], [320]]), 3);
  assert.deepEqual(r.skipped.too_cheap.map((x) => x.id), [idAt(0)]);
  assert.equal(r.skipped.stale, 0);
  assert.equal(r.skipped.other, 0);
});

test('pickBest: insufficient reliability gives no median, no too cheap, null distances, the cheapest top picked', () => {
  const r = pickBest(estimateOf(400, [[100], [200, 'stale'], [300], [350], [380]], 'insufficient'), 3);
  assert.equal(r.median, null);
  assert.deepEqual(r.skipped.too_cheap, []);
  assert.deepEqual(r.picked.map((x) => x.id), [idAt(0), idAt(2), idAt(3)]);
  assert.ok(r.picked.every((x) => x.vs_median_pct === null));
  assert.equal(r.skipped.stale, 1);
  assert.equal(r.skipped.other, 1);
});

test('pickBest: top is 3 by default', () => {
  const r = pickBest(estimateOf(400, [[300], [310], [320], [330], [340]]));
  assert.equal(r.picked.length, 3);
});

test('pickBest: top 2 and top 5 are honoured', () => {
  const e = estimateOf(400, [[300], [310], [320], [330], [340], [350]]);
  assert.deepEqual(pickBest(e, 2).picked.map((x) => x.id), [idAt(0), idAt(1)]);
  assert.equal(pickBest(e, 5).picked.length, 5);
  assert.equal(pickBest(e, 5).skipped.other, 1);
});

test('pickBest: fewer candidates than top are all picked', () => {
  const r = pickBest(estimateOf(400, [[300], [350]]), 5);
  assert.deepEqual(r.picked.map((x) => x.id), [idAt(0), idAt(1)]);
  assert.equal(r.skipped.other, 0);
});

test('pickBest: the estimate is not changed', () => {
  const e = estimateOf(400, [[150], [300, 'stale'], [350]]);
  const before = structuredClone(e);
  pickBest(e, 3);
  assert.deepEqual(e, before);
});

// ---- compareBest ----

const BIDS = [0, 1, 2, 3, 4, 5, 6].map((i) => 1000000010 + i);
const BPRICES = [300, 320, 340, 360, 380, 400, 420];
const BRAW = Object.fromEntries(BIDS.map((id, i) => [id, rawAdOf({ id, price: BPRICES[i] })]));
const OPTS = { cat: '17010', params: { phm: '5380' } };
// the tests below describe the cheapest pick
const bestOf = (tr, over = {}) => compareBest(tr, OPTS, { top: 3, pick: 'cheap', now: () => NOW, clock: CLOCK, ...over });

function bestMarket(gone = [], ids = BIDS, total = ids.length) {
  return fakeTransport((p) => {
    const id = itemIdOf(p);
    if (!id) return pageOf(ids.map((x) => BRAW[x]), total);
    if (gone.includes(id)) throw new KufarError('NOT_FOUND', 'Не найдено', { status: 404 });
    return { result: BRAW[id] };
  });
}

test('compareBest: the answer has group, stats, reliability, picked, skipped and the keys of compare', async () => {
  const r = await bestOf(bestMarket());
  assert.deepEqual(Object.keys(r).sort(), ['ads', 'count', 'differs', 'group', 'missing', 'mixed_categories', 'picked', 'reliability', 'same', 'skipped', 'stats']);
  assert.equal(r.group.cat, '17010');
  assert.deepEqual(r.group.params, { phm: '5380' });
  assert.ok(r.stats.all);
  assert.ok(['good', 'medium', 'low', 'insufficient'].includes(r.reliability.level));
});

test('compareBest: the cheapest top listings are picked and compared, ads in the order of picked', async () => {
  const tr = bestMarket();
  const r = await bestOf(tr);
  assert.deepEqual(r.picked.map((x) => x.id), [`${BIDS[0]}`, `${BIDS[1]}`, `${BIDS[2]}`]);
  assert.deepEqual(r.ads.map((a) => a.id), r.picked.map((x) => x.id));
  assert.equal(r.count, 3);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.differs, compareAds(r.ads.map((a) => normalizeAd(BRAW[a.id]))).differs);
  assert.equal(tr.calls.filter((c) => c.path === SEARCH_PATH).length >= 1, true);
  assert.deepEqual(tr.calls.filter((c) => itemIdOf(c.path)).map((c) => itemIdOf(c.path)), r.picked.map((x) => x.id));
});

test('compareBest: top limits the number of picked listings', async () => {
  const r = await bestOf(bestMarket(), { top: 2 });
  assert.equal(r.picked.length, 2);
  assert.equal(r.count, 2);
});

test('compareBest: a picked listing whose card is gone goes to missing and is absent from picked', async () => {
  const r = await bestOf(bestMarket([`${BIDS[1]}`]));
  assert.deepEqual(r.missing, [`${BIDS[1]}`]);
  assert.deepEqual(r.picked.map((x) => x.id), [`${BIDS[0]}`, `${BIDS[2]}`]);
  assert.deepEqual(r.ads.map((a) => a.id), [`${BIDS[0]}`, `${BIDS[2]}`]);
  assert.equal(r.count, 2);
});

// ---- the pick by default: a good thing for normal money ----

// the prices are 300..420: the lower quarter is 330, the middle 360
test('compareBest: by default the pick starts at the fast price, cheaper listings are counted and not opened', async () => {
  const tr = bestMarket();
  const r = await compareBest(tr, OPTS, { top: 3, now: () => NOW, clock: CLOCK });
  const expected = BIDS.filter((_, i) => BPRICES[i] >= 330).slice(0, 3).map(String);
  assert.deepEqual(r.picked.map((x) => x.id), expected);
  assert.equal(r.skipped.cheaper, 2);
  assert.deepEqual(tr.calls.filter((c) => itemIdOf(c.path)).map((c) => itemIdOf(c.path)), expected);
});

test('compareBest: pick fair is the default, pick cheap opens the cheapest, another value is BAD_ARGS', async () => {
  const fair = await compareBest(bestMarket(), OPTS, { top: 3, pick: 'fair', now: () => NOW, clock: CLOCK });
  const byDefault = await compareBest(bestMarket(), OPTS, { top: 3, now: () => NOW, clock: CLOCK });
  assert.deepEqual(fair.picked, byDefault.picked);
  const cheap = await compareBest(bestMarket(), OPTS, { top: 3, pick: 'cheap', now: () => NOW, clock: CLOCK });
  assert.deepEqual(cheap.picked.map((x) => x.id), BIDS.slice(0, 3).map(String));
  assert.equal(cheap.skipped.cheaper, 0);
  await rejectsCode(compareBest(bestMarket(), OPTS, { top: 3, pick: 'best', now: () => NOW, clock: CLOCK }), 'BAD_ARGS');
});

test('pickBest: with a floor, listings below it and above half the middle are counted as cheaper', () => {
  const r = pickBest(estimateOf(400, [[150], [250], [300], [380], [420], [450]]), 2, 350);
  assert.deepEqual(r.picked.map((x) => x.id), [idAt(3), idAt(4)]);
  assert.equal(r.skipped.cheaper, 2);
  assert.deepEqual(r.skipped.too_cheap.map((x) => x.id), [idAt(0)]);
  assert.equal(r.skipped.other, 1);
  assert.equal(pickBest(estimateOf(400, [[250], [380]]), 2).skipped.cheaper, 0);
});

// a market where some cards say in their text that the thing is broken
function defectMarket(bodies, ids = BIDS) {
  return fakeTransport((p) => {
    const id = itemIdOf(p);
    if (!id) return pageOf(ids.map((x) => BRAW[x]), ids.length);
    return { result: { ...BRAW[id], body: bodies[id] ?? 'Отличное состояние, полный комплект' } };
  });
}
const ids = (r) => r.picked.map((x) => x.id);

test('compareBest: a card whose text names a defect is not dropped: it goes after the cards without one, with the piece of text', async () => {
  const tr = defectMarket({ [BIDS[0]]: 'Экран разбит, на запчасти', [BIDS[2]]: 'Не включается после воды' });
  const r = await bestOf(tr);
  assert.deepEqual(ids(r), [BIDS[1], BIDS[3], BIDS[4], BIDS[0], BIDS[2]].map(String));
  assert.deepEqual(r.ads.map((a) => a.id), ids(r));
  assert.equal(r.count, 5);
  assert.deepEqual(r.picked.slice(0, 3).map((x) => x.defect), [null, null, null]);
  assert.ok(r.picked[3].defect.includes('разбит'), r.picked[3].defect);
  assert.ok(r.picked[4].defect.includes('Не включается'), r.picked[4].defect);
  assert.deepEqual(Object.keys(r.picked[3]).sort(), ['defect', 'id', 'price_byn', 'stale', 'vs_median_pct']);
  assert.equal(r.picked[3].price_byn, BPRICES[0]);
  // seven candidates: five opened, two not looked at
  assert.equal(r.skipped.other, 2);
  assert.equal(r.skipped.stale, 0);
  assert.deepEqual(Object.keys(r.skipped).sort(), ['cheaper', 'other', 'stale', 'too_cheap']);
});

test('compareBest: without defects every picked card has defect null and the counts are those of pickBest', async () => {
  const r = await bestOf(defectMarket({}));
  assert.deepEqual(r.picked.map((x) => x.defect), [null, null, null]);
  assert.equal(r.skipped.other, 4);
});

test('compareBest: a defect the text denies leaves the card where its price puts it', async () => {
  const r = await bestOf(defectMarket({ [BIDS[0]]: 'Не заблокирован, трещин нет' }));
  assert.deepEqual(ids(r), [BIDS[0], BIDS[1], BIDS[2]].map(String));
  assert.equal(r.picked[0].defect, null);
});

test('compareBest: no more than three cards per place are opened; what is found by then is the answer', async () => {
  const bad = Object.fromEntries(BIDS.slice(0, 4).map((id) => [id, 'На запчасти']));
  const tr = defectMarket(bad);
  const r = await bestOf(tr, { top: 2 });
  assert.equal(tr.calls.filter((c) => itemIdOf(c.path)).length, 6);
  assert.deepEqual(ids(r), [BIDS[4], BIDS[5], BIDS[0], BIDS[1], BIDS[2], BIDS[3]].map(String));
  assert.equal(r.skipped.other, 1);
});

test('compareBest: when every opened card names a defect they are still the answer, none first by right', async () => {
  const bad = Object.fromEntries(BIDS.slice(0, 6).map((id) => [id, 'Не работает экран']));
  const tr = defectMarket(bad);
  const r = await bestOf(tr, { top: 2 });
  assert.equal(tr.calls.filter((c) => itemIdOf(c.path)).length, 6);
  assert.deepEqual(ids(r), BIDS.slice(0, 6).map(String));
  assert.ok(r.picked.every((x) => typeof x.defect === 'string'));
  assert.equal(r.count, 6);
});

test('compareBest: a card that is gone still takes its place, a card with a defect does not', async () => {
  const tr = fakeTransport((p) => {
    const id = itemIdOf(p);
    if (!id) return pageOf(BIDS.map((x) => BRAW[x]), BIDS.length);
    if (id === `${BIDS[1]}`) throw new KufarError('NOT_FOUND', 'Не найдено', { status: 404 });
    return { result: { ...BRAW[id], body: id === `${BIDS[0]}` ? 'Под восстановление' : 'Всё работает' } };
  });
  const r = await bestOf(tr);
  assert.deepEqual(r.missing, [`${BIDS[1]}`]);
  assert.deepEqual(ids(r), [BIDS[2], BIDS[3], BIDS[0]].map(String));
});

test('compareBest: fewer than two cards still on the site -> NOT_FOUND with the missing ones', async () => {
  const two = [BIDS[0], BIDS[1]];
  const tr = fakeTransport((p) => {
    const id = itemIdOf(p);
    if (!id) return pageOf(two.map((x) => BRAW[x]), 2);
    if (id === `${BIDS[1]}`) throw new KufarError('NOT_FOUND', 'Не найдено', { status: 404 });
    return { result: BRAW[id] };
  });
  await assert.rejects(bestOf(tr), (e) => {
    assert.equal(e.code, 'NOT_FOUND');
    assert.deepEqual(e.details.missing, [`${BIDS[1]}`]);
    return true;
  });
});

test('compareBest: fewer than 2 picked -> NOT_ENOUGH with found and total_on_site, no card is requested', async () => {
  const tr = bestMarket([], [BIDS[0]], 1);
  await assert.rejects(bestOf(tr), (e) => {
    assert.equal(e.name, 'KufarError');
    assert.equal(e.code, 'NOT_ENOUGH');
    assert.equal(e.details.found, 1);
    assert.equal(e.details.total_on_site, 1);
    return true;
  });
  assert.equal(tr.calls.filter((c) => itemIdOf(c.path)).length, 0);
});

test('compareBest: nothing found -> NOT_ENOUGH with found 0', async () => {
  const tr = bestMarket([], [], 0);
  await assert.rejects(bestOf(tr), (e) => {
    assert.equal(e.code, 'NOT_ENOUGH');
    assert.equal(e.details.found, 0);
    return true;
  });
});

test('compareBest: the group options are those of price, a missing cat is BAD_ARGS', async () => {
  await rejectsCode(compareBest(bestMarket(), {}, { top: 3, now: () => NOW }), 'BAD_ARGS');
});
