import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { KufarError } from './lib/errors.mjs';
import { resolveStateDir, cached } from './lib/storage.mjs';
import { createTransport } from './lib/transport.mjs';
import { fetchAd } from './lib/ads.mjs';
import { findCategories, flattenCategories, parentOf, listParams, findParamValues } from './lib/taxonomy.mjs';
import { buildSearchQuery, search, flagAds } from './lib/search.mjs';
import { loadClock } from './lib/clock.mjs';
import { estimatePrice } from './lib/price.mjs';
import {
  watchAdd, watchCheck, watchList, watchRemove, trackAdd, trackCheck, trackList, trackRemove,
} from './lib/watch.mjs';
import { saveToken, loadToken, authStatus, logout, sweepIdleKey, idleError } from './lib/auth.mjs';
import { startLogin, runLoginWorker, loginWindowStatus, stopLoginWindow, sweepLoginProfiles } from './lib/browser.mjs';
import { requestCode, confirmCode } from './lib/codelogin.mjs';
import { myListings, inbox, chat, sendTarget } from './lib/account.mjs';
import { checkText, hasKey, confirmCode as previewCode, sendMessage } from './lib/chatsend.mjs';
import { UUID_RE } from './lib/transport.mjs';
import { resolveForm, findFormValues, typeField } from './lib/form.mjs';
import { SERVICE_KEYS, buildAd, maskContact, maskEmail, photoInfo, postCode, submitAd } from './lib/post.mjs';
import { editSupport, editUnsupported, buildEdit, editCode, submitEdit } from './lib/edit.mjs';

const DAY = 24 * 60 * 60 * 1000;
const bad = (message, details) => new KufarError('BAD_ARGS', message, details);

const FILTER_OPTIONS = {
  cat: { type: 'string' },
  query: { type: 'string' },
  param: { type: 'string', multiple: true },
  region: { type: 'string', multiple: true },
  'price-min': { type: 'string' },
  'price-max': { type: 'string' },
  condition: { type: 'string' },
  seller: { type: 'string' },
  delivery: { type: 'boolean' },
};
const SEARCH_OPTIONS = { ...FILTER_OPTIONS, sort: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } };
const PRICE_OPTIONS = {
  cat: { type: 'string' },
  query: { type: 'string' },
  param: { type: 'string', multiple: true },
  region: { type: 'string', multiple: true },
  like: { type: 'string' },
  by: { type: 'string' },
  exclude: { type: 'string' },
  include: { type: 'string' },
};

function parse(args, options, positionals = 0) {
  let r;
  try {
    r = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw bad(`Неверные аргументы: ${e.message}`);
  }
  if (r.positionals.length !== positionals) {
    throw bad(positionals ? `Нужен ровно один аргумент без опции` : `Лишние аргументы: ${r.positionals.join(' ')}`);
  }
  return { values: r.values, arg: r.positionals[0] };
}

function num(v, flag) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n)) throw bad(`${flag} должно быть числом`, { [flag]: v });
  return n;
}

function parseParams(list) {
  if (!list) return undefined;
  const params = {};
  for (const item of list) {
    const i = item.indexOf('=');
    if (i === -1) throw bad('--param пишется как код=значение', { param: item });
    params[item.slice(0, i)] = item.slice(i + 1);
  }
  return params;
}

const PAGE_OPTIONS = { limit: { type: 'string' }, offset: { type: 'string' } };
const page = (v) => ({ limit: num(v.limit, '--limit'), offset: num(v.offset, '--offset') });

// one fixed hint for every bad login argument: an agent that wrote `login <key>` must not get the key back
const loginHint = () => new KufarError('BAD_ARGS',
  'login: без опций, --wait SEC, --phone НОМЕР, --code КОД или --token-stdin; ключ аргументом не передаётся');
const LOGIN_OPTIONS = { wait: { type: 'string' }, phone: { type: 'string' }, code: { type: 'string' }, 'token-stdin': { type: 'boolean' } };

