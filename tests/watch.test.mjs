import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KufarError } from '../scripts/lib/errors.mjs';
import {
  diffSeen, watchAdd, watchCheck, watchList, watchRemove,
  trackAdd, trackCheck, trackList, trackRemove,
} from '../scripts/lib/watch.mjs';
import {
  tmpDir, rejectsCode, rawAdOf, series, fakeTransport, itemIdOf, pageOf, SEARCH_PATH,
} from './helpers.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const readFile = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));

test('diffSeen: fresh, price_changed, new seen', () => {
  const seen = [['a', 100], ['b', null], ['c', 7]];
  const ads = [{ id: 'a', price_byn: 90 }, { id: 'b', price_byn: null }, { id: 'c', price_byn: 7 }, { id: 'd', price_byn: 5 }];
  const r = diffSeen(seen, ads);
  assert.deepEqual(r.fresh, [ads[3]]);
  assert.deepEqual(r.price_changed, [{ ad: ads[0], old_price: 100 }]);
  assert.deepEqual(r.seen, [['a', 90], ['b', null], ['c', 7], ['d', 5]]);
  assert.notEqual(r.seen, seen);
});

test('diffSeen: null to a price counts as a change', () => {
  const r = diffSeen([['a', null]], [{ id: 'a', price_byn: 50 }]);
  assert.deepEqual(r.price_changed, [{ ad: { id: 'a', price_byn: 50 }, old_price: null }]);
});

test('diffSeen: arrived ids move to the end in ads order, others keep order', () => {
  const seen = [['x', 1], ['y', 2], ['z', 3]];
  const r = diffSeen(seen, [{ id: 'y', price_byn: 2 }, { id: 'w', price_byn: 9 }, { id: 'x', price_byn: 5 }]);
  assert.deepEqual(r.seen, [['z', 3], ['y', 2], ['w', 9], ['x', 5]]);
});

test('diffSeen: numeric-like ids keep insertion order, not numeric order', () => {
  const seen = [['1000000001', 1], ['900', 2]];
  const r = diffSeen(seen, [{ id: '5', price_byn: 3 }, { id: '1000000001', price_byn: 1 }]);
  assert.deepEqual(r.seen, [['900', 2], ['5', 3], ['1000000001', 1]]);
});

test('diffSeen: keeps at most 3000, dropping the earliest', () => {
  const seen = [];
  for (let i = 0; i < 3000; i++) seen.push([`k${i}`, i]);
  const r = diffSeen(seen, [{ id: 'n1', price_byn: 1 }, { id: 'n2', price_byn: 2 }]);
  assert.equal(r.seen.length, 3000);
  assert.deepEqual(r.seen.slice(0, 2), [['k2', 2], ['k3', 3]]);
  assert.deepEqual(r.seen.slice(-2), [['n1', 1], ['n2', 2]]);
});

test('diffSeen: on overflow a previously seen, re-arrived id stays', () => {
  const seen = [];
  for (let i = 0; i < 3000; i++) seen.push([`k${i}`, i]);
  const r = diffSeen(seen, [{ id: 'k0', price_byn: 0 }, { id: 'n1', price_byn: 1 }]);
  assert.equal(r.seen.length, 3000);
  assert.ok(r.seen.some(([id]) => id === 'k0'));
  assert.ok(!r.seen.some(([id]) => id === 'k1'));
  assert.deepEqual(r.seen.slice(-2), [['k0', 0], ['n1', 1]]);
});

async function ctxWith(ads) {
  const stateDir = await tmpDir();
  const state = { ads };
  const transport = fakeTransport((p) => {
    if (p === SEARCH_PATH) return pageOf(state.ads);
    throw new Error(`unexpected ${p}`);
  });
  return { ctx: { transport, stateDir, now: () => NOW }, state, transport, stateDir };
}

test('watchAdd rejects bad names', async () => {
  const { ctx } = await ctxWith([]);
  for (const n of ['', 'Bad Name', 'UPPER', '-x', 'a'.repeat(41)]) {
    await rejectsCode(watchAdd(ctx, n, { cat: '1' }), 'BAD_ARGS');
  }
});

test('watchAdd records baseline and file', async () => {
  const { ctx, transport, stateDir } = await ctxWith(series(1000000001, [500, 600]));
  const r = await watchAdd(ctx, 'phones-1', { cat: '17010' });
  assert.deepEqual(r, { name: 'phones-1', baseline: 2, total: 2 });
  assert.equal(transport.calls[0].query.sort, 'lst.d');
  assert.equal(transport.calls[0].query.size, '200');
  assert.equal(transport.calls[0].query.cat, '17010');
  const w = await readFile(stateDir, 'watches/phones-1.json');
  assert.equal(w.name, 'phones-1');
  assert.deepEqual(w.opts, { cat: '17010' });
  assert.deepEqual(w.seen, [['1000000001', 500], ['1000000002', 600]]);
  assert.equal(w.created_at, new Date(NOW).toISOString());
  assert.equal(w.checked_at, new Date(NOW).toISOString());
});

