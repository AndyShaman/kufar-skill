import path from 'node:path';
import { parseArgs } from 'node:util';
import { KufarError } from './lib/errors.mjs';
import { resolveStateDir, cached } from './lib/storage.mjs';
import { createTransport } from './lib/transport.mjs';
import { fetchAd } from './lib/ads.mjs';
import { findCategories, parentOf, listParams, findParamValues } from './lib/taxonomy.mjs';
import { search, flagAds } from './lib/search.mjs';
import { estimatePrice } from './lib/price.mjs';
import {
  watchAdd, watchCheck, watchList, watchRemove, trackAdd, trackCheck, trackList, trackRemove,
} from './lib/watch.mjs';

const DAY = 24 * 60 * 60 * 1000;
const bad = (message, details) => new KufarError('BAD_ARGS', message, details);

const FILTER_OPTIONS = {
  cat: { type: 'string' },
  query: { type: 'string' },
  param: { type: 'string', multiple: true },
  region: { type: 'string', multiple: true },
  'price-min': { type: 'string' },
  'price-max': { type: 'string' },
  condition: { type: 'string' },
  seller: { type: 'string' },
  delivery: { type: 'boolean' },
};
const SEARCH_OPTIONS = { ...FILTER_OPTIONS, sort: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } };
const PRICE_OPTIONS = {
  cat: { type: 'string' },
  query: { type: 'string' },
  param: { type: 'string', multiple: true },
  region: { type: 'string', multiple: true },
  like: { type: 'string' },
  by: { type: 'string' },
  exclude: { type: 'string' },
  include: { type: 'string' },
};

function parse(args, options, positionals = 0) {
  let r;
  try {
    r = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw bad(`Неверные аргументы: ${e.message}`);
  }
  if (r.positionals.length !== positionals) {
    throw bad(positionals ? `Нужен ровно один аргумент без опции` : `Лишние аргументы: ${r.positionals.join(' ')}`);
  }
  return { values: r.values, arg: r.positionals[0] };
}

function num(v, flag) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n)) throw bad(`${flag} должно быть числом`, { [flag]: v });
  return n;
}

function parseParams(list) {
  if (!list) return undefined;
  const params = {};
  for (const item of list) {
    const i = item.indexOf('=');
    if (i === -1) throw bad('--param пишется как код=значение', { param: item });
    params[item.slice(0, i)] = item.slice(i + 1);
  }
  return params;
}

const csv = (v) => (v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean));

function filterOpts(v) {
  return {
    cat: v.cat,
    query: v.query,
    params: parseParams(v.param),
    regions: v.region,
    priceMin: num(v['price-min'], '--price-min'),
    priceMax: num(v['price-max'], '--price-max'),
    condition: v.condition,
    seller: v.seller,
    delivery: v.delivery,
  };
}

function getCtx() {
  const stateDir = resolveStateDir();
  return { stateDir, transport: createTransport({ stateDir }), now: Date.now };
}

const categoryTree = (ctx) => cached(path.join(ctx.stateDir, 'cache', 'category-tree.json'), DAY,
  () => ctx.transport.getJson('/category-tree/v1/category_tree'));

async function run(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'categories': {
      const { values } = parse(rest, { find: { type: 'string' } });
      return { categories: findCategories(await categoryTree(getCtx()), values.find) };
    }
    case 'params': {
      const { values } = parse(rest, { cat: { type: 'string' }, find: { type: 'string' } });
      // cat also names the cache file, so only digits
      if (!/^\d+$/.test(values.cat ?? '')) throw bad('Нужна рубрика: --cat <номер>');
      const ctx = getCtx();
      const cat = values.cat;
      const parent = parentOf(await categoryTree(ctx), cat) ?? cat;
      const taxonomy = await cached(path.join(ctx.stateDir, 'cache', `taxonomy-${cat}.json`), DAY,
        () => ctx.transport.getJson('/taxonomy-proxy/v1/dispatch', {
          routing: 'web_generalist', parent, category: cat, application: 'ad_listing', platform: 'web',
        }));
      return values.find === undefined
        ? { cat, params: listParams(taxonomy.metadata) }
        : { cat, values: findParamValues(taxonomy.metadata, values.find) };
    }
    case 'search': {
      const { values } = parse(rest, SEARCH_OPTIONS);
      const opts = { ...filterOpts(values), sort: values.sort, limit: num(values.limit, '--limit'), cursor: values.cursor };
      const r = await search(getCtx().transport, opts);
      return { total: r.total, count: r.ads.length, ads: r.ads, next_cursor: r.next_cursor };
    }
    case 'item': {
      const { arg } = parse(rest, {}, 1);
      const ad = await fetchAd(getCtx().transport, arg);
      return { ad: flagAds([ad])[0] };
    }
    case 'price': {
      const { values: v } = parse(rest, PRICE_OPTIONS);
      return estimatePrice(getCtx().transport, {
        cat: v.cat, params: parseParams(v.param), query: v.query, regions: v.region,
        exclude: csv(v.exclude), include: csv(v.include), like: v.like, by: csv(v.by),
      });
    }
    case 'watch': {
      const [sub, ...args] = rest;
      if (sub === 'add') {
        const { values, arg } = parse(args, FILTER_OPTIONS, 1);
        return watchAdd(getCtx(), arg, filterOpts(values));
      }
      if (sub === 'check') return watchCheck(getCtx(), parse(args, {}, 1).arg);
      if (sub === 'list') { parse(args, {}); return watchList(getCtx()); }
      if (sub === 'remove') return watchRemove(getCtx(), parse(args, {}, 1).arg);
      throw bad('watch: add, check, list или remove', { sub });
    }
    case 'track': {
      const [sub, ...args] = rest;
      if (sub === 'add') {
        const { values, arg } = parse(args, { note: { type: 'string' } }, 1);
        return trackAdd(getCtx(), arg, values.note);
      }
      if (sub === 'check') { parse(args, {}); return trackCheck(getCtx()); }
      if (sub === 'list') { parse(args, {}); return trackList(getCtx()); }
      if (sub === 'remove') return trackRemove(getCtx(), parse(args, {}, 1).arg);
      throw bad('track: add, check, list или remove', { sub });
    }
    default:
      throw bad('Команды: categories, params, search, item, price, watch, track', { command: cmd ?? null });
  }
}

const print = (obj) => process.stdout.write(`${JSON.stringify(obj, (k, v) => (k === 'seller_key' ? undefined : v), 2)}\n`);

try {
  print(await run(process.argv.slice(2)));
} catch (e) {
  print({ error: e instanceof KufarError
    ? { code: e.code, message: e.message, details: e.details }
    : { code: 'INTERNAL', message: String(e?.message ?? e) } });
  process.exitCode = 1;
}
