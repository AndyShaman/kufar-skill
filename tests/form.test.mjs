import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveForm, findFormValues } from '../scripts/lib/form.mjs';
import { throwsCode } from './helpers.mjs';

const V = { category: '2040', company_ad: '0' };
const ui = (type) => ({ type });
const f = (name, over = {}) => ({
  name, required: false, type: 'string', multi: false, ui_component: ui('select'),
  actions: [], labels: { name: { ru: `L-${name}` } }, values: [], ...over,
});
const vals = (...xs) => xs.map(([value, ru]) => ({ value, labels: { ru } }));

// a made-up form: refs by number, rules, order by group
function boot({ refs = {}, rules = [{ rule: {}, refs: Object.keys(refs) }], order } = {}) {
  return {
    ad_metadata: {
      parameters: { refs, rules },
      parameters_order: { refs: order ?? { main: Object.keys(refs) } },
    },
  };
}
const names = (fields) => fields.map((x) => x.name);

test('resolveForm: refs missing -> BAD_RESPONSE', () => {
  const b = boot({ refs: { 1: f('a') } });
  delete b.ad_metadata.parameters.refs;
  throwsCode(() => resolveForm(b, V), 'BAD_RESPONSE');
});

test('resolveForm: refs not an object -> BAD_RESPONSE', () => {
  const b = boot({ refs: { 1: f('a') } });
  b.ad_metadata.parameters.refs = 'x';
  throwsCode(() => resolveForm(b, V), 'BAD_RESPONSE');
});

test('resolveForm: rules not an array -> BAD_RESPONSE', () => {
  const b = boot({ refs: { 1: f('a') } });
  b.ad_metadata.parameters.rules = {};
  throwsCode(() => resolveForm(b, V), 'BAD_RESPONSE');
});

test('resolveForm: parameters_order.refs missing -> BAD_RESPONSE', () => {
  const b = boot({ refs: { 1: f('a') } });
  delete b.ad_metadata.parameters_order.refs;
  throwsCode(() => resolveForm(b, V), 'BAD_RESPONSE');
});

test('resolveForm: output follows parameters_order (groups in key order, numbers in array order), not rules', () => {
  const refs = { 1: f('a'), 2: f('b'), 3: f('c'), 4: f('d') };
  const b = boot({
    refs,
    rules: [{ rule: {}, refs: ['4', '3'] }, { rule: {}, refs: ['1', '2'] }],
    order: { first: ['2', '4'], second: ['1', '3'] },
  });
  assert.deepEqual(names(resolveForm(b, V)), ['b', 'd', 'a', 'c']);
});

test('resolveForm: an active number absent from parameters_order is dropped', () => {
  const b = boot({ refs: { 1: f('a'), 2: f('b') }, order: { main: ['1'] } });
  assert.deepEqual(names(resolveForm(b, V)), ['a']);
});

test('resolveForm: a number in parameters_order that no satisfied rule names is dropped', () => {
  const b = boot({
    refs: { 1: f('a'), 2: f('b') },
    rules: [{ rule: {}, refs: ['1'] }],
    order: { main: ['1', '2'] },
  });
  assert.deepEqual(names(resolveForm(b, V)), ['a']);
});

test('resolveForm: a number named by a rule but absent from refs is skipped without an error', () => {
  const b = boot({
    refs: { 1: f('a') },
    rules: [{ rule: {}, refs: ['1', '99'] }],
    order: { main: ['99', '1'] },
  });
  assert.deepEqual(names(resolveForm(b, V)), ['a']);
});

test('resolveForm: ui_component null is dropped', () => {
  const b = boot({ refs: { 1: f('a', { ui_component: null }), 2: f('b') } });
  assert.deepEqual(names(resolveForm(b, V)), ['b']);
});

test('resolveForm: ui_component without type is dropped', () => {
  const b = boot({ refs: { 1: f('a', { ui_component: {} }), 2: f('b') } });
  assert.deepEqual(names(resolveForm(b, V)), ['b']);
});

