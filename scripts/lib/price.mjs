import { KufarError } from './errors.mjs';
import { fetchAd } from './ads.mjs';
import { search, flagAds, STALE_DAYS } from './search.mjs';
import { priceStats, cleanForPricing, reliability, position } from './stats.mjs';

const NOTE = 'Это цены объявлений, а не сделок.';
// filters every category has (condition, private or company, delivery, town): they narrow a group but do not say what the goods are
const GENERAL = new Set(['cnd', 'cmp', 'dle', 'ar']);

// a requested filter value contradicts the ad's value; ranges ("r:…") never do
function contradicts(wanted, value) {
  const w = String(wanted);
  if (w.startsWith('r:')) return false;
  if (w.startsWith('v.or:')) return !w.slice(5).split(',').includes(value);
  return w !== value;
}

const medianOf = (ads) => priceStats(ads.map((a) => a.price_byn)).median;

export async function estimatePrice(transport, { cat, params = {}, query, regions, exclude = [], include = [], like, by, now = Date.now, clock = null } = {}) {
  let subjectAd = null;
  if (like !== undefined) {
    subjectAd = await fetchAd(transport, like);
    cat = subjectAd.category;
    const available = Object.values(subjectAd.params).map(({ filter, label, text }) => ({ filter, label, text }));
    if (!by?.length && !query) {
      throw new KufarError('NEEDS_BY', 'Укажите --by: по каким характеристикам искать похожие (или --query)', { available });
    }
    const own = params;
    params = {};
    for (const code of by ?? []) {
      const p = Object.values(subjectAd.params).find((x) => x.filter === code);
      if (!p) throw new KufarError('BAD_ARGS', `У объявления нет характеристики ${code}`, { by: code, available });
      params[code] = p.value;
    }
    // what the user asked for on top of the listing's own characteristics wins
    params = { ...params, ...own };
  }
  if (!cat) throw new KufarError('BAD_ARGS', 'Нужна рубрика (--cat) или объявление (--like)');
  const byWords = Object.keys(params).every((code) => GENERAL.has(code));
  if (byWords && !query) {
    throw new KufarError('BAD_ARGS', 'Нужны характеристики товара (--param) или слова (--query): цена по целой рубрике бессмысленна');
  }

  const base = byWords ? { cat, query, params, regions, sort: 'new', limit: 200 } : { cat, params, regions, sort: 'new', limit: 200 };
  const notSubject = (ads) => ads.filter((a) => a.id !== subjectAd?.id);

  const fresh = await search(transport, base, { now, clock });
  const freshAds = notSubject(fresh.ads);
  const pool = new Map(freshAds.map((a) => [a.id, a]));

  let oldCount = 0;
  if (fresh.total > fresh.ads.length) {
    const old = notSubject((await search(transport, { ...base, sort: 'old' }, { now, clock })).ads);
    for (const a of old) {
      if (pool.has(a.id)) continue;
      pool.set(a.id, a);
      oldCount++;
    }
  }

  const unclassified = [];
  if (!byWords && query) {
    const inc = new Set(include.map(String));
    const words = notSubject((await search(transport, { cat, query, regions, sort: 'new', limit: 200 }, { now, clock })).ads);
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
  const isStale = (a) => a.flags.includes('stale');
  const live = kept.filter((a) => !isStale(a));
  const staleAds = kept.filter(isStale);
  const staleSample = live.length < 5;
  const core = staleSample ? kept : live;
  const prices = (ads) => ads.map((a) => a.price_byn);
  const stats = {
    all: priceStats(prices(core)),
    private: priceStats(prices(core.filter((a) => a.company === false))),
    company: priceStats(prices(core.filter((a) => a.company === true))),
  };
  const basis = stats.private.n >= 5 ? 'private' : 'all';
  const st = stats[basis];
  let rel = reliability(st);
  if (staleSample && rel.level !== 'insufficient') rel = { level: 'low', reasons: [...rel.reasons, 'stale_sample'] };
  const round = st.median >= 20 ? Math.round : (x) => Math.round(x * 100) / 100;
  const liveMedian = medianOf(live);
  const staleMedian = medianOf(staleAds);
  const subjectFlagged = subjectAd && flagAds([subjectAd], now(), clock)[0];
  const isBumped = (a) => a.flags.includes('bumped');

  return {
    group: { cat, params, query: query ?? null, regions: regions ?? null },
    subject: subjectAd && {
      id: subjectAd.id,
      title: subjectAd.title,
      price_byn: subjectAd.price_byn,
      url: subjectAd.url,
      days: subjectFlagged.days,
      age_days: subjectFlagged.age_days,
      stale: isStale(subjectFlagged),
      bumped: isBumped(subjectFlagged),
      position: subjectAd.price_byn === null ? null : position(subjectAd.price_byn, st),
    },
    total_on_site: fresh.total,
    sample: { fresh: freshAds.length, old: oldCount, used: kept.length, live: live.length },
    stats,
    reliability: rel,
    stale: {
      days: STALE_DAYS,
      n: staleAds.length,
      median: staleMedian,
      bumped: { n: staleAds.filter(isBumped).length, median: medianOf(staleAds.filter(isBumped)) },
      vs_live_pct: staleMedian === null || liveMedian === null ? null : Math.round((staleMedian / liveMedian - 1) * 100),
      cheap: liveMedian === null ? [] : staleAds.filter((a) => a.price_byn <= liveMedian)
        .sort((a, b) => a.price_byn - b.price_byn).slice(0, 10)
        .map(({ id, title, price_byn, days, age_days, flags, url }) => ({ id, title, price_byn, days, age_days, bumped: flags.includes('bumped'), url })),
    },
    suggest: rel.level === 'insufficient' ? null : { fast: round(st.q1), market: round(st.median), high: round(st.q3), basis },
    comparables: [...kept].sort((a, b) => a.price_byn - b.price_byn)
      .map(({ id, title, price_byn, company, listed_at, days, age_days, flags, url }) => ({
        id, title, price_byn, company, listed_at, days, age_days, stale: flags.includes('stale'), bumped: flags.includes('bumped'), url,
      })),
    dropped,
    unclassified,
    note: NOTE,
  };
}
