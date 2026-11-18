import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchQuery, search, flagAds, ageDays, STALE_DAYS, BUMP_GAP_DAYS, defectIn,
} from '../skills/kufar/scripts/lib/search.mjs';
import {
  rejectsCode, throwsCode, plain, mkAd, rawAd, fakeTransport, SEARCH_PATH, NOW, DAY, daysAgo, CLOCK,
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
  assert.equal(q({ cat: '1', sort: 'old' }).sort, 'lst.a');
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

test('BUMP_GAP_DAYS is 7', () => {
  assert.equal(BUMP_GAP_DAYS, 7);
});

// 1960000 is 40 days old by CLOCK, 1980000 is 20, 1942000 is 58
test('flagAds with a clock: every ad gets age_days', () => {
  const r = flagAds([
    mkAd(1960000, 100, { listed_at: daysAgo(40) }),
    mkAd(1980000, 100, { listed_at: daysAgo(0) }),
    mkAd(1000000001, 100, { listed_at: daysAgo(3) }),
  ], NOW, CLOCK);
  assert.deepEqual(r.map((a) => a.age_days), [40, 20, 3]);
  assert.deepEqual(r.map((a) => a.days), [40, 0, 3]);
});

test('flagAds with a clock: private ad bumped today with an old id is stale and bumped, after the other flags', () => {
  const [a] = flagAds([mkAd(1960000, null, { type: 'buy', title: 'Куплю запчасти', listed_at: daysAgo(0) })], NOW, CLOCK);
  assert.equal(a.days, 0);
  assert.equal(a.age_days, 40);
  assert.deepEqual(a.flags, ['no_price', 'not_sell', 'suspect_title', 'stale', 'bumped']);
  const [b] = flagAds([mkAd(1960000, 100, { listed_at: daysAgo(0) })], NOW, CLOCK);
  assert.deepEqual(b.flags, ['stale', 'bumped']);
});

test('flagAds with a clock: a company ad is never stale or bumped, age_days is still computed', () => {
  const [a] = flagAds([mkAd(1960000, 100, { company: true, listed_at: daysAgo(0) })], NOW, CLOCK);
  assert.equal(a.age_days, 40);
  assert.deepEqual(a.flags, []);
});

test('flagAds: company ad without a clock is not stale either', () => {
  const [a] = flagAds([mkAd(1, 100, { company: true, listed_at: daysAgo(40) })], NOW);
  assert.equal(a.days, 40);
  assert.deepEqual(a.flags, []);
});

test('flagAds: bumped without stale (age 20, days 2)', () => {
  const [a] = flagAds([mkAd(1980000, 100, { listed_at: daysAgo(2) })], NOW, CLOCK);
  assert.equal(a.age_days, 20);
  assert.deepEqual(a.flags, ['bumped']);
});

test('flagAds: no bumped when days >= 7 (age 58, days 50)', () => {
  const [a] = flagAds([mkAd(1942000, 100, { listed_at: daysAgo(50) })], NOW, CLOCK);
  assert.equal(a.age_days, 58);
  assert.deepEqual(a.flags, ['stale']);
});

test('flagAds: bumped edges, gap 7 yes and 6 no, days 6 yes', () => {
  const yes = flagAds([mkAd(1980000, 100, { listed_at: daysAgo(6) })], NOW, CLOCK)[0]; // age 20, days 6: gap 14
  assert.deepEqual(yes.flags, ['bumped']);
  const gap7 = flagAds([mkAd(1990000, 100, { listed_at: daysAgo(3) })], NOW, CLOCK)[0]; // age 10, days 3: gap 7
  assert.deepEqual(gap7.flags, ['bumped']);
  const gap6 = flagAds([mkAd(1991000, 100, { listed_at: daysAgo(3) })], NOW, CLOCK)[0]; // age 9, days 3: gap 6
  assert.deepEqual(gap6.flags, []);
});

test('flagAds: no bumped when age_days - days < 7', () => {
  const [a] = flagAds([mkAd(1000000001, 100, { listed_at: daysAgo(2) })], NOW, CLOCK);
  assert.equal(a.age_days, 2);
  assert.deepEqual(a.flags, []);
});

test('flagAds without a clock: age_days equals days', () => {
  const r = flagAds([mkAd(1960000, 100, { listed_at: daysAgo(40) }), mkAd(2, 100, { listed_at: null })], NOW);
  assert.deepEqual(r.map((a) => a.age_days), [40, null]);
  assert.deepEqual(r.map((a) => a.days), [40, null]);
  assert.deepEqual(flagAds([mkAd(1960000, 100, { listed_at: daysAgo(0) })], NOW, null)[0].flags, []);
});

test('search passes clock to the flags', async () => {
  const tr = fakeTransport(() => ({ ads: [rawAd({ ad_id: 1960000, list_time: daysAgo(0) })] }));
  const a = (await search(tr, { cat: '1' }, { now: () => NOW, clock: CLOCK })).ads[0];
  assert.equal(a.days, 0);
  assert.equal(a.age_days, 40);
  assert.deepEqual(a.flags, ['stale', 'bumped']);
  const b = (await search(tr, { cat: '1' }, { now: () => NOW })).ads[0];
  assert.equal(b.age_days, 0);
  assert.deepEqual(b.flags, []);
});

// suspect_text: a body that says the thing is broken or for parts
const SUSPECT_BODY_PHRASES = ['на запчасти', 'под запчасти', 'по запчастям', 'на разбор', 'под разбор', 'на детали', 'заблокирован', 'не включается', 'под восстановление', 'не работает', 'не работают', 'не реагирует', 'неисправен', 'разбит', 'треснул', 'треснуто стекло', 'трещина', 'требует ремонта', 'нужен ремонт', 'под ремонт', 'не заводится', 'не на ходу', 'после дтп'];

test('flagAds: a suspect body sets suspect_text and not suspect_title', () => {
  const [a] = flagAds([mkAd(1, 100, { body: 'Заблокирован, на запчасти' })], NOW);
  assert.ok(a.flags.includes('suspect_text'));
  assert.ok(!a.flags.includes('suspect_title'));
});

test('flagAds: each suspect body phrase alone sets suspect_text', () => {
  for (const w of SUSPECT_BODY_PHRASES) {
    assert.ok(flagAds([mkAd(1, 100, { body: `Продаю, ${w}, торг` })], NOW)[0].flags.includes('suspect_text'), w);
  }
  assert.ok(flagAds([mkAd(1, 100, { body: 'Дисплей бывает НЕ РЕАГИРУЕТ на касание' })], NOW)[0].flags.includes('suspect_text'));
});

test('flagAds: defects in the words sellers really use', () => {
  for (const body of ['дефект экран сломан он под замену', 'Повреждена матрица все работает идеально', 'Висит локнутый на айклауде Весь в идеале',
    'Залочен под оператора', 'Забыт пароль, по поводу айклауда не знаю', 'брался как донор для другого телефона', 'АКБ вздуто', 'Продаю по частям',
    'пароль от экрана блокировки неизвестен']) {
    assert.ok(flagAds([mkAd(1, 100, { body })], NOW)[0].flags.includes('suspect_text'), body);
  }
  for (const body of ['Не сломан, не вскрывался', 'Без повреждений', 'Повреждений нет']) {
    assert.ok(!flagAds([mkAd(1, 100, { body })], NOW)[0].flags.includes('suspect_text'), body);
  }
});

test('flagAds: «бит экран» is a defect, «не бит» and «64 бит» are not', () => {
  for (const body of ['фейс рабочий, бит экран и задняя крышка', 'Битый экран, остальное работает', 'Экран битый']) {
    assert.ok(flagAds([mkAd(1, 100, { body })], NOW)[0].flags.includes('suspect_text'), body);
  }
  for (const body of ['Не бит, не крашен', 'Windows 10 64 бит, SSD 256', 'Процессор 64-бит', 'Работает быстро, любит уход']) {
    assert.ok(!flagAds([mkAd(1, 100, { body })], NOW)[0].flags.includes('suspect_text'), body);
  }
});

test('flagAds: a title that says the thing does not work or is sold in parts is suspect_title', () => {
  for (const title of ['iPhone 13 128gb (нерабочий)', 'Rover 75 2.0V6 по частям', 'iPhone 13 локнутый', 'Айфон 13 залочен', 'Плата донор iPhone 13']) {
    assert.ok(flagAds([mkAd(1, 100, { title, body: null })], NOW)[0].flags.includes('suspect_title'), title);
  }
});

test('flagAds: a defect that the text denies is not a defect', () => {
  for (const body of ['Не заблокирован, iCloud чистый', 'Экран не разбит и не треснул', 'Без трещин и сколов', 'Трещин нет, сколов нет',
    'Неисправностей нет', 'Ни разу не разбит', 'Нет трещин']) {
    assert.ok(!flagAds([mkAd(1, 100, { body })], NOW)[0].flags.includes('suspect_text'), body);
  }
});

test('flagAds: a denied defect next to a named one is still a defect', () => {
  assert.ok(flagAds([mkAd(1, 100, { body: 'Не заблокирован, но экран разбит' })], NOW)[0].flags.includes('suspect_text'));
});

test('flagAds: spare parts that come with the thing are not a defect', () => {
  for (const body of ['Запчасти в подарок', 'Все запчасти оригинальные, обслужен', 'Разблокирован, работает с любой сим-картой']) {
    assert.ok(!flagAds([mkAd(1, 100, { body })], NOW)[0].flags.includes('suspect_text'), body);
  }
});

test('defectIn: the piece of the text that names the defect, null for a clean text or no text', () => {
  const found = defectIn('Продаю айфон, пользовался год. Не работает Face ID, в остальном всё хорошо, торг уместен у телефона при встрече в Минске');
  assert.ok(found.includes('Не работает Face ID'), found);
  assert.ok(found.length <= 90, found);
  assert.equal(defectIn('Отличное состояние, не заблокирован'), null);
  assert.equal(defectIn(null), null);
  assert.equal(defectIn(undefined), null);
});

test('flagAds: (guard) title words are not body words', () => {
  const [a] = flagAds([mkAd(1, 100, { body: 'iCloud чистый, куплю чехол в подарок' })], NOW);
  assert.ok(!a.flags.includes('suspect_text'));
});

test('flagAds: (guard) a null body gives no suspect_text, a suspect title stays suspect_title', () => {
  assert.ok(!flagAds([mkAd(1, 100, { body: null })], NOW)[0].flags.includes('suspect_text'));
  assert.deepEqual(flagAds([mkAd(1, 100, { title: 'Куплю запчасти', body: null })], NOW)[0].flags, ['suspect_title']);
});

test('search: an answer without an array ads is BAD_RESPONSE', async () => {
  for (const answer of [{}, { ads: null, total: 3 }, { ads: {} }, null]) {
    await rejectsCode(search(fakeTransport(() => answer), { cat: '1' }, { now: () => NOW }), 'BAD_RESPONSE');
  }
});

test('search: (guard) the live shape of an empty result', async () => {
  const tr = fakeTransport(() => ({ ads: [], total: 0, pagination: null, page_type: 'search_page' }));
  const r = await search(tr, { cat: '1' }, { now: () => NOW });
  assert.equal(r.total, 0);
  assert.deepEqual(r.ads, []);
  assert.equal(r.next_cursor, null);
});

test('defectIn: the piece is cut at whole words', () => {
  const text = 'Продам айфон 13 акб 79 не менялся фейс рабочий трутон тоже бит экран и задняя крышка коробка родная отдам чехлы и зарядку';
  const piece = defectIn(text);
  assert.ok(piece.includes('бит экран'), piece);
  assert.ok(` ${text} `.includes(` ${piece} `), piece);
  assert.ok(piece.length < text.length);
  assert.equal(defectIn('разбит'), 'разбит');
});

// on_order: a car that is not in the country yet
test('flagAds: a car to order carries on_order, a car in stock and other goods do not', () => {
  const order = { cars_availability: { label: 'Под заказ', value: '1', text: 'Да', filter: 'cav' } };
  const stock = { cars_availability: { label: 'Под заказ', value: '0', text: '-', filter: 'cav' } };
  const [a, b, c] = flagAds([mkAd(1, 100, { params: order }), mkAd(2, 100, { params: stock }), mkAd(3, 100)], NOW);
  assert.ok(a.flags.includes('on_order'));
  assert.ok(!b.flags.includes('on_order'));
  assert.ok(!c.flags.includes('on_order'));
});

// ---- rent ----

test('flagAds: a rental is not_sell in a search for sales and carries no such flag when rent was asked for', () => {
  const let1 = mkAd(1, 100, { type: 'let' });
  assert.ok(flagAds([let1], NOW)[0].flags.includes('not_sell'));
  assert.deepEqual(flagAds([let1], NOW, null, 'let')[0].flags, []);
  assert.ok(flagAds([mkAd(2, 100)], NOW, null, 'let')[0].flags.includes('not_sell'));
});

test('search: with --param typ=let the rentals come without not_sell', async () => {
  const tr = fakeTransport(() => ({ ads: [rawAd({ id: 1, type: 'let' })], total: 1 }));
  const r = await search(tr, { cat: '1010', params: { typ: 'let' } }, { now: () => NOW });
  assert.equal(r.ads[0].type, 'let');
  assert.ok(!r.ads[0].flags.includes('not_sell'));
});

// ---- defects: denial before any phrase, more of the forms sellers use ----

test('defectIn: a denied phrase is not a defect, whatever the phrase', () => {
  for (const t of ['Телефон не на запчасти, рабочий', 'Не требует ремонта', 'Машина не после ДТП', 'Оплата по частям', 'Звонить в нерабочее время', 'Windows 64\u2011бит']) {
    assert.equal(defectIn(t), null, t);
  }
});

test('defectIn: «вздулась», «треснул», «под замену» are defects', () => {
  for (const t of ['АКБ вздулась', 'Экран треснул', 'Стекло трескнуло', 'Экран под замену']) assert.ok(defectIn(t), t);
});

test('defectIn: with no space after the word the word is kept whole', () => {
  assert.ok(defectIn(`Разбита${'x'.repeat(60)}`).startsWith('Разбита'));
});