const NOT_FOR_FORM = [
  'parent_category', 'category', 'currency', 'halva', 'halva_months', 'name', 'contact_person', 'import_link',
  'shop_address', 'shop_manufacturer_country', 'company_number', 'egr_status', 'commercial_register_id', 'domestic_register_id',
];
for (const name of NOT_FOR_FORM) {
  test(`resolveForm: field ${name} is dropped even with a ui type`, () => {
    const b = boot({ refs: { 1: f(name, { ui_component: ui('input') }), 2: f('keep') } });
    assert.deepEqual(names(resolveForm(b, V)), ['keep']);
  });
}

// conditions
const ruled = (rule) => boot({
  refs: { 1: f('base'), 2: f('cond') },
  rules: [{ rule: {}, refs: ['1'] }, { rule, refs: ['2'] }],
});

test('condition exact value: match', () => {
  assert.deepEqual(names(resolveForm(ruled({ kind: '6' }), { ...V, kind: '6' })), ['base', 'cond']);
});

test('condition exact value: mismatch', () => {
  assert.deepEqual(names(resolveForm(ruled({ kind: '6' }), { ...V, kind: '7' })), ['base']);
});

test('condition exact value: field absent from values', () => {
  assert.deepEqual(names(resolveForm(ruled({ kind: '6' }), V)), ['base']);
});

test('condition $in with spaces matches a listed value', () => {
  assert.deepEqual(names(resolveForm(ruled({ year: '$in[2040, 2075]' }), { ...V, year: '2075' })), ['base', 'cond']);
});

test('condition $in does not match a value that is only a prefix of a listed one', () => {
  assert.deepEqual(names(resolveForm(ruled({ year: '$in[2040, 2075]' }), { ...V, year: '20' })), ['base']);
});

test('condition $any holds when the field is set', () => {
  assert.deepEqual(names(resolveForm(ruled({ region: '$any' }), { ...V, region: '7' })), ['base', 'cond']);
});

test('condition $any fails when the field is absent', () => {
  assert.deepEqual(names(resolveForm(ruled({ region: '$any' }), V)), ['base']);
});

test('a rule with two conditions needs both: one of two is not enough', () => {
  const b = ruled({ a: '1', b: '2' });
  assert.deepEqual(names(resolveForm(b, { ...V, a: '1' })), ['base']);
  assert.deepEqual(names(resolveForm(b, { ...V, a: '1', b: '9' })), ['base']);
});

test('a rule with two conditions needs both: both hold', () => {
  assert.deepEqual(names(resolveForm(ruled({ a: '1', b: '2' }), { ...V, a: '1', b: '2' })), ['base', 'cond']);
});

test('the empty rule always holds', () => {
  assert.deepEqual(names(resolveForm(ruled({}), V)), ['base', 'cond']);
});

// one name, one field
const twoAreas = () => boot({
  refs: {
    1: f('area', { required: false, labels: { name: { ru: 'Plain' } } }),
    2: f('area', { required: true, labels: { name: { ru: 'Rich' } }, values: vals(['1', 'x']) }),
    3: f('other'),
  },
  rules: [{ rule: {}, refs: ['1', '3'] }, { rule: { region: '7' }, refs: ['2'] }],
  order: { main: ['3', '1', '2'] },
});

test('one name one field: the heavier description wins, at the place of the first appearance of the name', () => {
  const out = resolveForm(twoAreas(), { ...V, region: '7' });
  assert.deepEqual(names(out), ['other', 'area']);
  assert.equal(out[1].required, true);
  assert.deepEqual(out[1].values, [{ value: '1', label: 'x' }]);
});

test('one name one field: without the heavier rule the first description stays', () => {
  const out = resolveForm(twoAreas(), V);
  assert.deepEqual(names(out), ['other', 'area']);
  assert.equal(out[1].required, false);
  assert.equal(out[1].values, undefined);
});

