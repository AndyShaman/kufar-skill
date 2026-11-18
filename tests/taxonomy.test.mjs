import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenCategories, findCategories, parentOf, listParams, findParamValues,
} from '../skills/kufar/scripts/lib/taxonomy.mjs';
import { throwsCode } from './helpers.mjs';

const TREE = {
  categories: [
    {
      id: '1000', name_ru: 'Телефоны и планшеты',
      subcategories: [
        {
          id: '1010', parent: '1000', name_ru: 'Мобильные телефоны',
          subcategories: [{ id: '1011', parent: '1010', name_ru: 'Смартфоны Apple' }],
        },
      ],
    },
    { id: '2000', name_ru: 'Авто' },
  ],
};
const byId = (a, b) => (a.id < b.id ? -1 : 1);

test('flattenCategories walks three levels with path and parent_id', () => {
  assert.deepStrictEqual([...flattenCategories(TREE)].sort(byId), [
    { id: '1000', name: 'Телефоны и планшеты', parent_id: null, path: 'Телефоны и планшеты' },
    { id: '1010', name: 'Мобильные телефоны', parent_id: '1000', path: 'Телефоны и планшеты / Мобильные телефоны' },
    { id: '1011', name: 'Смартфоны Apple', parent_id: '1010', path: 'Телефоны и планшеты / Мобильные телефоны / Смартфоны Apple' },
    { id: '2000', name: 'Авто', parent_id: null, path: 'Авто' },
  ]);
});

test('findCategories matches substring ignoring case', () => {
  assert.deepEqual(findCategories(TREE, 'ТЕЛЕФОН').map((c) => c.id).sort(), ['1000', '1010']);
});

test('findCategories with empty or missing text returns all', () => {
  assert.equal(findCategories(TREE, '').length, 4);
  assert.equal(findCategories(TREE).length, 4);
});

test('parentOf returns parent id, null for root', () => {
  assert.equal(parentOf(TREE, '1011'), '1010');
  assert.equal(parentOf(TREE, '1010'), '1000');
  assert.equal(parentOf(TREE, '1000'), null);
});

test('parentOf throws UNKNOWN_CATEGORY for unknown id', () => {
  throwsCode(() => parentOf(TREE, '9999'), 'UNKNOWN_CATEGORY');
});

const val = (value, ru) => ({ value, labels: { ru } });
const ref = (name, url_name, label, values, type = 'select') =>
  ({ name, url_name, type, labels: { name: { ru: label } }, values });

const META = {
  parameters: {
    refs: {
      a: ref('phones_model', 'phm', 'Модель', [val('1', 'iPhone 13'), val('2', 'iPhone 13 Pro'), val('4', 'iPhone 13 Pro Max')]),
      b: ref('phones_model', 'phm', 'Модель', [val('2', 'iPhone 13 Pro'), val('3', 'iPhone 12'), val('5', 'Apple iPhone 13')]),
      c: ref('note', 'nte', 'Заметка', null, 'text'),
    },
    rules: [],
  },
};

test('listParams merges refs by url_name and counts distinct values', () => {
  const r = listParams(META).sort((x, y) => (x.filter < y.filter ? -1 : 1));
  assert.deepStrictEqual(r, [
    { name: 'note', filter: 'nte', label: 'Заметка', type: 'text', values: 0 },
    { name: 'phones_model', filter: 'phm', label: 'Модель', type: 'select', values: 5 },
  ]);
});

test('findParamValues orders exact, prefix, rest; shorter first', () => {
  const r = findParamValues(META, 'iPhone 13');
  assert.deepEqual(r.map((x) => x.text), ['iPhone 13', 'iPhone 13 Pro', 'iPhone 13 Pro Max', 'Apple iPhone 13']);
  assert.deepStrictEqual(r[0], { name: 'phones_model', filter: 'phm', label: 'Модель', value: '1', text: 'iPhone 13' });
});

test('findParamValues lists a repeated (filter, value) once, ignoring case', () => {
  const r = findParamValues(META, 'iphone');
  assert.equal(r.filter((x) => x.value === '2').length, 1);
  assert.equal(r.length, 5);
});

test('findParamValues respects limit', () => {
  assert.equal(findParamValues(META, 'iphone 13', 2).length, 2);
});
