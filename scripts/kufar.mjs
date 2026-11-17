import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { KufarError } from './lib/errors.mjs';
import { resolveStateDir, cached } from './lib/storage.mjs';
import { createTransport } from './lib/transport.mjs';
import { fetchAd } from './lib/ads.mjs';
import { findCategories, parentOf, listParams, findParamValues } from './lib/taxonomy.mjs';
import { buildSearchQuery, search, flagAds } from './lib/search.mjs';
import { loadClock } from './lib/clock.mjs';
import { estimatePrice } from './lib/price.mjs';
import {
  watchAdd, watchCheck, watchList, watchRemove, trackAdd, trackCheck, trackList, trackRemove,
} from './lib/watch.mjs';
import { saveToken, loadToken, authStatus, logout, sweepIdleKey, idleError } from './lib/auth.mjs';
import { startLogin, runLoginWorker, loginWindowStatus, stopLoginWindow, sweepLoginProfiles } from './lib/browser.mjs';
import { requestCode, confirmCode } from './lib/codelogin.mjs';
import { myListings, inbox, chat } from './lib/account.mjs';

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
  return { stateDir, transport: createTransport({ stateDir, getToken }), now };
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

const categoryTree = (ctx) => cached(path.join(ctx.stateDir, 'cache', 'category-tree.json'), DAY,
  () => ctx.transport.getJson('/category-tree/v1/category_tree'));

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
    default:
      throw bad('Команды: categories, params, search, item, price, watch, track, login, logout, whoami, my, inbox, chat',
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

const print = (obj) => process.stdout.write(`${JSON.stringify(obj, (k, v) => (k === 'seller_key' ? undefined : v), 2)}\n`);

if (process.argv[2] === 'login-worker') await loginWorker(process.argv.slice(3));

try {
  print(await run(process.argv.slice(2)));
} catch (e) {
  let error;
  if (e instanceof KufarError) error = { code: e.code, message: hide(e.message), details: hide(e.details) };
  else if (e?.code === 'EPERM' || e?.code === 'EACCES') error = STATE_BLOCKED;
  else error = { code: 'INTERNAL', message: hide(String(e?.message ?? e)) };
  print({ error });
  process.exitCode = 1;
}