test('watchAdd stores opts as passed, without sort and limit', async () => {
  const { ctx, stateDir } = await ctxWith([]);
  await watchAdd(ctx, 'w', { cat: '1', params: { phm: '5380' }, priceMax: 700 });
  const w = await readFile(stateDir, 'watches/w.json');
  assert.deepEqual(w.opts, { cat: '1', params: { phm: '5380' }, priceMax: 700 });
});

test('watchAdd twice is WATCH_EXISTS', async () => {
  const { ctx } = await ctxWith([]);
  await watchAdd(ctx, 'w', { cat: '1' });
  await rejectsCode(watchAdd(ctx, 'w', { cat: '1' }), 'WATCH_EXISTS');
});

test('watchCheck reports new and price-changed ads, then nothing', async () => {
  const { ctx, state } = await ctxWith(series(1000000001, [500, 600]));
  await watchAdd(ctx, 'w', { cat: '17010' });
  state.ads = [rawAdOf({ id: 1000000001, price: 450 }), rawAdOf({ id: 1000000002, price: 600 }), rawAdOf({ id: 1000000003, price: 700 })];
  const r = await watchCheck(ctx, 'w');
  assert.equal(r.name, 'w');
  assert.deepEqual(r.new.map((a) => a.id), ['1000000003']);
  assert.equal('seller_key' in r.new[0], false);
  assert.deepEqual(r.new[0].flags, []);
  assert.deepEqual(r.price_changed, [{
    id: '1000000001', title: 'Телефон 1000000001', url: 'https://www.kufar.by/item/1000000001', old_price: 500, price_byn: 450,
  }]);
  assert.equal(typeof r.checked_at, 'string');
  const again = await watchCheck(ctx, 'w');
  assert.deepEqual(again.new, []);
  assert.deepEqual(again.price_changed, []);
});

test('watchCheck unknown name', async () => {
  const { ctx } = await ctxWith([]);
  await rejectsCode(watchCheck(ctx, 'nope'), 'UNKNOWN_WATCH');
});

test('watchList sorts by name, one file per watch; watchRemove deletes the file', async () => {
  const { ctx, stateDir } = await ctxWith(series(1000000001, [500, 600]));
  await watchAdd(ctx, 'b', { cat: '2' });
  await watchAdd(ctx, 'a', { cat: '1' });
  assert.deepEqual((await watchList(ctx)).watches.map((w) => w.name), ['a', 'b']);
  assert.deepEqual((await fs.readdir(path.join(stateDir, 'watches'))).sort(), ['a.json', 'b.json']);
  await watchRemove(ctx, 'a');
  assert.deepEqual(await fs.readdir(path.join(stateDir, 'watches')), ['b.json']);
  await watchRemove(ctx, 'b');
});

test('watchList and watchRemove', async () => {
  const { ctx } = await ctxWith(series(1000000001, [500]));
  assert.deepEqual(await watchList(ctx), { watches: [] });
  await watchAdd(ctx, 'w', { cat: '17010' });
  const { watches } = await watchList(ctx);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].name, 'w');
  assert.equal(watches[0].seen, 1);
  assert.equal(watches[0].opts.cat, '17010');
  assert.equal(watches[0].created_at, new Date(NOW).toISOString());
  assert.ok('checked_at' in watches[0]);
  assert.deepEqual(await watchRemove(ctx, 'w'), { removed: 'w' });
  assert.deepEqual(await watchList(ctx), { watches: [] });
  await rejectsCode(watchRemove(ctx, 'w'), 'UNKNOWN_WATCH');
});

// card-based transport: cards[id] is a raw ad, an Error to throw, or missing
async function trackCtx(cards = {}) {
  const stateDir = await tmpDir();
  const transport = fakeTransport((p) => {
    const id = itemIdOf(p);
    const c = cards[id] ?? rawAdOf({ id, price: 620 });
    if (c instanceof Error) throw c;
    return { result: c };
  });
  return { ctx: { transport, stateDir, now: () => NOW }, cards, transport, stateDir };
}
const itemCalls = (tr) => tr.calls.filter((c) => itemIdOf(c.path));

test('trackAdd stores the entry', async () => {
  const { ctx, stateDir } = await trackCtx();
  const r = await trackAdd(ctx, 'https://www.kufar.by/item/1000000001', 'моя заметка');
  assert.deepEqual(r, { id: '1000000001', title: 'Телефон 1000000001', price_byn: 620, note: 'моя заметка' });
  const e = (await readFile(stateDir, 'tracked.json'))['1000000001'];
  assert.equal(e.title, 'Телефон 1000000001');
  assert.equal(e.url, 'https://www.kufar.by/item/1000000001');
  assert.equal(e.note, 'моя заметка');
  assert.equal(e.gone_at, null);
  assert.equal(e.history.length, 1);
  assert.equal(e.history[0].price_byn, 620);
});

