import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { KufarError } from '../scripts/lib/errors.mjs';

export async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kufar-test-'));
}

export function checkErr(e, code) {
  assert.equal(e.name, 'KufarError');
  assert.equal(e.code, code);
  return true;
}
export const rejectsCode = (p, code) => assert.rejects(p, (e) => checkErr(e, code));
export const throwsCode = (fn, code) => assert.throws(fn, (e) => checkErr(e, code));

// JSON round trip drops undefined values
export const plain = (x) => JSON.parse(JSON.stringify(x));

export const RAW_AD = {
  ad_id: 1000000001,
  list_id: 1000000001,
  ad_link: 'https://www.kufar.by/item/1000000001',
  subject: 'iPhone 13 128 ГБ',
  body: null,
  body_short: null,
  price_byn: '62000',
  price_usd: '20683',
  currency: 'BYR',
  list_time: '2026-11-17T10:41:07Z',
  category: '17010',
  type: 'sell',
  company_ad: false,
  account_id: 'Ab3xVolatile',
  account_parameters: [{ p: 'name', pl: 'Имя', v: 'Тестовый Продавец', vl: '', pu: 'nme' }],
  ad_parameters: [
    { p: 'category', pl: 'Категория', v: 17010, vl: 'Мобильные телефоны', pu: 'cat' },
    { p: 'region', pl: 'Область', v: 7, vl: 'Минск', pu: 'rgn' },
    { p: 'area', pl: 'Район', v: '28', vl: 'Советский', pu: 'ar' },
    { p: 'phones_model', pl: 'Модель', v: 5380, vl: 'iPhone 13', pu: 'phm' },
    { p: 'phablet_phones_memory', pl: 'Встроенная память', v: 20, vl: '128 ГБ', pu: 'ppm' },
    { p: 'condition', pl: 'Состояние', v: 1, vl: 'Б/у', pu: 'cnd' },
    { p: 'delivery_enabled', pl: 'Куфар Доставка', v: true, vl: 'Да', pu: 'dle' },
    { p: 'safedeal_enabled', pl: 'Куфар Оплата', v: true, vl: 'Да', pu: 'sde' },
  ],
  images: [{ id: '0000', media_storage: 'rms', path: 'adim1/aaaa-bbbb.jpg', yams_storage: false }],
  phone_hidden: true,
  paid_services: { halva: false, highlight: false, polepos: false, ribbons: null },
};

export const EXPECTED_AD = {
  id: '1000000001',
  title: 'iPhone 13 128 ГБ',
  url: 'https://www.kufar.by/item/1000000001',
  price_byn: 620,
  price_usd: 206.83,
  listed_at: '2026-11-17T10:41:07Z',
  category: '17010',
  type: 'sell',
  company: false,
  seller: { name: 'Тестовый Продавец', unp: null },
  seller_key: 'Ab3xVolatile',
  region: 'Минск',
  area: 'Советский',
  condition: 'used',
  delivery: true,
  safedeal: true,
  images: ['https://rms.kufar.by/v1/gallery/adim1/aaaa-bbbb.jpg'],
  params: {
    phones_model: { label: 'Модель', value: '5380', text: 'iPhone 13', filter: 'phm' },
    phablet_phones_memory: { label: 'Встроенная память', value: '20', text: '128 ГБ', filter: 'ppm' },
    condition: { label: 'Состояние', value: '1', text: 'Б/у', filter: 'cnd' },
    delivery_enabled: { label: 'Куфар Доставка', value: 'true', text: 'Да', filter: 'dle' },
    safedeal_enabled: { label: 'Куфар Оплата', value: 'true', text: 'Да', filter: 'sde' },
  },
  body: null,
};

// fixed clock for every test that reaches the stale rule
export const NOW = Date.parse('2026-11-17T12:00:00Z');
export const DAY = 86_400_000;
export const daysAgo = (n, now = NOW) => new Date(now - n * DAY).toISOString();

// shared id clock: an ad numbered 2000000 - 1000 * n is n days old at NOW (ids of the other fixtures are far above it, so they stay new)
export const CLOCK = { id: 2000000, ms: NOW, per_day: 1000 };

export const rawAd = (over = {}) => ({ ...structuredClone(RAW_AD), ...over });

