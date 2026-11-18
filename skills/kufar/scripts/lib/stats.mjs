export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function priceStats(prices) {
  const s = [...prices].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s.length ? s[0] : null,
    q1: quantile(s, 0.25),
    median: quantile(s, 0.5),
    q3: quantile(s, 0.75),
    max: s.length ? s[s.length - 1] : null,
  };
}

const REASON_ORDER = ['no_price', 'not_sell', 'suspect_title', 'duplicate'];

export function cleanForPricing(ads, { exclude = [], include = [] } = {}) {
  const ex = new Set(exclude.map(String));
  const inc = new Set(include.map(String));
  const dropped = [];
  const drop = (ad, reason) => dropped.push({ id: ad.id, title: ad.title, price_byn: ad.price_byn, reason });

  const rest = [];
  for (const ad of ads) {
    if (ex.has(ad.id)) { drop(ad, 'excluded'); continue; }
    const flags = inc.has(ad.id) ? ad.flags.filter((f) => f !== 'suspect_title') : ad.flags;
    const reason = REASON_ORDER.find((r) => flags.includes(r));
    if (reason) drop(ad, reason);
    else rest.push(ad);
  }

  const { median } = priceStats(rest.map((a) => a.price_byn));
  const kept = rest.filter((ad) => {
    if (median === null || inc.has(ad.id)) return true;
    if (ad.price_byn < 0.3 * median || ad.price_byn > 3 * median) { drop(ad, 'outlier'); return false; }
    return true;
  });
  return { kept, dropped };
}

export function reliability(stats) {
  if (stats.n < 5) return { level: 'insufficient', reasons: ['too_few'] };
  const reasons = [];
  if (stats.n < 10) reasons.push('few');
  if ((stats.q3 - stats.q1) / stats.median > 0.4) reasons.push('wide_spread');
  return { level: reasons.length ? 'low' : 'ok', reasons };
}

export function position(price, stats) {
  if (stats.n === 0) return { vs_median_pct: null, band: null, suspicious_low: false };
  const { q1, median, q3 } = stats;
  const band = price < q1 ? 'below_q1' : price < median ? 'q1_median' : price <= q3 ? 'median_q3' : 'above_q3';
  return { vs_median_pct: Math.round((price / median - 1) * 100), band, suspicious_low: price < 0.5 * median };
}