function parseWait(v) {
  if (v === undefined) return 300;
  if (!/^\d+$/.test(v) || Number(v) < 30 || Number(v) > 900) throw loginHint();
  return Number(v);
}

async function readStdin(limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new KufarError('BAD_TOKEN', 'Это не похоже на ключ входа Куфара');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const clearLoginWindow = (stateDir) => fs.rm(path.join(stateDir, 'login-window.json'), { force: true });

async function login(args) {
  let r;
  try {
    r = parseArgs({ args, options: LOGIN_OPTIONS, allowPositionals: true, strict: true });
  } catch {
    throw loginHint();
  }
  const v = r.values;
  if (r.positionals.length || Object.keys(LOGIN_OPTIONS).filter((k) => v[k] !== undefined).length > 1) throw loginHint();
  const wait = parseWait(v.wait);
  const stateDir = resolveStateDir();
  if (v['token-stdin']) {
    const status = await saveToken(stateDir, await readStdin());
    await clearLoginWindow(stateDir);
    return status;
  }
  if (v.phone === undefined && v.code === undefined) return startLogin({ stateDir, waitMs: wait * 1000 });
  try {
    if (v.phone !== undefined) return await requestCode({ stateDir, phone: v.phone });
    const status = await confirmCode({ stateDir, code: v.code });
    await clearLoginWindow(stateDir);
    return status;
  } catch (e) {
    // only a bad phone or code is BAD_ARGS here
    if (e.code === 'BAD_ARGS') throw loginHint();
    throw e;
  }
}

// hidden command: holds the login window; prints nothing and always exits 0
async function loginWorker(args) {
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => ac.abort());
  try {
    const { values } = parseArgs({ args, options: { wait: { type: 'string' } }, strict: true });
    await runLoginWorker({ stateDir: resolveStateDir(), waitMs: parseWait(values.wait) * 1000, signal: ac.signal });
  } catch { /* nothing to print to */ }
  process.exit(0);
}

const csv = (v) => (v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean));

function filterOpts(v) {
  return {
    cat: v.cat,
    query: v.query,
    params: parseParams(v.param),
    regions: v.region,
    priceMin: num(v['price-min'], '--price-min'),
    priceMax: num(v['price-max'], '--price-max'),
    condition: v.condition,
    seller: v.seller,
    delivery: v.delivery,
  };
}

// set by the idle check at the start of run(): the key was removed in this very run
let idleRemoved = false;

function getCtx() {
  const stateDir = resolveStateDir();
  const now = Date.now;
  const getToken = () => (idleRemoved ? Promise.reject(idleError()) : loadToken(stateDir, now));
  return { stateDir, transport: createTransport({ stateDir, getToken }), now, getToken };
}

async function sweepIdle() {
  try {
    return await sweepIdleKey(resolveStateDir());
  } catch {
    return false;
  }
}

async function getClockCtx() {
  const ctx = getCtx();
  return { ...ctx, clock: await loadClock(ctx) };
}

const SEND_NEXT = 'Покажите пользователю, кому и что уходит. После его согласия повторите команду с тем же текстом и --confirm <код>';

async function send(args) {
  const { values, arg: id } = parse(args, { text: { type: 'string' }, confirm: { type: 'string' } }, 1);
  if (!UUID_RE.test(id)) throw bad('Нужен номер диалога (id из inbox)');
  if (values.text === undefined) throw bad('Нужен текст: --text "<текст>"');
  if (values.confirm !== undefined && !/^[0-9a-f]{12}$/.test(values.confirm)) throw bad('--confirm: код из 12 знаков 0-9a-f из предпросмотра');
  const ctx = getCtx();
  const token = await ctx.getToken();
  const text = checkText(values.text, token);
  const target = await sendTarget(ctx.transport, id);
  const code = previewCode(id, text);
  if (values.confirm === undefined) {
    return { sent: false, preview: { ...target, text, chars: text.length }, confirm: code, next: SEND_NEXT };
  }
  if (values.confirm !== code) {
    throw new KufarError('CONFIRM_MISMATCH', 'Диалог или текст не совпадают с предпросмотром. Покажите пользователю новый предпросмотр');
  }
  const { message_id, at } = await sendMessage({ token, conversationId: id, text });
  return { sent: true, conversation_id: id, to: target.to, message_id, at };
}

