import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdRef, normalizeAd } from '../scripts/lib/ads.mjs';
import { RAW_AD, EXPECTED_AD, rawAd, throwsCode } from './helpers.mjs';

test('parseAdRef accepts a bare number', () => {
  assert.equal(parseAdRef('1000000001'), '1000000001');
});

test('parseAdRef accepts the three link kinds', () => {
  for (const u of [
    'https://www.kufar.by/item/1000000001',
    'https://re.kufar.by/vi/1000000001',
    'https://auto.kufar.by/vi/1000000001',
  ]) assert.equal(parseAdRef(u), '1000000001');
});

test('parseAdRef handles query and trailing slash', () => {
  assert.equal(parseAdRef('https://www.kufar.by/item/1000000001?searchId=abc'), '1000000001');
  assert.equal(parseAdRef('https://www.kufar.by/item/1000000001/'), '1000000001');
});

test('parseAdRef rejects foreign hosts and garbage', () => {
  for (const x of ['https://example.com/item/1000000001', 'https://notkufar.by/item/1000000001', 'abc', '', 'not-a-ref']) {
    throwsCode(() => parseAdRef(x), 'BAD_AD_REF');
  }
});

test('normalizeAd matches the contract example', () => {
  assert.deepStrictEqual(normalizeAd(structuredClone(RAW_AD)), EXPECTED_AD);
});

test('normalizeAd price is null for 0, empty, null, non-numeric', () => {
  for (const v of ['0', '', null, 'abc']) {
    assert.equal(normalizeAd(rawAd({ price_byn: v })).price_byn, null);
  }
});

test('normalizeAd condition mapping', () => {
  const withCond = (v) => {
    const raw = rawAd();
    raw.ad_parameters.find((p) => p.p === 'condition').v = v;
    return normalizeAd(raw).condition;
  };
  assert.equal(withCond(2), 'new');
  assert.equal(withCond(1), 'used');
  const raw = rawAd();
  raw.ad_parameters = raw.ad_parameters.filter((p) => p.p !== 'condition');
  assert.equal(normalizeAd(raw).condition, null);
});

test('normalizeAd reads company seller unp', () => {
  const raw = rawAd({ company_ad: true });
  raw.account_parameters.push({ p: 'vat_number', v: '100000001' });
  const ad = normalizeAd(raw);
  assert.equal(ad.seller.unp, '100000001');
  assert.equal(ad.company, true);
});

test('normalizeAd company follows company_ad, not vat_number', () => {
  const raw = rawAd({ company_ad: false });
  raw.account_parameters.push({ p: 'vat_number', v: '100000001' });
  const ad = normalizeAd(raw);
  assert.equal(ad.company, false);
  assert.equal(ad.seller.unp, '100000001');
});

test('normalizeAd joins array values and labels', () => {
  const raw = rawAd();
  raw.ad_parameters.push({ p: 'colors', pl: 'Цвета', v: [1, 2], vl: ['Чёрный', 'Белый'], pu: 'clr' });
  assert.deepEqual(normalizeAd(raw).params.colors, { label: 'Цвета', value: '1,2', text: 'Чёрный, Белый', filter: 'clr' });
});

test('normalizeAd empty vl gives text null', () => {
  const raw = rawAd();
  raw.ad_parameters.push({ p: 'extra', pl: 'Доп', v: 5, vl: '', pu: 'ext' });
  assert.equal(normalizeAd(raw).params.extra.text, null);
});

test('normalizeAd builds url when ad_link is missing', () => {
  const raw = rawAd();
  delete raw.ad_link;
  assert.equal(normalizeAd(raw).url, 'https://www.kufar.by/item/1000000001');
});

test('normalizeAd does not throw on a bare ad', () => {
  const ad = normalizeAd({ ad_id: 1 });
  assert.equal(ad.id, '1');
});
