import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kufar-test-'));
}

export function checkErr(e, code) {
  assert.equal(e.name, 'KufarError');
  assert.equal(e.code, code);
  return true;
}
export const rejectsCode = (p, code) => assert.rejects(p, (e) => checkErr(e, code));
export const throwsCode = (fn, code) => assert.throws(fn, (e) => checkErr(e, code));

// JSON round trip drops undefined values
export const plain = (x) => JSON.parse(JSON.stringify(x));

export const RAW_AD = {
  ad_id: 1000000001,
  list_id: 1000000001,
  ad_link: 'https://www.kufar.by/item/1000000001',
  subject: 'iPhone 13 128 ГБ',
  body: null,
  body_short: null,
  price_byn: '62000',
  price_usd: '20683',
  currency: 'BYR',
  list_time: '2026-11-17T10:41:07Z',
  category: '17010',
  type: 'sell',
  company_ad: false,
  account_id: 'Ab3xVolatile',
  account_parameters: [{ p: 'name', pl: 'Имя', v: 'Тестовый Продавец', vl: '', pu: 'nme' }],
  ad_parameters: [
    { p: 'category', pl: 'Категория', v: 17010, vl: 'Мобильные телефоны', pu: 'cat' },
    { p: 'region', pl: 'Область', v: 7, vl: 'Минск', pu: 'rgn' },
    { p: 'area', pl: 'Район', v: '28', vl: 'Советский', pu: 'ar' },
    { p: 'phones_model', pl: 'Модель', v: 5380, vl: 'iPhone 13', pu: 'phm' },
    { p: 'phablet_phones_memory', pl: 'Встроенная память', v: 20, vl: '128 ГБ', pu: 'ppm' },
    { p: 'condition', pl: 'Состояние', v: 1, vl: 'Б/у', pu: 'cnd' },
    { p: 'delivery_enabled', pl: 'Куфар Доставка', v: true, vl: 'Да', pu: 'dle' },
    { p: 'safedeal_enabled', pl: 'Куфар Оплата', v: true, vl: 'Да', pu: 'sde' },
  ],
  images: [{ id: '0000', media_storage: 'rms', path: 'adim1/aaaa-bbbb.jpg', yams_storage: false }],
  phone_hidden: true,
  paid_services: { halva: false, highlight: false, polepos: false, ribbons: null },
};

export const EXPECTED_AD = {
  id: '1000000001',
  title: 'iPhone 13 128 ГБ',
  url: 'https://www.kufar.by/item/1000000001',
  price_byn: 620,
  price_usd: 206.83,
  listed_at: '2026-11-17T10:41:07Z',
  category: '17010',
  type: 'sell',
  company: false,
  seller: { name: 'Тестовый Продавец', unp: null },
  seller_key: 'Ab3xVolatile',
  region: 'Минск',
  area: 'Советский',
  condition: 'used',
  delivery: true,
  safedeal: true,
  images: ['https://rms.kufar.by/v1/gallery/adim1/aaaa-bbbb.jpg'],
  params: {
    phones_model: { label: 'Модель', value: '5380', text: 'iPhone 13', filter: 'phm' },
    phablet_phones_memory: { label: 'Встроенная память', value: '20', text: '128 ГБ', filter: 'ppm' },
    condition: { label: 'Состояние', value: '1', text: 'Б/у', filter: 'cnd' },
    delivery_enabled: { label: 'Куфар Доставка', value: 'true', text: 'Да', filter: 'dle' },
    safedeal_enabled: { label: 'Куфар Оплата', value: 'true', text: 'Да', filter: 'sde' },
  },
  body: null,
};

export const rawAd = (over = {}) => ({ ...structuredClone(RAW_AD), ...over });

// raw ad with a phones_model parameter; price in BYN (null = no price)
export function rawAdOf({ id, price = 500, company = false, phm = 5380, title, type = 'sell' }) {
  const raw = rawAd({
    ad_id: id,
    list_id: id,
    ad_link: `https://www.kufar.by/item/${id}`,
    subject: title ?? `Телефон ${id}`,
    price_byn: price == null ? null : String(Math.round(price * 100)),
    company_ad: company,
    account_id: `acc${id}`,
    type,
  });
  if (phm === null) raw.ad_parameters = raw.ad_parameters.filter((p) => p.pu !== 'phm');
  else raw.ad_parameters.find((p) => p.pu === 'phm').v = phm;
  return raw;
}

export const series = (start, prices, over = {}) =>
  prices.map((p, i) => rawAdOf({ id: start + i, price: p, ...over }));

// normalized-looking ad for pure functions
export function mkAd(id, price, over = {}) {
  return {
    id: String(id),
    title: `Товар ${id}`,
    url: `https://www.kufar.by/item/${id}`,
    price_byn: price,
    type: 'sell',
    company: false,
    seller_key: `k${id}`,
    listed_at: '2026-11-17T10:00:00Z',
    flags: [],
    ...over,
  };
}

export function fakeTransport(handler) {
  const calls = [];
  return {
    calls,
    async getJson(p, query = {}) {
      calls.push({ path: p, query });
      return handler(p, query);
    },
  };
}

export const itemIdOf = (p) => p.match(/\/item\/(\d+)\/rendered/)?.[1] ?? null;
export const SEARCH_PATH = '/search-api/v2/search/rendered-paginated';
export const pageOf = (ads, total = ads.length, pages = []) => ({ ads, total, pagination: { pages } });