const categoryTree = (ctx) => cached(path.join(ctx.stateDir, 'cache', 'category-tree.json'), DAY,
  () => ctx.transport.getJson('/category-tree/v1/category_tree'));

async function formBootstrap(ctx, tree, cat) {
  const parent = parentOf(tree, cat);
  if (!parent) throw bad('Нужна подрубрика: найдите её командой categories --find');
  return cached(path.join(ctx.stateDir, 'cache', `form-${cat}.json`), DAY,
    () => ctx.transport.getJson('/insertion/v1/meta/bootstrap', {
      application: 'ad_insertion', platform: 'web', routing: 'web_ad_insertion', parent, category: cat,
      company_ad: '0', 'taxonomy-version': '2',
    }));
}

const FORM_NEXT = 'Поля с more: true открывают другие поля: повторите команду с --set имя=значение. '
  + 'Длинные списки значений ищите через --find';
const SETTABLE = new Set(['choice', 'choices', 'flag', 'external']);

async function form(args) {
  const { values: v } = parse(args, { cat: { type: 'string' }, set: { type: 'string', multiple: true }, find: { type: 'string' } });
  // cat also names the cache file, so only digits
  if (!/^\d+$/.test(v.cat ?? '')) throw bad('Нужна рубрика: --cat <номер>');
  const set = {};
  for (const item of v.set ?? []) {
    const i = item.indexOf('=');
    if (i < 1) throw bad('--set пишется как имя=значение', { set: item });
    const name = item.slice(0, i);
    if (name === 'category' || name === 'company_ad') throw bad(`--set ${name} ставит сама утилита`, { name });
    set[name] = item.slice(i + 1);
  }
  if (v.find === '') throw bad('--find: нужен текст');
  const ctx = getCtx();
  const cat = v.cat;
  const bootstrap = await formBootstrap(ctx, await categoryTree(ctx), cat);
  const values = { category: cat, company_ad: '0', ...set };
  const all = resolveForm(bootstrap, values, { full: true });
  for (const [name, value] of Object.entries(set)) {
    const field = all.find((x) => x.name === name);
    const ok = field && SETTABLE.has(field.kind)
      && (field.kind !== 'flag' || value === '0' || value === '1')
      && (!field.values || field.values.some((x) => x.value === value));
    if (!ok) throw bad('Такого поля или значения в форме этой рубрики нет', { name });
  }
  if (v.find !== undefined) return { cat, values: findFormValues(all, v.find) };
  return { cat, set, fields: resolveForm(bootstrap, values), next: FORM_NEXT };
}

const POST_NEXT = 'Покажите пользователю объявление целиком. После его согласия повторите команду с тем же черновиком и --confirm <код>';
const POST_NOTE = 'Куфар принял объявление. Платные услуги утилита не подключала. Статус смотрите командой my';
const PENDING_NOTE = 'Куфар принял объявление, но бесплатный лимит рубрики исчерпан: оно ждёт оплаты и не опубликовано '
  + '(my --status pending_slot). Платить не обязательно: его можно удалить на сайте';
const TERMS = { currency: 'BYN', delivery: false, safe_deal: false, instalments: false, promotion: false };
const draftInvalid = (fields) => new KufarError('DRAFT_INVALID', 'В черновике ошибки', { fields });

