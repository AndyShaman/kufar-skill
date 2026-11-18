import { KufarError } from './errors.mjs';
import { fetchAd, parseAdRef } from './ads.mjs';
import { estimatePrice } from './price.mjs';
import { defectIn } from './search.mjs';

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

// the cheapest listings worth a look, from the floor up when one is given; a price of half the median or less is a reason
// to check, not a find
export function pickBest(estimate, top = 3, floor = null) {
  const median = estimate.suggest?.market ?? null;
  const tooCheap = [];
  let cheaper = 0;
  const live = [];
  const stale = [];
  for (const c of estimate.comparables) {
    if (median !== null && c.price_byn <= median / 2) tooCheap.push({ id: c.id, price_byn: c.price_byn, url: c.url });
    else if (floor !== null && c.price_byn < floor) cheaper += 1;
    else (c.stale ? stale : live).push(c);
  }
  const fromLive = live.slice(0, top);
  const fromStale = stale.slice(0, top - fromLive.length);
  return {
    median,
    picked: [...fromLive, ...fromStale].map((c) => ({
      id: c.id, price_byn: c.price_byn, vs_median_pct: median === null ? null : Math.round((c.price_byn / median - 1) * 100), stale: c.stale,
    })),
    skipped: { too_cheap: tooCheap, cheaper, stale: stale.length - fromStale.length, other: live.length - fromLive.length },
  };
}

// `fair` (a good thing for normal money) opens cards from the fast price up, `cheap` the cheapest above half the median.
// The opened cards are read. A card whose text names a defect is cheaper for that reason: it is not dropped
// and not first, it goes after the cards without one, with the piece of text. Three cards per place are opened at most
export async function compareBest(transport, opts, { top = 3, pick = 'fair', now, clock } = {}) {
  if (pick !== 'fair' && pick !== 'cheap') throw new KufarError('BAD_ARGS', '--pick: fair или cheap', { pick });
  const estimate = await estimatePrice(transport, { ...opts, now, clock });
  const floor = pick === 'fair' ? estimate.suggest?.fast ?? null : null;
  const { picked: queue, skipped: { too_cheap, cheaper } } = pickBest(estimate, Infinity, floor);
  if (queue.length < 2) {
    throw new KufarError('NOT_ENOUGH', 'Подходящих объявлений меньше двух: сравнивать нечего',
      { found: queue.length, total_on_site: estimate.total_on_site });
  }
  const clean = [];
  const flawed = [];
  const missing = [];
  let opened = 0;
  while (opened < queue.length && opened < top * 3 && clean.length + missing.length < top) {
    const c = queue[opened++];
    let ad;
    try {
      ad = await fetchAd(transport, c.id);
    } catch (e) {
      if (e.code !== 'NOT_FOUND') throw e;
      missing.push(c.id);
      continue;
    }
    const defect = defectIn(ad.body);
    (defect ? flawed : clean).push({ pick: { ...c, defect }, ad });
  }
  const found = [...clean, ...flawed];
  if (found.length < 2) throw new KufarError('NOT_FOUND', 'Для сравнения нужно хотя бы два объявления, которые ещё есть на Куфаре', { missing });
  const ads = found.map((x) => x.ad);
  const rest = queue.slice(opened);
  return {
    group: estimate.group, stats: estimate.stats, reliability: estimate.reliability,
    picked: found.map((x) => x.pick),
    skipped: { too_cheap, cheaper, stale: rest.filter((c) => c.stale).length, other: rest.filter((c) => !c.stale).length },
    count: ads.length, ads, missing, ...compareAds(ads),
  };
}
