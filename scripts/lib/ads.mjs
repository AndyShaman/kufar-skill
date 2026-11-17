import { KufarError } from './errors.mjs';

const SKIP_PARAMS = new Set(['category', 'region', 'area']);

export function parseAdRef(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new KufarError('BAD_AD_REF', 'Нужен номер объявления или ссылка на kufar.by', { input });
  }
  const hostOk = url.hostname === 'kufar.by' || url.hostname.endsWith('.kufar.by');
  const m = url.pathname.match(/^\/(?:item|vi)\/(?:[^/]+\/)*(\d+)\/?$/);
  if (!hostOk || !m) throw new KufarError('BAD_AD_REF', 'Нужен номер объявления или ссылка на kufar.by', { input });
  return m[1];
}

const money = (v) => (Number(v) > 0 ? Number(v) / 100 : null);
const join = (v, sep) => (Array.isArray(v) ? v.join(sep) : v);

export function normalizeAd(raw) {
  const id = String(raw.ad_id ?? raw.list_id);
  const adParams = raw.ad_parameters ?? [];
  const accParams = raw.account_parameters ?? [];
  const param = (p) => adParams.find((x) => x.p === p);
  const account = (p) => accParams.find((x) => x.p === p)?.v ?? null;
  const cond = Number(param('condition')?.v);

  const params = {};
  for (const x of adParams) {
    if (SKIP_PARAMS.has(x.p)) continue;
    const text = join(x.vl, ', ');
    params[x.p] = { label: x.pl ?? null, value: String(join(x.v, ',')), text: text === '' || text == null ? null : text, filter: x.pu ?? null };
  }

  return {
    id,
    title: raw.subject ?? null,
    url: raw.ad_link || `https://www.kufar.by/item/${id}`,
    price_byn: money(raw.price_byn),
    price_usd: money(raw.price_usd),
    listed_at: raw.list_time ?? null,
    category: raw.category == null ? null : String(raw.category),
    type: raw.type ?? null,
    company: raw.company_ad === true,
    seller: { name: account('name'), unp: account('vat_number') },
    seller_key: raw.account_id ?? null,
    region: param('region')?.vl ?? null,
    area: param('area')?.vl ?? null,
    condition: cond === 1 ? 'used' : cond === 2 ? 'new' : null,
    delivery: param('delivery_enabled')?.v === true,
    safedeal: param('safedeal_enabled')?.v === true,
    images: (raw.images ?? []).filter((i) => i.path).map((i) => `https://rms.kufar.by/v1/gallery/${i.path}`),
    params,
    body: raw.body ?? null,
  };
}

export async function fetchAd(transport, ref) {
  const id = parseAdRef(ref);
  const raw = await transport.getJson(`/search-api/v2/item/${id}/rendered`, { lang: 'ru' });
  if (!raw?.result) throw new KufarError('BAD_RESPONSE', 'В ответе Куфара нет объявления', { id });
  return normalizeAd(raw.result);
}
