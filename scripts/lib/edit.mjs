import { KufarError } from './errors.mjs';
import { SEGMENTATION, SERVICE_KEYS, call, fieldValue, kopecks, refusedFields, sha256, uploadPhoto } from './post.mjs';

const UPDATE_URL = 'https://api.kufar.by/insertion/v1/processing/update/';
const AS_SAVED = ['category', 'type', 'company_ad', 'language', 'currency', 'remuneration_type', 'delivery_enabled',
  'safedeal_enabled', 'halva', 'name', 'phone'];
const KNOWN = new Set([...AS_SAVED, ...SERVICE_KEYS, 'list_id', 'category_type', 'clear_phone_1', 'images',
  'type_field_name', 'type_field_value', 'refusal_reason', 'deactivated', 'environment_id']);
const FIXED = ['category', 'name', 'phone'];

export const editUnsupported = (details) => new KufarError('EDIT_UNSUPPORTED',
  'Это объявление утилита не правит, исправьте его на сайте', details);

// a saved value in the shape of a draft; undefined when there is none
function norm(v, field) {
  if (typeof v === 'number') v = String(v);
  if (v === true) v = '1';
  if (typeof v === 'string') v = v.trim();
  if (v === false || v === null || v === '') return undefined;
  if (field?.kind === 'choices' && typeof v === 'string') return v.split(',').map((x) => x.trim());
  return v;
}

// what the value means in the ad: a flag that is off and no value are the same
const meaning = (field, v) => (field.kind === 'flag' && v !== '1' ? null : v ?? null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function editSupport(saved) {
  const company = norm(saved.company_ad);
  if (company !== undefined && company !== '0') return 'company';
  if (norm(saved.delivery_enabled) === '1' || norm(saved.safedeal_enabled) === '1') return 'delivery';
  if (norm(saved.halva) === '1') return 'halva';
  return null;
}

export function buildEdit({ saved, changes, fields, savedFields, type, email }) {
  const formNames = new Set(savedFields.map((f) => f.name));
  const dropped = Object.keys(saved)
    .filter((k) => !KNOWN.has(k) && !formNames.has(k) && norm(saved[k]) !== undefined && !same(saved[k], [])).sort();
  if (dropped.length) throw editUnsupported({ reason: 'dropped', dropped });

  const errors = {};
  const ad = {};
  for (const k of AS_SAVED) if (norm(saved[k]) !== undefined) ad[k] = norm(saved[k]);

  if (typeof email !== 'string' || !email.trim()) errors.email = 'required';
  else ad.email = email.trim();

  const own = fields.filter((f) => !SERVICE_KEYS.has(f.name));
  for (const key of Object.keys(changes)) {
    if (FIXED.includes(key)) errors[key] = 'fixed';
    else if (!SERVICE_KEYS.has(key) && !own.some((f) => f.name === key)) errors[key] = 'unknown';
  }
  for (const f of own) {
    const raw = f.name in changes ? changes[f.name] : norm(saved[f.name], f);
    if (raw === undefined) {
      if (f.required) errors[f.name] = 'required';
      continue;
    }
    const v = fieldValue(f, raw);
    if (v?.error) errors[f.name] = v.error;
    else if (v !== undefined) ad[f.name] = v;
  }

  const savedPrice = norm(saved.price);
  if ('price' in changes) {
    if (ad.currency !== 'BYR' || ad.remuneration_type !== '1') errors.price = 'terms';
    else if (kopecks(changes.price) === null) errors.price = 'bad_value';
    else ad.price = kopecks(changes.price);
  } else if (savedPrice !== undefined) ad.price = savedPrice;

  const images = (Array.isArray(saved.images) ? saved.images : []).filter((i) => typeof i?.path === 'string');
  let photos = images.map((i) => ({ path: i.path }));
  if ('photos' in changes) {
    const list = changes.photos;
    const ok = Array.isArray(list) && list.length <= 9 && list.every((x, i) => (typeof x === 'string'
      ? x.trim() !== ''
      : Number.isInteger(x) && x >= 1 && x <= images.length && list.indexOf(x) === i));
    if (!ok) errors.photos = 'bad_value';
    else photos = list.map((x) => (typeof x === 'string' ? { file: x } : { path: images[x - 1].path }));
  }

  if (Object.keys(errors).length) throw new KufarError('DRAFT_INVALID', 'В изменениях ошибки', { fields: errors });
  if (type && ad[type.name] !== undefined) {
    ad.type_field_name = type.url_name;
    ad.type_field_value = ad[type.name];
  }

  const changed = [];
  for (const f of own) {
    const from = meaning(f, norm(saved[f.name], f));
    const to = ad[f.name] ?? null;
    if (!same(from, to)) changed.push({ name: f.name, from, to });
  }
  for (const f of savedFields) {
    if (SERVICE_KEYS.has(f.name) || own.some((x) => x.name === f.name)) continue;
    const from = meaning(f, norm(saved[f.name], f));
    if (from !== null) changed.push({ name: f.name, from, to: null });
  }
  if ((savedPrice ?? null) !== (ad.price ?? null)) changed.push({ name: 'price', from: savedPrice ?? null, to: ad.price ?? null });
  if (!same(photos, images.map((i) => ({ path: i.path })))) changed.push({ name: 'photos', from: images.length, to: photos.length });

  if (!changed.length) throw new KufarError('NO_CHANGES', 'Изменений нет: объявление уже такое');
  return { ad, photos, changed };
}

export function editCode(id, ad, photoKeys) {
  const pairs = Object.entries(ad).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify([id, pairs, photoKeys])).slice(0, 12);
}

const unconfirmed = () => new KufarError('EDIT_UNCONFIRMED', 'Куфар не подтвердил правку. Она могла быть принята и ждать '
  + 'модератора. Запросите предпросмотр заново: если в нём объявление уже исправлено, не повторяйте');

export async function updateAd({ token, id, ad, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  let r;
  try {
    r = await call(fetchImpl, `${UPDATE_URL}${id}`, {
      method: 'PUT',
      token,
      headers: { 'Content-Type': 'application/json', 'X-Segmentation': SEGMENTATION },
      body: JSON.stringify({ ad, delivery: null }),
      timeoutMs,
    });
  } catch {
    throw unconfirmed();
  }
  const { status, data } = r;
  // the shape of the answer is not known yet, so the body is not read
  if (status === 200) return true;
  if (status === 422) throw new KufarError('EDIT_REFUSED', 'Куфар не принял правку', { fields: refusedFields(data) });
  if (status >= 400 && status < 500) throw new KufarError('EDIT_FAILED', 'Куфар отказал в правке', { status });
  throw unconfirmed();
}

export async function submitEdit({ token, id, ad, photos, fetchImpl = globalThis.fetch }) {
  const images = [];
  for (const p of photos) images.push(p.path ?? await uploadPhoto({ token, data: p.data, ext: p.ext, fetchImpl }));
  return updateAd({ token, id, ad: { ...ad, images, is_new_image: photos.map((p) => p.path === undefined) }, fetchImpl });
}