test('one name one field: equal weights, the one whose rule stands later in rules wins', () => {
  const b = boot({
    refs: { 1: f('x', { labels: { name: { ru: 'Early' } } }), 2: f('x', { labels: { name: { ru: 'Late' } } }) },
    rules: [{ rule: { a: '1' }, refs: ['1'] }, { rule: { b: '2' }, refs: ['2'] }],
    order: { main: ['1', '2'] },
  });
  const out = resolveForm(b, { ...V, a: '1', b: '2' });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Late');
});

// kind
const kindOf = (over) => resolveForm(boot({ refs: { 1: f('k', over) } }), V)[0].kind;

test('kind external: external_values_url even with ui select', () => {
  assert.equal(kindOf({ ui_component: ui('select'), external_values_url: 'https://x.example/v' }), 'external');
});
test('kind external: ui select_search_external', () => {
  assert.equal(kindOf({ ui_component: ui('select_search_external') }), 'external');
});
test('kind choices: multi true with ui select', () => {
  assert.equal(kindOf({ multi: true, ui_component: ui('select') }), 'choices');
});
test('kind choices: ui multiselect_chips_or', () => {
  assert.equal(kindOf({ ui_component: ui('multiselect_chips_or') }), 'choices');
});
test('kind flag: checkbox', () => {
  assert.equal(kindOf({ type: 'bool', ui_component: ui('checkbox') }), 'flag');
});
for (const t of ['select', 'select_chips', 'select_search', 'radio_button']) {
  test(`kind choice: ui ${t}`, () => {
    assert.equal(kindOf({ ui_component: ui(t) }), 'choice');
  });
}
test('kind number: type int with ui input', () => {
  assert.equal(kindOf({ type: 'int', ui_component: ui('input') }), 'number');
});
test('kind number: type int with ui input_range', () => {
  assert.equal(kindOf({ type: 'int', ui_component: ui('input_range') }), 'number');
});
test('kind text: the rest', () => {
  assert.equal(kindOf({ type: 'string', ui_component: ui('input') }), 'text');
  assert.equal(kindOf({ type: 'string', ui_component: ui('textarea') }), 'text');
});

// shape
test('field shape: choice with values, all keys as in the contract', () => {
  const b = boot({
    refs: { 1: f('spares_type', { required: true, values: vals(['6', 'Для мототехники']) }) },
  });
  b.ad_metadata.parameters.rules.push({ rule: { spares_type: '6' }, refs: [] });
  assert.deepStrictEqual(resolveForm(b, V), [{
    name: 'spares_type', label: 'L-spares_type', required: true, kind: 'choice',
    values: [{ value: '6', label: 'Для мототехники' }], more: true,
  }]);
});

test('field shape: text without length and without more has exactly name, label, required, kind', () => {
  const b = boot({ refs: { 1: f('note', { ui_component: ui('input'), required: true }) } });
  assert.deepStrictEqual(resolveForm(b, V), [{ name: 'note', label: 'L-note', required: true, kind: 'text' }]);
});

test('field shape: label falls back to name', () => {
  const b = boot({ refs: { 1: f('bare', { labels: undefined, ui_component: ui('input') }) } });
  assert.equal(resolveForm(b, V)[0].label, 'bare');
});

test('field shape: a value label falls back to String(value)', () => {
  const b = boot({ refs: { 1: f('c', { values: [{ value: 'a' }, { value: 'b', labels: {} }] }) } });
  assert.deepStrictEqual(resolveForm(b, V)[0].values, [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]);
});

test('field shape: a numeric value comes out as a string', () => {
  const b = boot({ refs: { 1: f('c', { values: [{ value: 5, labels: { ru: 'Five' } }, { value: 6 }] }) } });
  assert.deepStrictEqual(resolveForm(b, V)[0].values, [{ value: '5', label: 'Five' }, { value: '6', label: '6' }]);
});

test('field shape: a flag has no values, min or max', () => {
  const b = boot({ refs: { 1: f('fl', { type: 'bool', ui_component: ui('checkbox'), values: vals(['1', 'x']) }) } });
  assert.deepStrictEqual(resolveForm(b, V), [{ name: 'fl', label: 'L-fl', required: false, kind: 'flag' }]);
});

