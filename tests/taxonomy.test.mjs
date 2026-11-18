import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenCategories, findCategories, parentOf, listParams, findParamValues, findCatalogValues,
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

// ---- lookup by the name of a filter ----

const MEMORY_META = { parameters: { refs: {
  a: { name: 'phones_memory', url_name: 'ppm', labels: { name: { ru: 'Встроенная память' } }, values: [{ value: 10, labels: { ru: '64 ГБ' } }, { value: 20, labels: { ru: '128 ГБ' } }] },
  b: { name: 'phones_model', url_name: 'phm', labels: { name: { ru: 'Модель' } }, values: [{ value: 1, labels: { ru: 'Память 3000' } }] },
} } };

test('findParamValues: a word that names a filter gives the values of that filter, after the values that match themselves', () => {
  const r = findParamValues(MEMORY_META, 'память');
  assert.deepEqual(r.map((x) => `${x.filter}=${x.value}`), ['phm=1', 'ppm=10', 'ppm=20']);
  assert.deepStrictEqual(r[2], { name: 'phones_memory', filter: 'ppm', label: 'Встроенная память', value: '20', text: '128 ГБ' });
});

// ---- the catalogue: brand, model and generation of a car ----

const node = (value, ru, type, extra = {}) => ({
  value, labels: { ru }, params: { name: `cars_${type}_v2`, node_type: type, url_name: { mark: 'cbnd2', model: 'cmdl2', generation: 'cgen2' }[type], ...extra },
});
const VW = 'category_2010.mark_volkswagen';
const CATALOG = {
  category_2010: [node('category_2010.mark_audi', 'Audi', 'mark'), node(VW, 'Volkswagen', 'mark'), node('category_2010.mark_volkswagen_china', 'Volkswagen China', 'mark')],
  [VW]: [node(`${VW}.model_passat`, 'Passat', 'model'), node(`${VW}.model_passat_cc`, 'Passat CC', 'model'), node(`${VW}.model_polo`, 'Polo', 'model')],
  [`${VW}.model_passat`]: [
    node(`${VW}.model_passat.generation_b8`, 'B8', 'generation', { startYears: '2014', endYears: '2020' }),
    node(`${VW}.model_passat.generation_b7`, 'B7', 'generation', { startYears: '2010', endYears: '2015' }),
  ],
  [`${VW}.model_passat.generation_b7`]: [],
};
const catalog = () => {
  const asked = [];
  return { asked, nodesOf: async (tag) => { asked.push(tag); return CATALOG[tag] ?? []; } };
};

test('findCatalogValues: brand, model and generation are found together, one request per level', async () => {
  const c = catalog();
  const r = await findCatalogValues(c.nodesOf, '2010', 'volkswagen Passat b7');
  assert.deepStrictEqual(r, [
    { name: 'cars_mark_v2', filter: 'cbnd2', label: 'Марка', value: VW, text: 'Volkswagen' },
    { name: 'cars_model_v2', filter: 'cmdl2', label: 'Модель', value: `${VW}.model_passat`, text: 'Passat' },
    { name: 'cars_generation_v2', filter: 'cgen2', label: 'Поколение', value: `${VW}.model_passat.generation_b7`, text: 'B7', years: '2010-2015' },
  ]);
  assert.deepEqual(c.asked, ['category_2010', VW, `${VW}.model_passat`, `${VW}.model_passat.generation_b7`]);
});

test('findCatalogValues: the longest name wins, a name inside another word does not match', async () => {
  const cc = await findCatalogValues(catalog().nodesOf, '2010', 'Volkswagen Passat CC');
  assert.deepEqual(cc.map((x) => x.text), ['Volkswagen', 'Passat CC']);
  assert.deepEqual(await findCatalogValues(catalog().nodesOf, '2010', 'audio'), []);
});

test('findCatalogValues: a level with no match is listed whole, so the agent can choose', async () => {
  const models = await findCatalogValues(catalog().nodesOf, '2010', 'Volkswagen');
  assert.deepEqual(models.map((x) => x.text), ['Volkswagen', 'Passat', 'Passat CC', 'Polo']);
  const gens = await findCatalogValues(catalog().nodesOf, '2010', 'volkswagen passat б7');
  assert.deepEqual(gens.map((x) => `${x.text}${x.years ? ` ${x.years}` : ''}`), ['Volkswagen', 'Passat', 'B8 2014-2020', 'B7 2010-2015']);
});

test('findCatalogValues: no brand in the words or no catalogue in the rubric gives nothing', async () => {
  const c = catalog();
  assert.deepEqual(await findCatalogValues(c.nodesOf, '2010', 'Passat'), []);
  assert.deepEqual(c.asked, ['category_2010']);
  assert.deepEqual(await findCatalogValues(catalog().nodesOf, '17010', 'iPhone 13'), []);
});

test('findCatalogValues: nodes without a value, a name or a filter code are skipped', async () => {
  const nodesOf = async (tag) => (tag === 'category_2010' ? [{ value: 5 }, { value: 'x', labels: { ru: 'Audi' } }, null, node('category_2010.mark_audi', 'Audi', 'mark')] : []);
  assert.deepEqual((await findCatalogValues(nodesOf, '2010', 'audi a4')).map((x) => x.value), ['category_2010.mark_audi']);
});
