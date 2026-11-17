import path from 'node:path';
import { KufarError } from './errors.mjs';
import { cached } from './storage.mjs';

const SEARCH_PATH = '/search-api/v2/search/rendered-paginated';
const DAY = 86400000;

export const CLOCK_TTL_MS = 24 * 60 * 60 * 1000;
export const AGE_CAP_DAYS = 365;

// the raw ad with the largest id among those with a numeric id and a parsable list_time
function youngest(raw) {
  let best = null;
  for (const ad of raw?.ads ?? []) {
    const id = Number(ad.ad_id);
    const ms = ad.list_time ? Date.parse(ad.list_time) : NaN;
    if (!Number.isFinite(id) || Number.isNaN(ms)) continue;
    if (!best || id > best.id) best = { id, ms };
  }
  if (!best) throw new KufarError('BAD_RESPONSE', 'В выдаче нет объявлений с номером и временем');
  return best;
}

async function measure(transport) {
  const top = youngest(await transport.getJson(SEARCH_PATH, { lang: 'ru', sort: 'lst.d', size: '30' }));
  const anchor = youngest(await transport.getJson(SEARCH_PATH, { lang: 'ru', sort: 'lst.a', size: '200' }));
  const perDay = (top.id - anchor.id) / ((top.ms - anchor.ms) / DAY);
  if (!Number.isFinite(perDay) || perDay <= 0) {
    throw new KufarError('BAD_RESPONSE', 'Не удалось построить линейку номеров', { top, anchor });
  }
  return { id: top.id, ms: top.ms, per_day: perDay };
}

export async function loadClock({ transport, stateDir, now = Date.now }) {
  try {
    return await cached(path.join(stateDir, 'cache', 'id-clock.json'), CLOCK_TTL_MS, () => measure(transport), now);
  } catch (e) {
    if (e instanceof KufarError) return null;
    throw e;
  }
}

export function ageByClock(clock, id, days, now) {
  const n = Number(id);
  if (clock === null || !Number.isFinite(n)) return days;
  const est = Math.max(0, Math.floor((now - clock.ms) / DAY + (clock.id - n) / clock.per_day));
  return Math.min(AGE_CAP_DAYS, Math.max(est, days ?? 0));
}
