import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KufarError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';
import { VERSION } from './transport.mjs';

const UPLOAD_URL = 'https://ads-image-uploader.kufar.by/v1/images';
const INSERT_URL = 'https://api.kufar.by/insertion/v1/processing/insert';
export const SEGMENTATION = 'routing=web_ad_insertion;application=ad_insertion;platform=web;taxonomy-version=2';
const DAY = 24 * 60 * 60 * 1000;
const MIN_PHOTO = 10240;
const MAX_PHOTO = 10485760;
const CONTACT_KEYS = ['name', 'phone', 'email'];
export const SERVICE_KEYS = new Set(['category', 'price', 'photos', ...CONTACT_KEYS]);
// rubles with at most two decimals; a number goes through String(), which gives the shortest exact form
const PRICE = /^(\d+)(?:\.(\d{1,2}))?$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const EMOJI = /\p{Extended_Pictographic}/u;
const FIXED = {
  type: 'sell', company_ad: '0', language: 'ru', currency: 'BYR', remuneration_type: '1',
  delivery_enabled: '0', safedeal_enabled: '0',
};

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isStrings = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string');

export function kopecks(price) {
  const m = PRICE.exec(typeof price === 'number' ? String(price) : typeof price === 'string' ? price : '');
  if (!m) return null;
  const k = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return k > 0 && k <= 100000000000 ? String(k) : null;
}

// the value that goes into the ad, or { error }; undefined for a flag that is off
export function fieldValue(field, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  switch (field.kind) {
    case 'flag':
      if (v === '1' || v === true) return '1';
      if (v === '0' || v === false) return undefined;
      return { error: 'bad_value' };
    case 'choices': {
      if (!isStrings(v)) return { error: 'bad_value' };
      const list = v.map((x) => x.trim());
      if (field.values && !list.every((x) => field.values.some((y) => y.value === x))) return { error: 'not_in_list' };
      return list;
    }
    default:
      if (typeof v !== 'string') return { error: 'bad_value' };
      if (field.kind === 'number' && !NUMBER.test(v)) return { error: 'bad_value' };
      if (field.kind === 'choice' && field.values && !field.values.some((y) => y.value === v)) return { error: 'not_in_list' };
      if ((field.name === 'subject' || field.name === 'body') && EMOJI.test(v)) return { error: 'emoji' };
      if (field.kind === 'text' && (v.length < (field.min ?? 0) || v.length > (field.max ?? Infinity))) return { error: 'length' };
      return v;
  }
}

export function buildAd({ draft, fields, type, contact }) {
  const errors = {};
  const ad = { ...FIXED };

  if (draft.category === undefined) errors.category = 'required';
  else if (typeof draft.category !== 'string' || !/^\d+$/.test(draft.category)) errors.category = 'bad_value';
  else ad.category = draft.category;

  if (draft.price === undefined) errors.price = 'required';
  else if (kopecks(draft.price) === null) errors.price = 'bad_value';
  else ad.price = kopecks(draft.price);

  if (draft.photos !== undefined && (!isStrings(draft.photos) || draft.photos.length > 9)) errors.photos = 'bad_value';

  for (const [key, raw] of Object.entries(draft)) {
    if (SERVICE_KEYS.has(key)) continue;
    const field = fields.find((f) => f.name === key);
    if (!field) {
      errors[key] = 'unknown';
      continue;
    }
    const v = fieldValue(field, raw);
    if (v?.error) errors[key] = v.error;
    // in some categories a fixed term (type) is also a form field: it may only repeat the fixed value
    else if (Object.hasOwn(FIXED, key) && v !== undefined && v !== FIXED[key]) errors[key] = 'fixed';
    else if (v !== undefined) ad[key] = v;
  }
  for (const f of fields) {
    if (f.required && !SERVICE_KEYS.has(f.name) && draft[f.name] === undefined) errors[f.name] = 'required';
  }

  for (const key of CONTACT_KEYS) {
    const v = contact?.[key];
    if (typeof v !== 'string' || !v.trim()) errors[key] = 'required';
    else ad[key] = v.trim();
  }

  if (Object.keys(errors).length) throw new KufarError('DRAFT_INVALID', 'В черновике ошибки', { fields: errors });
  if (type && ad[type.name] !== undefined) {
    ad.type_field_name = type.url_name;
    ad.type_field_value = ad[type.name];
  }
  return { ad, photos: draft.photos ?? [] };
}

const TITLE_HINTS = [
  ['selling_word', /^\s*(?:продам|продаю|продается|продаётся|куплю|срочно)(?!\p{L})/iu],
  ['price', /\d\s?(?:рублей|рубля|руб\.?|р\.?|byn|usd|eur)(?![\p{L}\p{N}])|[$€]/iu],
  ['contact', /@|https?:\/\/|www\.|(?:\+375|80)(?:[\s()-]*\d){9}/iu],
  ['glued', /\d(?:gb|гб|tb|тб)(?!\p{L})/iu],
];

