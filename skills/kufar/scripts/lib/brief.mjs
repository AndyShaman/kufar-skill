// The short answers. A first answer is read by an agent whole: it carries what a first reply needs,
// and `--full` gives everything

// a listing of a search: the photos are counted, a characteristic is its name and its value
export function briefAd(ad) {
  const { images, params, body, ...rest } = ad;
  const short = {};
  for (const p of Object.values(params ?? {})) {
    const text = p.text ?? p.value;
    // Kufar gives some values as a row of empty places
    if (!/[\p{L}\p{N}]/u.test(String(text))) continue;
    short[p.label in short ? `${p.label} (${p.filter})` : p.label] = text;
  }
  return { ...rest, photos: images?.length ?? 0, params: short };
}

// a price: of a long list of similar listings the two ends are kept, where a foreign thing is most likely
export function briefPrice(estimate, edge = 15) {
  const all = estimate.comparables ?? [];
  const comparables = all.length > edge * 2 ? [...all.slice(0, edge), ...all.slice(-edge)] : all;
  // a copy, a listing without a price and one of another deal are never brought back: they are only counted
  const dropped_counts = {};
  for (const d of estimate.dropped ?? []) dropped_counts[d.reason] = (dropped_counts[d.reason] ?? 0) + 1;
  const dropped = (estimate.dropped ?? []).filter((d) => !['duplicate', 'no_price', 'not_sell'].includes(d.reason));
  return { ...estimate, comparables, comparables_total: all.length, dropped, dropped_counts };
}
