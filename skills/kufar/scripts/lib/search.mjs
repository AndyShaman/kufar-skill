import { KufarError } from './errors.mjs';
import { normalizeAd } from './ads.mjs';
import { ageByClock } from './clock.mjs';

const SORTS = { new: 'lst.d', old: 'lst.a', cheap: 'prc.a', expensive: 'prc.d' };
const RESERVED = new Set(['cat', 'query', 'lang', 'sort', 'size', 'cursor', 'prc', 'rgn']);
const MAX_KOPECKS = 2000000000;
const SUSPECT_WORDS = ['запчаст', 'на разбор', 'на детали', 'по частям', 'куплю', 'заблокирован', 'залочен', 'локнут', 'icloud', 'не включается',
  'нерабоч', 'донор', 'под восстановление'];
// the text of a card is longer than a title: «icloud чистый» and «куплю» in it say nothing, a defect does.
// A defect the text denies («не заблокирован», «без трещин», «трещин нет») is not one; neither are spare parts that come with the thing
const DENIED = '(?<!(?:^|[^а-яё])(?:не|ни|без|нет)\\s+)';
const DEFECT_TEXT = new RegExp([
  '(?:на|под|по)\\s+запчаст', 'по\\s+частям', '(?:на|под)\\s+разбор', 'на\\s+детали', '(?:на|под)\\s+восстановлени', '(?:под|нужен)\\s+ремонт',
  'донор', 'нерабоч', 'забыт\\s+пароль', 'пароль[^.!?]{0,40}неизвест',
  'требу[ею]т(?:ся)?\\s+ремонт', 'не\\s+включается', 'не\\s+работа[ею]т', 'не\\s+реагиру[ею]т', 'не\\s+заводится', 'не\\s+на\\s+ходу',
  'после\\s+дтп', `(?<![а-яё])${DENIED}(?:заблокирован|залочен|локнут|разбит|сломан|тресну|трещин|поврежд|вздут|неисправ|(?<!\\d[\\s-]?)бит(?:ый|ая|ое|ые|а|о|ы)?(?![а-яё]))(?![а-яё]*\\s+нет(?![а-яё]))`,
].join('|'), 'i');

// the piece of a card's text that names a defect, or null
export function defectIn(body) {
  const m = typeof body === 'string' ? DEFECT_TEXT.exec(body) : null;
  if (!m) return null;
  // about 30 characters on each side, cut at whole words
  let from = Math.max(0, m.index - 30);
  let to = Math.min(body.length, m.index + m[0].length + 30);
  if (from > 0) from += body.slice(from, m.index).search(/\s/) + 1;
  if (to < body.length) to = m.index + m[0].length + Math.max(0, body.slice(m.index + m[0].length, to).search(/\s\S*$/));
  return body.slice(from, to).replace(/\s+/g, ' ').trim();
}

const bad = (message, details) => new KufarError('BAD_ARGS', message, details);

export function buildSearchQuery(opts) {
  const { cat, query, params = {}, regions, priceMin, priceMax, condition, seller, delivery, sort = 'new', limit = 30, cursor } = opts;
  if (!cat && !query) throw bad('Нужна рубрика (--cat) или слова (--query)');
  if (!(sort in SORTS)) throw bad('sort: new, old, cheap или expensive', { sort });
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

export const STALE_DAYS = 30;
export const BUMP_GAP_DAYS = 7;

export function ageDays(listedAt, now) {
  const t = listedAt ? Date.parse(listedAt) : NaN;
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86400000));
}

export async function search(transport, opts, { now = Date.now, clock = null } = {}) {
  const query = buildSearchQuery(opts);
  const raw = await transport.getJson('/search-api/v2/search/rendered-paginated', query);
  // an empty result is a list too: without one the answer is not a search result
  if (!Array.isArray(raw?.ads)) throw new KufarError('BAD_RESPONSE', 'В ответе Куфара нет списка объявлений');
  const pages = raw.pagination?.pages ?? [];
  return {
    total: raw.total ?? 0,
    ads: flagAds(raw.ads.map(normalizeAd), now(), clock),
    next_cursor: pages.find((p) => p.label === 'next')?.token || null,
    pages: pages.filter((p) => p.token).map((p) => ({ num: p.num, cursor: p.token })),
  };
}

export function flagAds(ads, now = Date.now(), clock = null) {
  const seen = new Set();
  return ads.map((ad) => {
    const flags = [];
    if (ad.price_byn === null) flags.push('no_price');
    if (ad.type !== 'sell') flags.push('not_sell');
    const title = String(ad.title ?? '').toLowerCase();
    if (SUSPECT_WORDS.some((w) => title.includes(w))) flags.push('suspect_title');
    // only a card carries its text; a search result does not
    if (defectIn(ad.body)) flags.push('suspect_text');
    if (ad.seller_key) {
      const key = `${ad.seller_key}\u0000${title.trim()}\u0000${ad.price_byn}`;
      if (seen.has(key)) flags.push('duplicate');
      seen.add(key);
    }
    const days = ageDays(ad.listed_at, now);
    const age_days = ageByClock(clock, ad.id, days, now);
    if (ad.company !== true) {
      if (age_days !== null && age_days >= STALE_DAYS) flags.push('stale');
      if (age_days !== null && days !== null && days < BUMP_GAP_DAYS && age_days - days >= BUMP_GAP_DAYS) flags.push('bumped');
    }
    return { ...ad, flags, days, age_days };
  });
}