async function readDraft(file) {
  let draft;
  try {
    draft = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { /* the text of the file is not repeated */ }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw bad('Черновик: файл JSON с одним объектом');
  if (draft.category === undefined) throw draftInvalid({ category: 'required' });
  // category also names the cache file, so only digits
  if (typeof draft.category !== 'string' || !/^\d+$/.test(draft.category)) throw draftInvalid({ category: 'bad_value' });
  return draft;
}

function previewField(field, value) {
  const label = (x) => field.values?.find((y) => y.value === x)?.label ?? x;
  const text = field.kind === 'flag' ? 'да' : Array.isArray(value) ? value.map(label).join(', ') : label(value);
  return { name: field.name, label: field.label, value, text };
}

async function post(args) {
  const { values: v } = parse(args, { draft: { type: 'string' }, confirm: { type: 'string' } });
  if (v.draft === undefined) throw bad('Нужен черновик: --draft <файл.json>');
  if (v.confirm !== undefined && !/^[0-9a-f]{12}$/.test(v.confirm)) throw bad('--confirm: код из 12 знаков 0-9a-f из предпросмотра');
  const draft = await readDraft(v.draft);
  const ctx = getCtx();
  const token = await ctx.getToken();

  const tree = await categoryTree(ctx);
  const bootstrap = await formBootstrap(ctx, tree, draft.category);
  const strings = Object.entries(draft).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, x.trim()]);
  const values = { ...Object.fromEntries(strings), category: draft.category, company_ad: '0' };
  const fields = resolveForm(bootstrap, values, { full: true });

  const contact = { name: draft.name, phone: draft.phone, email: draft.email };
  if (Object.values(contact).includes(undefined)) {
    const items = await ctx.transport.getJson('/my-items-v2/v2/items', { status: 'active', limit: 1, offset: 0, stats: 1 });
    const first = items?.ads?.[0];
    for (const k of Object.keys(contact)) {
      if (contact[k] === undefined && typeof first?.[k] === 'string' && first[k]) contact[k] = first[k];
    }
  }

  const { ad, photos: files } = buildAd({ draft, fields, type: typeField(bootstrap, values), contact });
  if (Object.values(ad).flat().some((x) => typeof x === 'string' && hasKey(x, token))) {
    throw new KufarError('TEXT_HAS_KEY', 'В объявлении есть ключ входа. Такое объявление утилита не подаёт');
  }
  const photos = await photoInfo(files);
  const code = postCode(ad, photos);

  if (v.confirm === undefined) {
    const shown = fields.filter((f) => !SERVICE_KEYS.has(f.name) && f.name !== 'subject' && f.name !== 'body' && ad[f.name] !== undefined);
    return {
      posted: false,
      preview: {
        category: { id: ad.category, name: flattenCategories(tree).find((c) => c.id === ad.category)?.name },
        subject: ad.subject,
        body: ad.body,
        price_byn: Number(ad.price) / 100,
        fields: shown.map((f) => previewField(f, ad[f.name])),
        photos: photos.map((p) => ({ file: p.file, bytes: p.bytes })),
        contact: maskContact(ad),
        terms: TERMS,
      },
      confirm: code,
      next: POST_NEXT,
    };
  }
  if (v.confirm !== code) {
    throw new KufarError('CONFIRM_MISMATCH', 'Объявление или фото не совпадают с предпросмотром. Покажите пользователю новый предпросмотр');
  }
  const r = await submitAd({ stateDir: ctx.stateDir, code, ad, photos, token });
  return { posted: true, ad_id: r.ad_id, pending_slot: r.pending_slot, note: r.pending_slot ? PENDING_NOTE : POST_NOTE };
}

const EDIT_NEXT = 'Покажите пользователю, что изменится. После его согласия повторите команду с тем же файлом и --confirm <код>';
const EDIT_NOTE = 'Куфар принял правку. Изменения проверяет модератор, до конца проверки покупатели видят прежнюю версию. '
  + 'Сверьте позже командой item';
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const trimmed = (obj) => Object.fromEntries(Object.entries(obj).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, x.trim()]));