// raw ad with a phones_model parameter; price in BYN (null = no price)
export function rawAdOf({ id, price = 500, company = false, phm = 5380, title, type = 'sell', listTime }) {
  const raw = rawAd({
    ad_id: id,
    list_id: id,
    ad_link: `https://www.kufar.by/item/${id}`,
    subject: title ?? `Телефон ${id}`,
    price_byn: price == null ? null : String(Math.round(price * 100)),
    company_ad: company,
    account_id: `acc${id}`,
    type,
    ...(listTime ? { list_time: listTime } : {}),
  });
  if (phm === null) raw.ad_parameters = raw.ad_parameters.filter((p) => p.pu !== 'phm');
  else raw.ad_parameters.find((p) => p.pu === 'phm').v = phm;
  return raw;
}

export const series = (start, prices, over = {}) =>
  prices.map((p, i) => rawAdOf({ id: start + i, price: p, ...over }));

// normalized-looking ad for pure functions
export function mkAd(id, price, over = {}) {
  return {
    id: String(id),
    title: `Товар ${id}`,
    url: `https://www.kufar.by/item/${id}`,
    price_byn: price,
    type: 'sell',
    company: false,
    seller_key: `k${id}`,
    listed_at: '2026-11-17T10:00:00Z',
    flags: [],
    ...over,
  };
}

export function fakeTransport(handler) {
  const calls = [];
  return {
    calls,
    async getJson(p, query = {}) {
      calls.push({ path: p, query });
      return handler(p, query);
    },
  };
}

export const itemIdOf = (p) => p.match(/\/item\/(\d+)\/rendered/)?.[1] ?? null;
export const SEARCH_PATH = '/search-api/v2/search/rendered-paginated';
export const pageOf = (ads, total = ads.length, pages = []) => ({ ads, total, pagination: { pages } });

// ---- step 2: login token, raw account fixtures ----

const b64url = (s) => Buffer.from(s).toString('base64url');

// test token: header.payload.sig, exp in seconds; never a real secret
export const makeToken = (expSec, extra = {}) =>
  `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ exp: expSec, ...extra }))}.sig`;

// valid at NOW for 30 days
export const GOOD_EXP_SEC = Math.floor((NOW + 30 * DAY) / 1000);
export const goodToken = () => makeToken(GOOD_EXP_SEC);

// JSON of everything an error exposes to the user
export const errText = (e) => JSON.stringify({ message: e.message, details: e.details });

export const cookie = (name, value, domain) => ({ name, value, domain, path: '/' });

export const MY_AD_RAW = {
  ad_id: 1000000001, ad_status: 'active', subject: 'Катушка зажигания, новая',
  category: '2040', category_parent: '2000', currency: 'BYR',
  price_byn: '5900', price_usd: '1968', price_eur: '1788', remuneration_type: '1', type: 'sell',
  region: '7', area: '22', name: 'Тестовый Продавец', phone: '375290000000', email: 'seller@example.com',
  link: 'http://auto.kufar.by/vi/1000000001',
  thumbs: [{ image_id: '0', yams_storage: false, media_storage: 'rms', path: 'adim1/aaaa-bbbb.jpg' }],
  days_remain: '60', date: '2026-11-17T12:35:00Z', date_expired: '2027-01-16T12:35:00Z',
  flags: { bumped: false, company_ad: false, delivery_enabled: false, safedeal_enabled: false, phone_hidden: true, can_email: true, placement: false },
  permissions: { activate_perm: false, prolong_perm: false, delete_perm: false },
  statistics: { view: 12, phone: 1, mail: 2, favorite: 3 },
};

