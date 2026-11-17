import { KufarError } from './errors.mjs';
import { fetchAd } from './ads.mjs';
import { search } from './search.mjs';
import { priceStats, cleanForPricing, reliability, position } from './stats.mjs';

const NOTE = 'Это цены объявлений, а не сделок.';

// a requested filter value contradicts the ad's value; ranges ("r:…") never do
function contradicts(wanted, value) {
  const w = String(wanted);
  if (w.startsWith('r:')) return false;
  if (w.startsWith('v.or:')) return !w.slice(5).split(',').includes(value);
  return w !== value;
}

const medianOf = (ads) => priceStats(ads.map((a) => a.price_byn)).median;

export async function estimatePrice(transport, { cat, params = {}, query, regions, exclude = [], include = [], like, by } = {}) {
  let subjectAd = null;
  if (like !== undefined) {
    subjectAd = await fetchAd(transport, like);
    cat = subjectAd.category;
    const available = Object.values(subjectAd.params).map(({ filter, label, text }) => ({ filter, label, text }));
    if (!by?.length && !query) {
      throw new KufarError('NEEDS_BY', 'Укажите --by: по каким характеристикам искать похожие (или --query)', { available });
    }
    params = {};
    for (const code of by ?? []) {
      const p = Object.values(subjectAd.params).find((x) => x.filter === code);
      if (!p) throw new KufarError('BAD_ARGS', `У объявления нет характеристики ${code}`, { by: code, available });
      params[code] = p.value;
    }
  }
  if (!cat) throw new KufarError('BAD_ARGS', 'Нужна рубрика (--cat) или объявление (--like)');
  const byWords = Object.keys(params).length === 0;
  if (byWords && !query) {
    throw new KufarError('BAD_ARGS', 'Нужны характеристики (--param) или слова (--query): цена по целой рубрике бессмысленна');
  }

  const base = byWords ? { cat, query, regions, sort: 'new', limit: 200 } : { cat, params, regions, sort: 'new', limit: 200 };
  const notSubject = (ads) => ads.filter((a) => a.id !== subjectAd?.id);

  const fresh = await search(transport, base);
  const freshAds = notSubject(fresh.ads);
  const pool = new Map(freshAds.map((a) => [a.id, a]));

  let oldIds = null;
  let oldCount = 0;
  const last = fresh.pages.filter((p) => p.num > 2).sort((a, b) => b.num - a.num)[0];
  if (fresh.total > 400 && last) {
    const old = notSubject((await search(transport, { ...base, cursor: last.cursor })).ads);
    oldIds = new Set(old.map((a) => a.id));
    for (const a of old) {
      if (pool.has(a.id)) continue;
      pool.set(a.id, a);
      oldCount++;
    }
  }

  const unclassified = [];
  if (!byWords && query) {
    const inc = new Set(include.map(String));
    const words = notSubject((await search(transport, { cat, query, regions, sort: 'new', limit: 200 })).ads);
    for (const ad of words) {
      if (pool.has(ad.id)) continue;
      const own = Object.values(ad.params);
      const valueOf = (code) => own.find((x) => x.filter === code)?.value;
      const codes = Object.keys(params);
      const missing = codes.some((c) => valueOf(c) === undefined);
      const conflict = codes.some((c) => valueOf(c) !== undefined && contradicts(params[c], valueOf(c)));
      if (!missing || conflict) continue;
      if (inc.has(ad.id)) pool.set(ad.id, ad);
      else unclassified.push({ id: ad.id, title: ad.title, price_byn: ad.price_byn, url: ad.url });
    }
  }

  const { kept, dropped } = cleanForPricing([...pool.values()], { exclude, include });
  const prices = (ads) => ads.map((a) => a.price_byn);
  const stats = {
    all: priceStats(prices(kept)),
    private: priceStats(prices(kept.filter((a) => a.company === false))),
    company: priceStats(prices(kept.filter((a) => a.company === true))),
  };
  const basis = stats.private.n >= 5 ? 'private' : 'all';
  const st = stats[basis];
  const rel = reliability(st);
  const round = st.median >= 20 ? Math.round : (x) => Math.round(x * 100) / 100;
  const freshIds = new Set(freshAds.map((a) => a.id));

  return {
    group: { cat, params, query: query ?? null, regions: regions ?? null },
    subject: subjectAd && {
      id: subjectAd.id,
      title: subjectAd.title,
      price_byn: subjectAd.price_byn,
      url: subjectAd.url,
      position: subjectAd.price_byn === null ? null : position(subjectAd.price_byn, st),
    },
    total_on_site: fresh.total,
    sample: { fresh: freshAds.length, old: oldCount, used: kept.length },
    stats,
    reliability: rel,
    slices: {
      fresh_median: medianOf(kept.filter((a) => freshIds.has(a.id))),
      old_median: oldIds ? medianOf(kept.filter((a) => oldIds.has(a.id))) : null,
    },
    suggest: rel.level === 'insufficient' ? null : { fast: round(st.q1), market: round(st.median), high: round(st.q3), basis },
    comparables: [...kept].sort((a, b) => a.price_byn - b.price_byn)
      .map(({ id, title, price_byn, company, listed_at, url }) => ({ id, title, price_byn, company, listed_at, url })),
    dropped,
    unclassified,
    note: NOTE,
  };
}