async function edit(args) {
  const { values: v, arg: id } = parse(args, { changes: { type: 'string' }, confirm: { type: 'string' } }, 1);
  if (!/^\d+$/.test(id)) throw bad('Нужен номер своего объявления (id из my)');
  if (v.changes === undefined) throw bad('Нужен файл изменений: --changes <файл.json>');
  if (v.confirm !== undefined && !/^[0-9a-f]{12}$/.test(v.confirm)) throw bad('--confirm: код из 12 знаков 0-9a-f из предпросмотра');
  let changes;
  try {
    changes = JSON.parse(await fs.readFile(v.changes, 'utf8'));
  } catch { /* the text of the file is not repeated */ }
  if (!isObject(changes) || !Object.keys(changes).length) throw bad('Изменения: файл JSON с одним непустым объектом');
  const ctx = getCtx();
  const token = await ctx.getToken();

  const saved = (await ctx.transport.getJson(`/insertion/v1/processing/load/${id}`))?.result;
  if (!isObject(saved) || typeof saved.category !== 'string' || !/^\d+$/.test(saved.category)) {
    throw new KufarError('BAD_RESPONSE', 'Куфар вернул объявление в неожиданном виде');
  }
  const reason = editSupport(saved);
  if (reason) throw editUnsupported({ reason });

  const tree = await categoryTree(ctx);
  const bootstrap = await formBootstrap(ctx, tree, saved.category);
  const fixed = { category: saved.category, company_ad: '0' };
  const savedValues = { ...trimmed(saved), ...fixed };
  const values = { ...trimmed(saved), ...trimmed(changes), ...fixed };
  const fields = resolveForm(bootstrap, values, { full: true });
  const savedFields = resolveForm(bootstrap, savedValues, { full: true });

  let { email } = changes;
  if (email === undefined) {
    const items = await ctx.transport.getJson('/my-items-v2/v2/items', { status: 'active', limit: 1, offset: 0, stats: 1 });
    email = items?.ads?.[0]?.email;
  }

  const { ad, photos: list, changed } = buildEdit({ saved, changes, fields, savedFields, type: typeField(bootstrap, values), email });
  if (Object.values(ad).flat().some((x) => typeof x === 'string' && hasKey(x, token))) {
    throw new KufarError('TEXT_HAS_KEY', 'В объявлении есть ключ входа. Такое объявление утилита не подаёт');
  }
  // photoInfo counts only the new files; the index in its error is the place in the changes file
  const at = list.flatMap((p, i) => (p.file ? [i] : []));
  let info;
  try {
    info = await photoInfo(at.map((i) => list[i].file));
  } catch (e) {
    if (e.code === 'DRAFT_INVALID') e.details.index = at[e.details.index];
    throw e;
  }
  const photos = list.map((p, i) => (p.file ? info[at.indexOf(i)] : p));
  const code = editCode(id, ad, photos.map((p) => p.path ?? p.sha256));

  if (v.confirm === undefined) {
    const images = (Array.isArray(saved.images) ? saved.images : []).filter((i) => typeof i?.path === 'string');
    const all = [...fields, ...savedFields];
    const shown = (f, x) => (x === null ? null : previewField(f, x).text);
    const rubles = (x) => (x === null ? null : Number(x) / 100);
    return {
      edited: false,
      preview: {
        id,
        category: { id: ad.category, name: flattenCategories(tree).find((c) => c.id === ad.category)?.name },
        changes: changed.map((c) => {
          if (c.name === 'price') return { name: c.name, label: 'Цена', from: rubles(c.from), to: rubles(c.to) };
          if (c.name === 'photos') return { name: c.name, label: 'Фото', from: c.from, to: c.to };
          const f = all.find((x) => x.name === c.name);
          return { name: c.name, label: f.label, from: shown(f, c.from), to: shown(f, c.to) };
        }),
        subject: ad.subject,
        body: ad.body,
        ...(ad.currency === 'BYR' && ad.price !== undefined ? { price_byn: Number(ad.price) / 100 } : {}),
        photos: photos.map((p) => (p.path
          ? { current: images.findIndex((x) => x.path === p.path) + 1, url: `https://rms.kufar.by/v1/gallery/${p.path}` }
          : { file: p.file, bytes: p.bytes })),
        email: maskEmail(ad.email),
      },
      confirm: code,
      next: EDIT_NEXT,
    };
  }
  if (v.confirm !== code) {
    throw new KufarError('CONFIRM_MISMATCH', 'Правка или фото не совпадают с предпросмотром. Покажите пользователю новый предпросмотр');
  }
  await submitEdit({ token, id, ad, photos });
  return { edited: true, id, note: EDIT_NOTE };
}

