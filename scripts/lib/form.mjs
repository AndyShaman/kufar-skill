import { KufarError } from './errors.mjs';

// set by the utility itself when posting, or not for a private seller
const SKIP = new Set(['parent_category', 'category', 'currency', 'halva', 'name', 'contact_person', 'import_link',
  'shop_address', 'shop_manufacturer_country', 'company_number']);
const SKIP_PREFIX = ['halva_', 'egr_', 'commercial_register_', 'domestic_register_'];
const CHOICE_UI = new Set(['select', 'select_chips', 'select_search', 'radio_button']);
const MAX_VALUES = 40;
const SUBJECT_MAX = 50;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function holds(cond, value) {
  if (value === undefined) return false;
  if (cond === '$any') return true;
  if (cond.startsWith('$in[') && cond.endsWith(']')) return cond.slice(4, -1).split(',').map((x) => x.trim()).includes(value);
  return cond === value;
}

function kindOf(ref) {
  const ui = ref.ui_component.type;
  if (ref.external_values_url || ui === 'select_search_external') return 'external';
  if (ref.multi === true || ui.startsWith('multiselect')) return 'choices';
  if (ui === 'checkbox') return 'flag';
  if (CHOICE_UI.has(ui)) return 'choice';
  return ref.type === 'int' ? 'number' : 'text';
}

function shape(ref, more, full) {
  const kind = kindOf(ref);
  const field = { name: ref.name, label: ref.labels?.name?.ru ?? ref.name, required: ref.required, kind };
  if ((kind === 'choice' || kind === 'choices') && ref.values?.length) {
    if (ref.values.length > MAX_VALUES && !full) field.values_total = ref.values.length;
    else field.values = ref.values.map((v) => ({ value: String(v.value), label: v.labels?.ru ?? String(v.value) }));
  }
  if (kind === 'text') {
    const len = ref.actions?.find((a) => a.name === 'v_length')?.args;
    if (typeof len?.min === 'number') field.min = len.min;
    if (typeof len?.max === 'number') field.max = len.max;
    // Kufar cuts a published title at 50 characters, though its form description allows 100
    if (ref.name === 'subject') field.max = Math.min(field.max ?? SUBJECT_MAX, SUBJECT_MAX);
  }
  if (more.has(ref.name)) field.more = true;
  return field;
}

const heavier = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

// steps 1, 2 and 3: the active numbers in the order of the form, each with [conditions, index] of its heaviest satisfied rule
function active(bootstrap, values) {
  const refs = bootstrap?.ad_metadata?.parameters?.refs;
  const rules = bootstrap?.ad_metadata?.parameters?.rules;
  const order = bootstrap?.ad_metadata?.parameters_order?.refs;
  if (!isObject(refs) || !Array.isArray(rules) || !isObject(order)) {
    throw new KufarError('BAD_RESPONSE', 'Куфар вернул описание формы в неожиданном виде');
  }
  // a later rule wins a tie
  const weight = new Map();
  const more = new Set();
  rules.forEach(({ rule = {}, refs: nums = [] }, i) => {
    const conds = Object.entries(rule);
    for (const [k] of conds) more.add(k);
    if (!conds.every(([k, c]) => holds(c, values[k]))) return;
    for (const n of nums) {
      const cur = weight.get(String(n));
      if (refs[n] && (!cur || !heavier(cur, [conds.length, i]))) weight.set(String(n), [conds.length, i]);
    }
  });
  const nums = Object.values(order).flat().map(String).filter((n) => weight.has(n));
  return { refs, weight, more, nums };
}

// step 5: name -> its heaviest number, in the order of first appearance
function heaviest(nums, refs, weight) {
  const best = new Map();
  for (const n of nums) {
    const cur = best.get(refs[n].name);
    if (cur === undefined || heavier(weight.get(n), weight.get(cur))) best.set(refs[n].name, n);
  }
  return best;
}

export function resolveForm(bootstrap, values, { full = false } = {}) {
  const { refs, weight, more, nums } = active(bootstrap, values);
  const shown = nums.filter((n) => refs[n].ui_component?.type
    && !SKIP.has(refs[n].name) && !SKIP_PREFIX.some((p) => refs[n].name.startsWith(p)));
  return [...heaviest(shown, refs, weight).values()].map((n) => shape(refs[n], more, full));
}

export function typeField(bootstrap, values) {
  const { refs, weight, nums } = active(bootstrap, values);
  const n = [...heaviest(nums, refs, weight).values()].find((x) => refs[x].is_type === true);
  return n === undefined ? null : { name: refs[n].name, url_name: refs[n].url_name };
}

export function findFormValues(fields, text, limit = 30) {
  const t = text.toLowerCase();
  const found = [];
  for (const field of fields) {
    for (const v of field.values ?? []) {
      if (v.label.toLowerCase().includes(t)) found.push({ name: field.name, label: field.label, value: v.value, text: v.label });
    }
  }
  return found.slice(0, limit);
}