test('trackAdd again updates the note', async () => {
  const { ctx } = await trackCtx();
  await trackAdd(ctx, '1000000001', 'one');
  await trackAdd(ctx, '1000000001', 'two');
  const { tracked } = await trackList(ctx);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].note, 'two');
});

test('trackAdd again keeps history and added_at', async () => {
  const { ctx, cards } = await trackCtx();
  await trackAdd(ctx, '1000000001', 'one');
  cards['1000000001'] = rawAdOf({ id: 1000000001, price: 500 });
  await trackCheck(ctx);
  const later = { ...ctx, now: () => NOW + 86_400_000 };
  await trackAdd(later, '1000000001', 'two');
  const { tracked } = await trackList(ctx);
  assert.equal(tracked[0].added_at, new Date(NOW).toISOString());
  assert.equal(tracked[0].history.length, 2);
  assert.equal(tracked[0].note, 'two');
});

test('trackAdd again at the limit is not TRACK_LIMIT', async () => {
  const { ctx } = await trackCtx();
  for (let i = 0; i < 30; i++) await trackAdd(ctx, String(1000000001 + i), '');
  const r = await trackAdd(ctx, '1000000001', 'again');
  assert.equal(r.note, 'again');
});

test('trackAdd 31st entry is TRACK_LIMIT', async () => {
  const { ctx } = await trackCtx();
  for (let i = 0; i < 30; i++) await trackAdd(ctx, String(1000000001 + i), '');
  await rejectsCode(trackAdd(ctx, '1000000099', ''), 'TRACK_LIMIT');
});

test('trackCheck records a price change', async () => {
  const { ctx, cards, stateDir } = await trackCtx();
  await trackAdd(ctx, '1000000001', '');
  cards['1000000001'] = rawAdOf({ id: 1000000001, price: 500 });
  const r = await trackCheck(ctx);
  assert.equal(r.checked, 1);
  assert.deepEqual(r.changes, [{
    id: '1000000001', title: 'Телефон 1000000001', url: 'https://www.kufar.by/item/1000000001',
    change: 'price', old_price: 620, price_byn: 500,
  }]);
  assert.equal((await readFile(stateDir, 'tracked.json'))['1000000001'].history.length, 2);
  assert.deepEqual((await trackCheck(ctx)).changes, []);
});

test('trackCheck marks gone ads and stops asking for them', async () => {
  const { ctx, cards, transport } = await trackCtx();
  await trackAdd(ctx, '1000000001', '');
  cards['1000000001'] = new KufarError('NOT_FOUND', 'gone');
  const r = await trackCheck(ctx);
  assert.deepEqual(r.changes, [{
    id: '1000000001', title: 'Телефон 1000000001', url: 'https://www.kufar.by/item/1000000001', change: 'gone',
  }]);
  const { tracked } = await trackList(ctx);
  assert.notEqual(tracked[0].gone_at, null);
  const before = itemCalls(transport).length;
  const again = await trackCheck(ctx);
  assert.equal(itemCalls(transport).length, before);
  assert.equal(again.checked, 0);
});

test('trackCheck.checked counts only requested cards', async () => {
  const { ctx, cards } = await trackCtx();
  await trackAdd(ctx, '1000000001', '');
  await trackAdd(ctx, '1000000002', '');
  cards['1000000001'] = new KufarError('NOT_FOUND', 'gone');
  assert.equal((await trackCheck(ctx)).checked, 2);
  assert.equal((await trackCheck(ctx)).checked, 1);
});

test('trackCheck rethrows other errors', async () => {
  const { ctx, cards } = await trackCtx();
  await trackAdd(ctx, '1000000001', '');
  cards['1000000001'] = new KufarError('NETWORK', 'down');
  await rejectsCode(trackCheck(ctx), 'NETWORK');
});

test('trackList shape and trackRemove', async () => {
  const { ctx } = await trackCtx();
  assert.deepEqual(await trackList(ctx), { tracked: [] });
  await trackAdd(ctx, '1000000001', 'n');
  const { tracked } = await trackList(ctx);
  assert.deepEqual(Object.keys(tracked[0]).sort(), ['added_at', 'gone_at', 'history', 'id', 'note', 'price_byn', 'title', 'url']);
  assert.equal(tracked[0].price_byn, 620);
  assert.deepEqual(await trackRemove(ctx, '1000000001'), { removed: '1000000001' });
  await rejectsCode(trackRemove(ctx, '1000000001'), 'NOT_TRACKED');
});
