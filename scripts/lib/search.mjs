import { KufarError } from './errors.mjs';
import { normalizeAd } from './ads.mjs';

const SORTS = { new: 'lst.d', cheap: 'prc.a', expensive: 'prc.d' };
const RESERVED = new Set(['cat', 'query', 'lang', 'sort', 'size', 'cursor', 'prc', 'rgn']);
const MAX_KOPECKS = 2000000000;
const SUSPECT_WORDS = ['запчаст', 'на разбор', 'на детали', 'куплю', 'заблокирован', 'icloud', 'не включается', 'под восстановление'];

const bad = (message, details) => new KufarError('BAD_ARGS', message, details);

export function buildSearchQuery(opts) {
  const { cat, query, params = {}, regions, priceMin, priceMax, condition, seller, delivery, sort = 'new', limit = 30, cursor } = opts;
  if (!cat && !query) throw bad('Нужна рубрика (--cat) или слова (--query)');
  if (!(sort in SORTS)) throw bad('sort: new, cheap или expensive', { sort });
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit: целое от 1 до 200', { limit });

  const q = {};
  if (cat) q.cat = String(cat);
  if (query) q.query = String(query);
  for (const [k, v] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(k) || RESERVED.has(k)) throw bad(`Недопустимый код характеристики: ${k}`, { param: k });
    q[k] = String(v);
  }
  const option = (code, value, flag) => {
    if (code in params) throw bad(`${flag} и --param ${code}= задают одно и то же`, { param: code });
    q[code] = value;
  };
  if (condition !== undefined) {
    if (condition !== 'used' && condition !== 'new') throw bad('condition: used или new', { condition });
    option('cnd', condition === 'used' ? '1' : '2', '--condition');
  }
  if (seller !== undefined) {
    if (seller !== 'private' && seller !== 'company') throw bad('seller: private или company', { seller });
    option('cmp', seller === 'private' ? '0' : '1', '--seller');
  }
  if (delivery === true) option('dle', '1', '--delivery');

  if (regions?.length) q.rgn = regions.length === 1 ? String(regions[0]) : `v.or:${regions.join(',')}`;
  if (priceMin !== undefined || priceMax !== undefined) {
    for (const v of [priceMin, priceMax]) {
      if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw bad('Цена должна быть неотрицательным числом', { priceMin, priceMax });
    }
    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
      throw bad('Нижняя граница цены больше верхней', { priceMin, priceMax });
    }
    const min = priceMin === undefined ? 0 : Math.round(priceMin * 100);
    const max = priceMax === undefined ? MAX_KOPECKS : Math.round(priceMax * 100);
    q.prc = `r:${min},${max}`;
  }
  if (cursor) q.cursor = String(cursor);
  q.lang = 'ru';
  q.sort = SORTS[sort];
  q.size = String(limit);
  return q;
}

export async function search(transport, opts) {
  const query = buildSearchQuery(opts);
  const raw = await transport.getJson('/search-api/v2/search/rendered-paginated', query);
  const pages = raw.pagination?.pages ?? [];
  return {
    total: raw.total ?? 0,
    ads: flagAds((raw.ads ?? []).map(normalizeAd)),
    next_cursor: pages.find((p) => p.label === 'next')?.token || null,
    pages: pages.filter((p) => p.token).map((p) => ({ num: p.num, cursor: p.token })),
  };
}

export function flagAds(ads) {
  const seen = new Set();
  return ads.map((ad) => {
    const flags = [];
    if (ad.price_byn === null) flags.push('no_price');
    if (ad.type !== 'sell') flags.push('not_sell');
    const title = String(ad.title ?? '').toLowerCase();
    if (SUSPECT_WORDS.some((w) => title.includes(w))) flags.push('suspect_title');
    if (ad.seller_key) {
      const key = `${ad.seller_key}\u0000${title.trim()}\u0000${ad.price_byn}`;
      if (seen.has(key)) flags.push('duplicate');
      seen.add(key);
    }
    return { ...ad, flags };
  });
}