async function run(argv) {
  const [cmd, ...rest] = argv;
  // logout revokes the key on Kufar itself, an idle one included
  if (cmd !== 'logout') idleRemoved = await sweepIdle();
  switch (cmd) {
    case 'categories': {
      const { values } = parse(rest, { find: { type: 'string' } });
      return { categories: findCategories(await categoryTree(getCtx()), values.find) };
    }
    case 'params': {
      const { values } = parse(rest, { cat: { type: 'string' }, find: { type: 'string' } });
      // cat also names the cache file, so only digits
      if (!/^\d+$/.test(values.cat ?? '')) throw bad('Нужна рубрика: --cat <номер>');
      const ctx = getCtx();
      const cat = values.cat;
      const parent = parentOf(await categoryTree(ctx), cat) ?? cat;
      const taxonomy = await cached(path.join(ctx.stateDir, 'cache', `taxonomy-${cat}.json`), DAY,
        () => ctx.transport.getJson('/taxonomy-proxy/v1/dispatch', {
          routing: 'web_generalist', parent, category: cat, application: 'ad_listing', platform: 'web',
        }));
      return values.find === undefined
        ? { cat, params: listParams(taxonomy.metadata) }
        : { cat, values: findParamValues(taxonomy.metadata, values.find) };
    }
    case 'search': {
      const { values } = parse(rest, SEARCH_OPTIONS);
      const opts = { ...filterOpts(values), sort: values.sort, limit: num(values.limit, '--limit'), cursor: values.cursor };
      buildSearchQuery(opts);
      const ctx = await getClockCtx();
      const r = await search(ctx.transport, opts, { now: ctx.now, clock: ctx.clock });
      return { total: r.total, count: r.ads.length, ads: r.ads, next_cursor: r.next_cursor };
    }
    case 'item': {
      const { arg } = parse(rest, {}, 1);
      const ctx = getCtx();
      const ad = await fetchAd(ctx.transport, arg);
      const clock = await loadClock(ctx);
      return { ad: flagAds([ad], ctx.now(), clock)[0] };
    }
    case 'price': {
      const { values: v } = parse(rest, PRICE_OPTIONS);
      const opts = {
        cat: v.cat, params: parseParams(v.param), query: v.query, regions: v.region,
        exclude: csv(v.exclude), include: csv(v.include), like: v.like, by: csv(v.by),
      };
      const ctx = await getClockCtx();
      return estimatePrice(ctx.transport, { ...opts, now: ctx.now, clock: ctx.clock });
    }
    case 'watch': {
      const [sub, ...args] = rest;
      if (sub === 'add') {
        const { values, arg } = parse(args, FILTER_OPTIONS, 1);
        const opts = filterOpts(values);
        return watchAdd(await getClockCtx(), arg, opts);
      }
      if (sub === 'check') {
        const { arg } = parse(args, {}, 1);
        return watchCheck(await getClockCtx(), arg);
      }
      if (sub === 'list') { parse(args, {}); return watchList(getCtx()); }
      if (sub === 'remove') return watchRemove(getCtx(), parse(args, {}, 1).arg);
      throw bad('watch: add, check, list или remove', { sub });
    }
    case 'track': {
      const [sub, ...args] = rest;
      if (sub === 'add') {
        const { values, arg } = parse(args, { note: { type: 'string' } }, 1);
        return trackAdd(getCtx(), arg, values.note);
      }
      if (sub === 'check') { parse(args, {}); return trackCheck(getCtx()); }
      if (sub === 'list') { parse(args, {}); return trackList(getCtx()); }
      if (sub === 'remove') return trackRemove(getCtx(), parse(args, {}, 1).arg);
      throw bad('track: add, check, list или remove', { sub });
    }
    case 'login':
      return login(rest);
    case 'logout': {
      parse(rest, {});
      const stateDir = resolveStateDir();
      await stopLoginWindow(stateDir);
      await sweepLoginProfiles(stateDir);
      return logout(stateDir);
    }
    case 'whoami': {
      parse(rest, {});
      const stateDir = resolveStateDir();
      const status = await authStatus(stateDir);
      // the path is for moving the key to a server; the content is never printed
      if (status.logged_in) return { ...status, auth_file: path.resolve(stateDir, 'auth.json') };
      const shown = idleRemoved ? { ...status, idle_removed: true } : status;
      const loginState = await loginWindowStatus(stateDir);
      return loginState ? { ...shown, login: loginState } : shown;
    }
    case 'my': {
      const { values } = parse(rest, { status: { type: 'string' }, ...PAGE_OPTIONS });
      return myListings(getCtx().transport, { status: values.status, ...page(values) });
    }
    case 'inbox': {
      const { values } = parse(rest, { unread: { type: 'boolean' }, ...PAGE_OPTIONS });
      return inbox(getCtx().transport, { unread: values.unread, ...page(values) });
    }
    case 'chat': {
      const { values, arg } = parse(rest, PAGE_OPTIONS, 1);
      return chat(getCtx().transport, arg, page(values));
    }
    case 'send':
      return send(rest);
    case 'form':
      return form(rest);
    case 'post':
      return post(rest);
    case 'edit':
      return edit(rest);
    default:
      throw bad('Команды: categories, params, search, item, price, form, post, edit, watch, track, login, logout, whoami, my, inbox, chat, send',
        { command: cmd ?? null });
  }
}