test('field shape: no key holds undefined', () => {
  const b = boot({ refs: { 1: f('c', { values: [{ value: 1 }] }), 2: f('t', { ui_component: ui('input') }) } });
  for (const field of resolveForm(b, V)) {
    for (const [k, v] of Object.entries(field)) assert.notEqual(v, undefined, k);
  }
});

// long lists
const many = (n) => vals(...Array.from({ length: n }, (_, i) => [String(i), `V${i}`]));

test('more than 40 values: values_total and no values', () => {
  const out = resolveForm(boot({ refs: { 1: f('big', { values: many(41) }) } }), V)[0];
  assert.equal(out.values_total, 41);
  assert.equal('values' in out, false);
});

test('more than 40 values with full: all values and no values_total', () => {
  const out = resolveForm(boot({ refs: { 1: f('big', { values: many(41) }) } }), V, { full: true })[0];
  assert.equal(out.values.length, 41);
  assert.equal('values_total' in out, false);
});

test('exactly 40 values stay as values', () => {
  const out = resolveForm(boot({ refs: { 1: f('big', { values: many(40) }) } }), V)[0];
  assert.equal(out.values.length, 40);
  assert.equal('values_total' in out, false);
});

// min / max
const vlen = (args) => [{ name: 'v_length', args }];

test('text field: min and max come from v_length', () => {
  const b = boot({ refs: { 1: f('t', { ui_component: ui('input'), actions: vlen({ min: 5, max: 50 }) }) } });
  const out = resolveForm(b, V)[0];
  assert.equal(out.min, 5);
  assert.equal(out.max, 50);
});

test('text field without v_length has no min or max', () => {
  const b = boot({ refs: { 1: f('t', { ui_component: ui('input'), actions: [{ name: 'other', args: {} }] }) } });
  const out = resolveForm(b, V)[0];
  assert.equal('min' in out, false);
  assert.equal('max' in out, false);
});

test('non-text field with a v_length action has no min or max', () => {
  const b = boot({ refs: { 1: f('n', { type: 'int', ui_component: ui('input'), actions: vlen({ min: 1, max: 9 }) }) } });
  const out = resolveForm(b, V)[0];
  assert.equal(out.kind, 'number');
  assert.equal('min' in out, false);
  assert.equal('max' in out, false);
});

// more
test('more: true when the field name is a condition key of a satisfied rule', () => {
  const b = boot({
    refs: { 1: f('trigger'), 2: f('dep') },
    rules: [{ rule: {}, refs: ['1'] }, { rule: { trigger: '1' }, refs: ['2'] }],
  });
  const out = resolveForm(b, { ...V, trigger: '1' });
  assert.equal(out[0].more, true);
  assert.equal('more' in out[1], false);
});

test('more: true when the field name is a condition key of an unsatisfied rule', () => {
  const b = boot({
    refs: { 1: f('trigger'), 2: f('dep') },
    rules: [{ rule: {}, refs: ['1'] }, { rule: { trigger: '1' }, refs: ['2'] }],
  });
  const out = resolveForm(b, V);
  assert.deepEqual(names(out), ['trigger']);
  assert.equal(out[0].more, true);
});

test('more: the key is absent when no rule has the name as a condition key', () => {
  const b = boot({ refs: { 1: f('plain') } });
  assert.equal('more' in resolveForm(b, V)[0], false);
});

// findFormValues
const FIELDS = () => resolveForm(boot({
  refs: {
    1: f('brand', { values: vals(['1', 'Alpha Motor'], ['2', 'beta'], ['3', 'ALPHA two']) }),
    2: f('empty', { values: [] }),
    3: f('type', { values: vals(['9', 'alphabet']) }),
    4: f('note', { ui_component: ui('input') }),
  },
}), V, { full: true });

test('findFormValues: substring match without regard to case, in order of fields then values, with the record shape', () => {
  assert.deepStrictEqual(findFormValues(FIELDS(), 'ALPHA'), [
    { name: 'brand', label: 'L-brand', value: '1', text: 'Alpha Motor' },
    { name: 'brand', label: 'L-brand', value: '3', text: 'ALPHA two' },
    { name: 'type', label: 'L-type', value: '9', text: 'alphabet' },
  ]);
});