export const CONV_ID = '11111111-2222-4333-8444-555555555555';
export const CONV_RAW = {
  conversation_id: CONV_ID, client_conversation_id: 'client-1', type: 'common',
  ad_info: {
    id: 1000000001, subject: 'Катушка зажигания, новая', image_url: 'https://rms.kufar.by/v1/list_thumbs_2x/adim1/aaaa-bbbb.jpg',
    price_byn: '5900', price_eur: '1788', price_usd: '1968', currency: 'BYN', remuneration_type: '1',
    link: 'https://www.kufar.by/item/1000000001', status: 'active', show_price: true, is_mine: true,
  },
  participant_info: { id: 'a1bc2defghijklm_nopqr_3', name: 'Тестовый Покупатель', avatar_url: '', dark_mode_avatar_url: '' },
  unseen: 2,
  last_message: {
    id: 'cccccccc-1111-4222-8333-444444444444', is_mine: false, read: false, rejected: false, deleted: false,
    preview: 'Ещё актуально?', timestamp: '2026-11-17T12:40:00.123456Z', attachments_count: 0,
  },
  total_messages_count: 5, last_sequence_id: 5, integrations: [],
  is_blocked_participant: false, is_blocked_by_participant: false, marked_as_unread: false, is_blocked: false,
  is_open_profile_allowed: true, created_at: '2026-11-16T09:00:00.000000Z', updated_at: '2026-11-17T12:40:00.123456Z',
  show_request_fb_button: false,
};

export const MSG_TEXT_RAW = {
  message_id: 'aaaaaaaa-1111-4222-8333-444444444444', client_message_id: 'cm-1', type: 'text', text: 'Ещё актуально?',
  is_mine: false, read: true, rejected: false, deleted: false, created_at: '2026-11-17T12:40:00.123456Z', parameters: null,
};
export const MSG_ATTACH_RAW = {
  message_id: 'bbbbbbbb-1111-4222-8333-444444444444', client_message_id: 'cm-2', type: 'attachment', text: 'Фото вложением',
  is_mine: true, read: true, rejected: false, deleted: false, created_at: '2026-11-17T12:41:00.000000Z', parameters: null,
  attachments: [{
    id: 'dddddddd-1111-4222-8333-444444444444', type: 'image',
    parameters: { file_size: 1234567, file_name: 'IMG_0001.jpg', mime_type: 'image/jpeg', download_link: 'https://attachments.example/v1/SECRET-LINK' },
  }],
};

// ---- step 2: fake browser pipe (--remote-debugging-pipe): JSON messages, each followed by \0 ----

// writable = what the code under test writes to child.stdio[3]; readable = child.stdio[4]
export function pipeEnds(onMessage = () => {}) {
  const readable = new PassThrough();
  const chunks = [];
  const messages = [];
  let buf = '';
  const writable = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf8');
      chunks.push(text);
      buf += text;
      let i;
      while ((i = buf.indexOf('\0')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        messages.push(msg);
        onMessage(msg);
      }
      cb();
    },
  });
  // data may be an object (sent as JSON + \0), a string or a Buffer (sent as is)
  const push = (data) => {
    if (readable.writableEnded) return;
    readable.write(typeof data === 'object' && !Buffer.isBuffer(data) ? `${JSON.stringify(data)}\0` : data);
  };
  return { writable, readable, chunks, messages, push };
}

// a conn stand-in for readKufarToken / waitForLogin; responder(method, params, sessionId, n) returns the result or throws
export function fakeConn(responder) {
  const calls = [];
  const conn = {
    calls,
    closed: 0,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      return responder(method, params, sessionId, calls.length);
    },
    close() { conn.closed += 1; },
  };
  return conn;
}

// the browser side of a login: one page target, cookies per Network.getCookies call (the last list repeats)
export function kufarResponder({ cookiesSeq = [[]], targetInfos = [{ targetId: 'T1', type: 'page' }], failCookies, failDetach } = {}) {
  let n = 0;
  return (method) => {
    if (method === 'Target.getTargets') return { targetInfos };
    if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
    if (method === 'Network.getCookies') {
      if (failCookies) throw failCookies;
      return { cookies: cookiesSeq[Math.min(n++, cookiesSeq.length - 1)] };
    }
    if (method === 'Target.detachFromTarget') {
      if (failDetach) throw failDetach;
      return {};
    }
    return {};
  };
}

