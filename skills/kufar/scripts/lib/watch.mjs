import fs from 'node:fs/promises';
import path from 'node:path';
import { KufarError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';
import { parseAdRef, fetchAd } from './ads.mjs';
import { search } from './search.mjs';

const MAX_SEEN = 3000;
const MAX_TRACKED = 30;

export function diffSeen(seen, ads) {
  const old = new Map(seen);
  const fresh = [];
  const price_changed = [];
  const arrived = new Map();
  for (const ad of ads) {
    if (!old.has(ad.id)) fresh.push(ad);
    else if (old.get(ad.id) !== ad.price_byn) price_changed.push({ ad, old_price: old.get(ad.id) });
    arrived.set(ad.id, ad.price_byn);
  }
  const next = [...seen.filter(([id]) => !arrived.has(id)), ...arrived];
  return { fresh, price_changed, seen: next.slice(-MAX_SEEN) };
}

const iso = (ctx) => new Date((ctx.now ?? Date.now)()).toISOString();
const watchesDir = (ctx) => path.join(ctx.stateDir, 'watches');

function watchFile(ctx, name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(String(name))) {
    throw new KufarError('BAD_ARGS', 'Имя слежения: латиница в нижнем регистре, цифры, - и _, до 40 знаков', { name });
  }
  return path.join(watchesDir(ctx), `${name}.json`);
}

const watchSearch = (ctx, opts) => search(ctx.transport, { ...opts, sort: 'new', limit: 200 }, { now: ctx.now, clock: ctx.clock ?? null });

export async function watchAdd(ctx, name, opts) {
  const file = watchFile(ctx, name);
  if (await readJson(file, null)) throw new KufarError('WATCH_EXISTS', `Слежение ${name} уже есть`, { name });
  const { sort, limit, ...stored } = opts;
  const r = await watchSearch(ctx, stored);
  const at = iso(ctx);
  await writeJsonAtomic(file, { name, opts: stored, seen: diffSeen([], r.ads).seen, created_at: at, checked_at: at });
  return { name, baseline: r.ads.length, total: r.total };
}

export async function watchCheck(ctx, name) {
  const file = watchFile(ctx, name);
  const w = await readJson(file, null);
  if (!w) throw new KufarError('UNKNOWN_WATCH', `Нет слежения ${name}`, { name });
  const r = await watchSearch(ctx, w.opts);
  const d = diffSeen(w.seen, r.ads);
  const checked_at = iso(ctx);
  await writeJsonAtomic(file, { ...w, seen: d.seen, checked_at });
  return {
    name,
    new: d.fresh.map(({ seller_key, ...ad }) => ad),
    price_changed: d.price_changed.map(({ ad, old_price }) => ({ id: ad.id, title: ad.title, url: ad.url, old_price, price_byn: ad.price_byn })),
    checked_at,
  };
}

export async function watchList(ctx) {
  let files;
  try {
    files = await fs.readdir(watchesDir(ctx));
  } catch (e) {
    if (e.code === 'ENOENT') return { watches: [] };
    throw e;
  }
  const watches = [];
  for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
    const w = await readJson(path.join(watchesDir(ctx), f), null);
    if (w) watches.push({ name: w.name, opts: w.opts, seen: w.seen.length, created_at: w.created_at, checked_at: w.checked_at });
  }
  return { watches };
}

export async function watchRemove(ctx, name) {
  try {
    await fs.unlink(watchFile(ctx, name));
  } catch (e) {
    if (e.code === 'ENOENT') throw new KufarError('UNKNOWN_WATCH', `Нет слежения ${name}`, { name });
    throw e;
  }
  return { removed: name };
}

const trackedFile = (ctx) => path.join(ctx.stateDir, 'tracked.json');
const lastPrice = (e) => e.history.at(-1)?.price_byn ?? null;

export async function trackAdd(ctx, ref, note) {
  const id = parseAdRef(ref);
  const list = await readJson(trackedFile(ctx), {});
  if (list[id]) {
    list[id].note = note ?? null;
    await writeJsonAtomic(trackedFile(ctx), list);
    return { id, title: list[id].title, price_byn: lastPrice(list[id]), note: list[id].note };
  }
  if (Object.keys(list).length >= MAX_TRACKED) {
    throw new KufarError('TRACK_LIMIT', `В списке наблюдения уже ${MAX_TRACKED} объявлений, удалите лишние`, { limit: MAX_TRACKED });
  }
  const ad = await fetchAd(ctx.transport, id);
  const at = iso(ctx);
  list[id] = { title: ad.title, url: ad.url, note: note ?? null, added_at: at, history: [{ at, price_byn: ad.price_byn }], gone_at: null };
  await writeJsonAtomic(trackedFile(ctx), list);
  return { id, title: ad.title, price_byn: ad.price_byn, note: list[id].note };
}

export async function trackCheck(ctx) {
  const list = await readJson(trackedFile(ctx), {});
  const changes = [];
  let checked = 0;
  for (const [id, e] of Object.entries(list)) {
    checked++;
    let ad;
    try {
      ad = await fetchAd(ctx.transport, id);
    } catch (err) {
      // a listing already marked gone is asked only to see whether it came back: its failure must not stop the others
      if (err.code !== 'NOT_FOUND' && e.gone_at) continue;
      if (err.code !== 'NOT_FOUND') throw err;
      // reported once; asked again on every check, since a seller may put the listing back
      if (!e.gone_at) {
        e.gone_at = iso(ctx);
        changes.push({ id, title: e.title, url: e.url, change: 'gone' });
      }
      continue;
    }
    const back = Boolean(e.gone_at);
    e.gone_at = null;
    const old_price = lastPrice(e);
    if (ad.price_byn !== old_price) e.history.push({ at: iso(ctx), price_byn: ad.price_byn });
    if (back || ad.price_byn !== old_price) {
      changes.push({ id, title: e.title, url: e.url, change: back ? 'back' : 'price', old_price, price_byn: ad.price_byn });
    }
  }
  await writeJsonAtomic(trackedFile(ctx), list);
  return { checked, changes };
}

export async function trackList(ctx) {
  const list = await readJson(trackedFile(ctx), {});
  return {
    tracked: Object.entries(list).map(([id, e]) => ({
      id, title: e.title, url: e.url, note: e.note, added_at: e.added_at, price_byn: lastPrice(e), history: e.history, gone_at: e.gone_at,
    })),
  };
}

export async function trackRemove(ctx, ref) {
  const id = parseAdRef(ref);
  const list = await readJson(trackedFile(ctx), {});
  if (!list[id]) throw new KufarError('NOT_TRACKED', `Объявления ${id} нет в списке наблюдения`, { id });
  delete list[id];
  await writeJsonAtomic(trackedFile(ctx), list);
  return { removed: id };
}