// rule 4: a word longer than 40 characters is hidden in a printed error, so a key passed by mistake to any command is not echoed
const HIDDEN = '<скрыто>';
const hide = (v) => {
  if (typeof v === 'string') return v.replace(/\S{41,}/gu, HIDDEN);
  if (Array.isArray(v)) return v.map(hide);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x)]));
  return v;
};

// the agent's sandbox may close the state dir to a command that is not run on its own
const STATE_BLOCKED = {
  code: 'STATE_BLOCKED',
  message: 'Нет доступа к папке состояния. Если чтение папки закрыто настройками агента, запустите утилиту отдельной командой, '
    + 'без |, cd, перенаправлений и переменных перед ней; login --token-stdin при таком запрете выполняет сам пользователь',
};

const print = (obj, done) => process.stdout.write(`${JSON.stringify(obj, (k, v) => (k === 'seller_key' ? undefined : v), 2)}\n`, done);

if (process.argv[2] === 'login-worker') await loginWorker(process.argv.slice(3));

// an open chat connection may keep the process alive for minutes, so send ends it once the answer is written
const done = process.argv[2] === 'send' ? () => process.exit(process.exitCode ?? 0) : undefined;

try {
  print(await run(process.argv.slice(2)), done);
} catch (e) {
  let error;
  if (e instanceof KufarError) error = { code: e.code, message: hide(e.message), details: hide(e.details) };
  else if (e?.code === 'EPERM' || e?.code === 'EACCES') error = STATE_BLOCKED;
  else error = { code: 'INTERNAL', message: hide(String(e?.message ?? e)) };
  process.exitCode = 1;
  print({ error }, done);
}
