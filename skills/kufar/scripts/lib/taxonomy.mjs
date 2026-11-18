import { KufarError } from './errors.mjs';

export function flattenCategories(tree) {
  const out = [];
  const walk = (list, parent) => {
    for (const c of list ?? []) {
      const name = c.name_ru ?? c.name;
      const item = { id: String(c.id), name, parent_id: parent ? parent.id : null, path: parent ? `${parent.path} / ${name}` : name };
      out.push(item);
      walk(c.subcategories, item);
    }
  };
  walk(tree?.categories, null);
  return out;
}

export function findCategories(tree, text) {
  const all = flattenCategories(tree);
  if (!text) return all;
  const t = text.toLowerCase();
  return all.filter((c) => String(c.name).toLowerCase().includes(t));
}

export function parentOf(tree, id) {
  const c = flattenCategories(tree).find((x) => x.id === String(id));
  if (!c) throw new KufarError('UNKNOWN_CATEGORY', 'Нет такой рубрики', { cat: id });
  return c.parent_id;
}

const refsOf = (metadata) => Object.values(metadata?.parameters?.refs ?? {});
const labelOf = (ref) => ref.labels?.name?.ru ?? ref.name;

export function listParams(metadata) {
  const byFilter = new Map();
  for (const ref of refsOf(metadata)) {
    let p = byFilter.get(ref.url_name);
    if (!p) {
      p = { name: ref.name, filter: ref.url_name, label: labelOf(ref), type: ref.type, values: new Set() };
      byFilter.set(ref.url_name, p);
    }
    for (const v of ref.values ?? []) p.values.add(String(v.value));
  }
  return [...byFilter.values()].map((p) => ({ ...p, values: p.values.size }));
}

export function findParamValues(metadata, text, limit = 30) {
  const t = String(text ?? '').toLowerCase();
  const seen = new Set();
  const found = [];
  for (const ref of refsOf(metadata)) {
    for (const v of ref.values ?? []) {
      const label = v.labels?.ru;
      // a word that names the filter itself («память») gives the values of that filter
      if (typeof label !== 'string' || !(label.toLowerCase().includes(t) || labelOf(ref).toLowerCase().includes(t))) continue;
      const key = `${ref.url_name}\u0000${v.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name: ref.name, filter: ref.url_name, label: labelOf(ref), value: String(v.value), text: label });
    }
  }
  const rank = (x) => {
    const l = x.text.toLowerCase();
    return l === t ? 0 : l.startsWith(t) ? 1 : l.includes(t) ? 2 : 3;
  };
  return found.sort((a, b) => rank(a) - rank(b) || (rank(a) < 3 ? a.text.length - b.text.length : 0)).slice(0, limit);
}

const NODE_KIND = { mark: 'Марка', model: 'Модель', generation: 'Поколение' };
const catalogValue = (n) => {
  const v = { name: n.params.name ?? null, filter: n.params.url_name, label: NODE_KIND[n.params.node_type] ?? n.params.node_type ?? null,
    value: n.value, text: n.labels.ru };
  if (n.params.startYears && n.params.endYears) v.years = `${n.params.startYears}-${n.params.endYears}`;
  return v;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cars: brand, model and generation are not in the description of filters. They are a catalogue read one level per request:
// the words name the brand, then the model, then the generation. A level the words do not name is listed whole.
export async function findCatalogValues(nodesOf, cat, text) {
  let rest = String(text ?? '').toLowerCase();
  const found = [];
  let tag = `category_${cat}`;
  for (let level = 0; level < 4; level += 1) {
    const nodes = (await nodesOf(tag) ?? []).filter((n) => typeof n?.value === 'string' && typeof n.labels?.ru === 'string'
      && typeof n.params?.url_name === 'string');
    let best = null;
    let at = -1;
    for (const n of nodes) {
      const label = n.labels.ru.toLowerCase();
      const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(label)}(?![\\p{L}\\p{N}])`, 'u').exec(rest);
      if (m && (!best || label.length > best.labels.ru.length)) { best = n; at = m.index; }
    }
    if (!best) {
      if (level > 0) found.push(...nodes.slice(0, 100).map(catalogValue));
      break;
    }
    found.push(catalogValue(best));
    rest = `${rest.slice(0, at)} ${rest.slice(at + best.labels.ru.length)}`;
    tag = best.value;
  }
  return found;
}
