import { KufarError } from './errors.mjs';
import { fetchAd, parseAdRef } from './ads.mjs';
import { estimatePrice } from './price.mjs';

const shown = (p) => p.text ?? p.value;

export function compareAds(ads) {
  const names = [];
  for (const ad of ads) for (const name of Object.keys(ad.params)) if (!names.includes(name)) names.push(name);
  const differs = [];
  const same = [];
  for (const name of names) {
    const own = ads.map((ad) => (Object.hasOwn(ad.params, name) ? ad.params[name] : null));
    const { label } = own.find(Boolean);
    if (own.every((p) => p && p.value === own[0].value)) same.push({ name, label, text: shown(own[0]) });
    else differs.push({ name, label, values: own.map((p) => (p ? shown(p) : null)) });
  }
  return { differs, same, mixed_categories: new Set(ads.map((ad) => ad.category)).size > 1 };
}

export async function compare(transport, refs) {
  const ads = [];
  const missing = [];
  for (const ref of refs) {
    try {
      ads.push(await fetchAd(transport, ref));
    } catch (e) {
      if (e.code !== 'NOT_FOUND') throw e;
      missing.push(parseAdRef(ref));
    }
  }
  if (ads.length < 2) throw new KufarError('NOT_FOUND', 'Для сравнения нужно хотя бы два объявления, которые ещё есть на Куфаре', { missing });
  return { count: ads.length, ads, missing, ...compareAds(ads) };
}

// the cheapest listings worth a look; a price of half the median or less is a reason to check, not a find
export function pickBest(estimate, top = 3) {
  const median = estimate.suggest?.market ?? null;
  const tooCheap = [];
  const live = [];
  const stale = [];
  for (const c of estimate.comparables) {
    if (median !== null && c.price_byn <= median / 2) tooCheap.push({ id: c.id, price_byn: c.price_byn, url: c.url });
    else (c.stale ? stale : live).push(c);
  }
  const fromLive = live.slice(0, top);
  const fromStale = stale.slice(0, top - fromLive.length);
  return {
    median,
    picked: [...fromLive, ...fromStale].map((c) => ({
      id: c.id, price_byn: c.price_byn, vs_median_pct: median === null ? null : Math.round((c.price_byn / median - 1) * 100), stale: c.stale,
    })),
    skipped: { too_cheap: tooCheap, stale: stale.length - fromStale.length, other: live.length - fromLive.length },
  };
}

export async function compareBest(transport, opts, { top = 3, now, clock } = {}) {
  const estimate = await estimatePrice(transport, { ...opts, now, clock });
  const { picked, skipped } = pickBest(estimate, top);
  if (picked.length < 2) {
    throw new KufarError('NOT_ENOUGH', 'Подходящих объявлений меньше двух: сравнивать нечего',
      { found: picked.length, total_on_site: estimate.total_on_site });
  }
  const r = await compare(transport, picked.map((x) => x.id));
  const fetched = new Set(r.ads.map((ad) => ad.id));
  return {
    group: estimate.group, stats: estimate.stats, reliability: estimate.reliability,
    picked: picked.filter((x) => fetched.has(x.id)), skipped, ...r,
  };
}