// fake child process of spawnImpl. handler(msg, proc) returns { result } | { error } | undefined (no answer).
// Browser.close is answered with {} by default and, with exitOnClose, ends the process.
// die() = browser gone: `exit` event, then the pipe ends.
export function fakeBrowserProcess({ handler = () => undefined, exitOnClose = true } = {}) {
  const proc = new EventEmitter();
  const ends = pipeEnds((msg) => {
    setImmediate(() => {
      if (proc.exited) return;
      let out = handler(msg, proc);
      if (out === undefined && msg.method === 'Browser.close') out = { result: {} };
      if (out?.error) ends.push({ id: msg.id, error: out.error });
      else if (out) ends.push({ id: msg.id, result: out.result ?? {} });
      if (msg.method === 'Browser.close' && exitOnClose) proc.die(0);
    });
  });
  proc.stdio = [null, null, null, ends.writable, ends.readable];
  proc.sent = ends.messages;
  proc.exited = false;
  proc.killed = 0;
  proc.die = (code = 0) => {
    if (proc.exited) return;
    proc.exited = true;
    proc.emit('exit', code, null);
    setImmediate(() => ends.readable.end());
  };
  // spawn failure: `error` event, the pipe is dead too; the process is reported gone a moment later,
  // so that a cleanup that waits for `exit` does not sit out its 5 seconds
  proc.fail = (err) => {
    proc.emit('error', err);
    setImmediate(() => ends.readable.end());
    setTimeout(() => proc.die(null), 20);
  };
  proc.kill = () => { proc.killed += 1; proc.die(null); };
  return proc;
}

// adapt a responder (throws on failure) to a fakeBrowserProcess handler
export const processHandler = (responder) => (msg) => {
  try {
    return { result: responder(msg.method, msg.params, msg.sessionId) };
  } catch {
    return { error: { code: -32000, message: 'fake failure' } };
  }
};

// manual clock: sleep advances now. The real pause of a few ms keeps a fake sleep from beating an event that
// is already on its way (a browser exiting after Browser.close), whatever the code under test waits with.
export function fakeClock(start = 0) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); t += ms; await new Promise((r) => setTimeout(r, 10)); },
  };
}

// security rule of the login window: the only cookie request is Network.getCookies with urls on kufar.by hosts
const COOKIE_HOSTS = new Set(['www.kufar.by', 'api.kufar.by']);
export function assertCookieRequestsSafe(messages) {
  for (const m of messages) {
    assert.ok(m.method !== 'Storage.getCookies', 'whole-browser cookie dump requested');
    assert.ok(m.method !== 'Network.getAllCookies', 'all cookies requested');
    if (m.method === 'Network.getCookies') {
      const urls = m.params?.urls;
      assert.ok(Array.isArray(urls) && urls.length > 0, 'Network.getCookies without urls');
      for (const u of urls) assert.ok(COOKIE_HOSTS.has(new URL(u).hostname), `foreign url ${u}`);
    }
  }
}

export const failure = (code = 'BROWSER_UNAVAILABLE') => new KufarError(code, 'fake failure');

// ---- login redesign: scripted browser polls, fake fetch, live-clock key ----

// one step per Target.getTargets call (the last step repeats):
// 'nopage' = no page target, 'page' = a page without k_jwt, 'token' = a page with k_jwt, an Error = the poll fails
export function pollResponder(steps, token) {
  let n = 0;
  return (method) => {
    if (method === 'Target.getTargets') {
      const step = steps[Math.min(n++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return { targetInfos: step === 'nopage' ? [{ targetId: 'B', type: 'browser' }] : [{ targetId: 'T1', type: 'page' }] };
    }
    if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
    if (method === 'Network.getCookies') {
      const step = steps[Math.min(n - 1, steps.length - 1)];
      return { cookies: step === 'token' ? [cookie('k_jwt', token, '.kufar.by')] : [] };
    }
    return {};
  };
}

// a key valid for 30 days on the real clock (logout and the CLI do not take a clock)
export const liveToken = () => makeToken(Math.floor(Date.now() / 1000) + 30 * 86400);

// a fetchImpl that records every call; responder(url, init, n) returns a Response (or throws)
export function fakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
export const jsonRes = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
export const emptyRes = (status) => new Response(null, { status });

// headers of a recorded call with lower-cased names, whatever form the code used
export const headersOf = (init) => Object.fromEntries(
  [...new Headers(init.headers ?? {}).entries()].map(([k, v]) => [k.toLowerCase(), v]),
);

export const assertNoSignoutAll = (calls) => {
  for (const c of calls) assert.ok(!c.url.includes('signout/all'), `request to ${c.url}`);
};