// a hint for the agent, not a check: Kufar search ranks titles with all the words of the query first
export function titleHints(subject) {
  if (typeof subject !== 'string') return [];
  return TITLE_HINTS.filter(([, re]) => re.test(subject)).map(([name]) => name);
}

export const maskEmail = (email) => `${email[0]}…${email.slice(email.indexOf('@'))}`;

export function maskContact({ name, phone, email }) {
  return { name, phone: `…${phone.replace(/\D/g, '').slice(-4)}`, email: maskEmail(email) };
}

export async function photoInfo(files) {
  const out = [];
  for (const [index, file] of files.entries()) {
    const badFile = () => new KufarError('DRAFT_INVALID', 'В черновике ошибки', { fields: { photos: 'bad_file' }, index });
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!['jpg', 'jpeg', 'png'].includes(ext)) throw badFile();
    let data;
    try {
      data = await fs.readFile(file);
    } catch {
      throw badFile();
    }
    if (data.length <= MIN_PHOTO || data.length > MAX_PHOTO) throw badFile();
    out.push({ file, ext, bytes: data.length, sha256: sha256(data), data });
  }
  return out;
}

export function postCode(ad, photos) {
  const pairs = Object.entries(ad).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify([pairs, photos.map((p) => p.sha256)])).slice(0, 12);
}

// one request with the key; the exception text may repeat the headers, so it is never passed on
export async function call(fetchImpl, url, { method = 'POST', token, headers = {}, body, timeoutMs }) {
  let res;
  let text;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { 'User-Agent': `kufar-skill/${VERSION}`, Authorization: `Bearer ${token}`, ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new KufarError('TIMEOUT', 'Куфар не ответил вовремя', { timeout_ms: timeoutMs });
    }
    throw new KufarError('NETWORK', 'Сетевая ошибка');
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, data };
}

export async function uploadPhoto({ token, data, ext, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  const body = new FormData();
  body.append('file', new Blob([data], { type: ext === 'png' ? 'image/png' : 'image/jpeg' }), `photo.${ext}`);
  const { status, data: answer } = await call(fetchImpl, UPLOAD_URL, { token, body, timeoutMs });
  if (status === 401) throw new KufarError('AUTH_EXPIRED', 'Ключ входа просрочен или Куфар его не принял. Выполните login', { status });
  if (status !== 200 || typeof answer?.path !== 'string') throw new KufarError('PHOTO_FAILED', 'Куфар не принял фото', { status });
  return answer.path;
}

// the field messages of a 422 answer
export function refusedFields(data) {
  const fields = Object.entries(data?.details?.fields ?? {}).slice(0, 30)
    .map(([k, v]) => [k, String(v?.translations?.ru ?? v?.message ?? '').slice(0, 200)]);
  return Object.fromEntries(fields);
}

const unconfirmed = () => new KufarError('POST_UNCONFIRMED', 'Куфар не подтвердил подачу. Объявление могло появиться: '
  + 'проверьте my, my --status inactive и my --status pending_slot, прежде чем подавать снова');

export async function insertAd({ token, ad, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  let r;
  try {
    r = await call(fetchImpl, INSERT_URL, {
      token,
      headers: { 'Content-Type': 'application/json', 'X-Segmentation': SEGMENTATION },
      body: JSON.stringify({ ad, delivery: null }),
      timeoutMs,
    });
  } catch {
    throw unconfirmed();
  }
  const { status, data } = r;
  if (status === 200 && Number.isInteger(data?.ad_id)) return { ad_id: String(data.ad_id), pending_slot: data.pending_slot === true };
  if (status === 422) throw new KufarError('POST_REFUSED', 'Куфар не принял объявление', { fields: refusedFields(data) });
  // 401 too: it is not yet known that the key alone is enough to post, so no new login is asked for
  if (status >= 400 && status < 500) throw new KufarError('POST_FAILED', 'Куфар отказал в подаче', { status });
  throw unconfirmed();
}

// the record of the last submission keeps a rerun after a broken run from posting a second ad
export async function submitAd({ stateDir, code, ad, photos, token, fetchImpl = globalThis.fetch, now = Date.now }) {
  const file = path.join(stateDir, 'post-last.json');
  const last = await readJson(file, null);
  if (last?.code === code && typeof last.at === 'number' && now() - last.at <= DAY) {
    if (last.ad_id) throw new KufarError('ALREADY_POSTED', 'Это объявление уже подано', { ad_id: last.ad_id });
    throw unconfirmed();
  }
  const images = [];
  for (const p of photos) images.push(await uploadPhoto({ token, data: p.data, ext: p.ext, fetchImpl }));
  const at = now();
  await writeJsonAtomic(file, { code, at });
  const body = images.length ? { ...ad, images, is_new_image: images.map(() => true) } : ad;
  try {
    const result = await insertAd({ token, ad: body, fetchImpl });
    await writeJsonAtomic(file, { code, at, ad_id: result.ad_id });
    return result;
  } catch (e) {
    if (e.code === 'POST_REFUSED' || e.code === 'POST_FAILED') await fs.rm(file, { force: true });
    throw e;
  }
}