test('findFormValues: no match gives an empty list', () => {
  assert.deepStrictEqual(findFormValues(FIELDS(), 'zzz'), []);
});

test('findFormValues: limit cuts the list', () => {
  assert.equal(findFormValues(FIELDS(), 'alpha', 2).length, 2);
});

test('findFormValues: the default limit is 30', () => {
  const fields = resolveForm(boot({ refs: { 1: f('big', { values: many(50) }) } }), V, { full: true });
  assert.equal(findFormValues(fields, 'v').length, 30);
});

test('findFormValues: fields without values are skipped', () => {
  assert.deepStrictEqual(findFormValues(FIELDS(), 'L-'), []);
});

test('findFormValues: a value in a list longer than 40 is found from the full fields', () => {
  const fields = resolveForm(boot({ refs: { 1: f('big', { values: many(60) }) } }), V, { full: true });
  assert.deepStrictEqual(findFormValues(fields, 'V55'), [{ name: 'big', label: 'L-big', value: '55', text: 'V55' }]);
});

// ---- step 3d: typeField (imported inside the tests: the export does not exist yet) ----

const typeFieldOf = async () => (await import('../scripts/lib/form.mjs')).typeField;

test('typeField: returns name and url_name of the active description with is_type', async () => {
  const typeField = await typeFieldOf();
  const b = boot({ refs: { 1: f('a'), 2: f('kind', { is_type: true, url_name: 'knd' }) } });
  assert.deepEqual(typeField(b, V), { name: 'kind', url_name: 'knd' });
});

test('typeField: no active description with is_type -> null', async () => {
  const typeField = await typeFieldOf();
  const b = boot({ refs: { 1: f('a'), 2: f('b') } });
  assert.equal(typeField(b, V), null);
});

test('typeField: a description with is_type whose rule is not satisfied does not count', async () => {
  const typeField = await typeFieldOf();
  const b = boot({
    refs: { 1: f('a'), 2: f('kind', { is_type: true, url_name: 'knd' }) },
    rules: [{ rule: {}, refs: ['1'] }, { rule: { region: '7' }, refs: ['2'] }],
  });
  assert.equal(typeField(b, V), null);
  assert.deepEqual(typeField(b, { ...V, region: '7' }), { name: 'kind', url_name: 'knd' });
});

test('typeField: of several active descriptions the first in parameters_order wins', async () => {
  const typeField = await typeFieldOf();
  const b = boot({
    refs: { 1: f('first', { is_type: true, url_name: 'one' }), 2: f('second', { is_type: true, url_name: 'two' }) },
    order: { main: ['2', '1'] },
  });
  assert.deepEqual(typeField(b, V), { name: 'second', url_name: 'two' });
});

// Kufar cuts a published title at 50 characters, whatever length its form description allows (seen live 2026-11-17)
test('resolveForm: subject max is capped at 50 when the form allows more', () => {
  const b = boot({ refs: { 1: f('subject', { ui_component: ui('input'), actions: vlen({ min: 2, max: 100 }) }) } });
  const out = resolveForm(b, V)[0];
  assert.equal(out.min, 2);
  assert.equal(out.max, 50);
});

test('resolveForm: subject without v_length still gets max 50', () => {
  const b = boot({ refs: { 1: f('subject', { ui_component: ui('input') }) } });
  assert.equal(resolveForm(b, V)[0].max, 50);
});

test('resolveForm: subject with a smaller max keeps it, other text fields are not capped', () => {
  const b = boot({ refs: {
    1: f('subject', { ui_component: ui('input'), actions: vlen({ min: 2, max: 30 }) }),
    2: f('body', { ui_component: ui('text_area'), actions: vlen({ min: 20, max: 4000 }) }),
  } });
  const out = resolveForm(b, V);
  assert.equal(out[0].max, 30);
  assert.equal(out[1].max, 4000);
});
