import test from 'node:test';
import assert from 'node:assert/strict';
import { briefAd, briefPrice } from '../skills/kufar/scripts/lib/brief.mjs';
import { mkAd } from './helpers.mjs';

const P = (label, text, filter) => ({ label, value: '1', text, filter });

test('briefAd: photos are counted, characteristics are name and value, the rest stays', () => {
  const ad = mkAd(1, 620, {
    images: ['https://a/1.jpg', 'https://a/2.jpg'], body: null, flags: ['stale'],
    params: { phones_model: P('Модель', 'iPhone 13', 'phm'), phones_memory: P('Встроенная память', '128 Гб', 'pmm') },
  });
  const b = briefAd(ad);
  assert.equal(b.photos, 2);
  assert.deepEqual(b.params, { 'Модель': 'iPhone 13', 'Встроенная память': '128 Гб' });
  assert.equal('images' in b, false);
  assert.equal('body' in b, false);
  for (const k of ['id', 'title', 'url', 'price_byn', 'type', 'flags', 'listed_at']) assert.deepEqual(b[k], ad[k], k);
});

test('briefAd: two characteristics with one name are both kept; no photos and no characteristics are 0 and {}', () => {
  const b = briefAd(mkAd(1, 1, { params: { a: P('Тип', 'Раз', 'ta'), b: P('Тип', 'Два', 'tb') } }));
  assert.deepEqual(b.params, { 'Тип': 'Раз', 'Тип (tb)': 'Два' });
  const empty = briefAd(mkAd(2, 1));
  assert.equal(empty.photos, 0);
  assert.deepEqual(empty.params, {});
});

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), price_byn: 100 + i }));

test('briefPrice: a long list of similar listings is cut to the 15 cheapest and the 15 dearest, with the full count', () => {
  const r = briefPrice({ stats: { all: 1 }, suggest: { fast: 1 }, comparables: rows(100) });
  assert.equal(r.comparables_total, 100);
  assert.deepEqual(r.comparables.map((c) => c.id), [...rows(100).slice(0, 15), ...rows(100).slice(85)].map((c) => c.id));
  assert.deepEqual(r.stats, { all: 1 });
  assert.deepEqual(r.suggest, { fast: 1 });
});

test('briefPrice: a list of 30 or fewer is given whole', () => {
  const r = briefPrice({ comparables: rows(30) });
  assert.equal(r.comparables.length, 30);
  assert.equal(r.comparables_total, 30);
});

test('briefPrice: removed listings are counted by reason; the list keeps those an agent may bring back', () => {
  const dropped = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, reason: 'duplicate' })),
    { id: 'n1', reason: 'no_price' }, { id: 's1', reason: 'not_sell' },
    { id: 'o1', reason: 'outlier' }, { id: 't1', reason: 'suspect_title' },
  ];
  const r = briefPrice({ comparables: [], dropped });
  assert.deepEqual(r.dropped_counts, { duplicate: 40, no_price: 1, not_sell: 1, outlier: 1, suspect_title: 1 });
  assert.deepEqual(r.dropped.map((d) => d.id), ['o1', 't1']);
});
