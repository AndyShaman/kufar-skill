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
      if (typeof label !== 'string' || !label.toLowerCase().includes(t)) continue;
      const key = `${ref.url_name}\u0000${v.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name: ref.name, filter: ref.url_name, label: labelOf(ref), value: String(v.value), text: label });
    }
  }
  const rank = (x) => {
    const l = x.text.toLowerCase();
    return l === t ? 0 : l.startsWith(t) ? 1 : 2;
  };
  return found.sort((a, b) => rank(a) - rank(b) || a.text.length - b.text.length).slice(0, limit);
}
