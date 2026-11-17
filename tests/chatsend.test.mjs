import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAX_TEXT, checkText, confirmCode, sendMessage } from '../scripts/lib/chatsend.mjs';
import { rejectsCode, throwsCode, errText, CONV_ID } from './helpers.mjs';

// made-up key: three parts, the second and the third are long enough to count alone
const P1 = 'eyJhbGciOiJub25lIn0';
const P2 = 'Zq8Lm2Xv5Rt9Wp3Yk6Nb';
const P3 = 'Hd4Gs7Jc1Fa0Ue8Ti2Ox';
const TOKEN = `${P1}.${P2}.${P3}`;
// key-shaped strings are put together from parts, so that secret scanners do not take a made-up one for a real key
const SHAPED = [P1, 'eyJleHAiOjE3NjAwMDAwMDB9', 'abcdefghij1234'].join('.');
const SHORT_TAIL = [P1, 'eyJleHAiOjE3NjAwMDAwMDB9', 'abc'].join('.');

// ---- checkText ----

test('MAX_TEXT is 4096', () => {
  assert.equal(MAX_TEXT, 4096);
});

test('checkText: not a string, empty or blank is BAD_ARGS', () => {
  for (const t of [undefined, null, 5, {}, [], '', '   ', '\n\t ']) {
    throwsCode(() => checkText(t, TOKEN), 'BAD_ARGS');
  }
});

test('checkText: longer than MAX_TEXT after trim is BAD_ARGS, exactly MAX_TEXT passes', () => {
  throwsCode(() => checkText('a'.repeat(MAX_TEXT + 1), TOKEN), 'BAD_ARGS');
  throwsCode(() => checkText(`  ${'a'.repeat(MAX_TEXT + 1)}  `, TOKEN), 'BAD_ARGS');
  assert.equal(checkText('a'.repeat(MAX_TEXT), TOKEN), 'a'.repeat(MAX_TEXT));
  assert.equal(checkText(` ${'a'.repeat(MAX_TEXT)} \n`, TOKEN), 'a'.repeat(MAX_TEXT));
});

test('checkText: BAD_ARGS message does not repeat the text', () => {
  const text = 'secretword '.repeat(500);
  try {
    checkText(text, TOKEN);
    assert.fail('no error');
  } catch (e) {
    assert.equal(e.code, 'BAD_ARGS');
    assert.ok(!errText(e).includes('secretword'));
  }
});

test('checkText: the text is returned without spaces at the edges', () => {
  assert.equal(checkText('  Здравствуйте!\n', TOKEN), 'Здравствуйте!');
  assert.equal(checkText('Да,  актуально', TOKEN), 'Да,  актуально');
});

test('checkText: an ordinary text with the key given passes, also without a key', () => {
  assert.equal(checkText('Добрый день, ещё продаёте?', TOKEN), 'Добрый день, ещё продаёте?');
  assert.equal(checkText('Добрый день', undefined), 'Добрый день');
  assert.equal(checkText('Добрый день', ''), 'Добрый день');
});

test('checkText: a key-shaped string is TEXT_HAS_KEY, with or without a saved key', () => {
  const shaped = SHAPED;
  throwsCode(() => checkText(`вот: ${shaped} держите`, TOKEN), 'TEXT_HAS_KEY');
  throwsCode(() => checkText(shaped, undefined), 'TEXT_HAS_KEY');
  throwsCode(() => checkText(shaped, ''), 'TEXT_HAS_KEY');
});

test('checkText: a key-shaped string with a part shorter than 10 characters is not the shape', () => {
  assert.equal(checkText(SHORT_TAIL, undefined), SHORT_TAIL);
});

test('checkText: the whole key is TEXT_HAS_KEY', () => {
  throwsCode(() => checkText(`мой ключ ${TOKEN}`, TOKEN), 'TEXT_HAS_KEY');
});

test('checkText: the whole key broken by spaces or line breaks is TEXT_HAS_KEY', () => {
  const spaced = TOKEN.match(/.{1,7}/g).join(' ');
  const lines = TOKEN.match(/.{1,9}/g).join('\n');
  const mixed = `${P1}\n.\t${P2} . ${P3}`;
  for (const t of [spaced, lines, mixed]) throwsCode(() => checkText(t, TOKEN), 'TEXT_HAS_KEY');
});

test('checkText: the second part of the key alone is TEXT_HAS_KEY, also broken by spaces', () => {
  throwsCode(() => checkText(`часть ${P2}`, TOKEN), 'TEXT_HAS_KEY');
  throwsCode(() => checkText(P2.match(/.{1,5}/g).join(' '), TOKEN), 'TEXT_HAS_KEY');
});

test('checkText: the third part of the key alone is TEXT_HAS_KEY, also broken by line breaks', () => {
  throwsCode(() => checkText(`часть ${P3}`, TOKEN), 'TEXT_HAS_KEY');
  throwsCode(() => checkText(P3.match(/.{1,5}/g).join('\n'), TOKEN), 'TEXT_HAS_KEY');
});

test('checkText: a part shorter than 20 characters does not count', () => {
  const short = `${P1}.${P2.slice(0, 19)}.${P3.slice(0, 19)}`;
  assert.equal(P2.slice(0, 19).length, 19);
  assert.equal(checkText(`часть ${P2.slice(0, 19)}`, short), `часть ${P2.slice(0, 19)}`);
  assert.equal(checkText(`часть ${P3.slice(0, 19)}`, short), `часть ${P3.slice(0, 19)}`);
});

test('checkText: the first part alone does not count', () => {
  assert.equal(checkText(`часть ${P1}`, TOKEN), `часть ${P1}`);
});

test('checkText: TEXT_HAS_KEY repeats neither the text nor the key', () => {
  const texts = [`вот ${TOKEN} конец`, `вот ${P2} конец`, `уникальныйхвост ${SHAPED}`];
  for (const t of texts) {
    try {
      checkText(t, TOKEN);
      assert.fail('no error');
    } catch (e) {
      assert.equal(e.code, 'TEXT_HAS_KEY');
      const shown = errText(e);
      for (const piece of [P1, P2, P3, 'вот', 'конец', 'уникальныйхвост', 'eyJleHAi']) assert.ok(!shown.includes(piece), piece);
    }
  }
});

// ---- confirmCode ----

const expectedCode = (id, text) => createHash('sha256').update(`${id.toLowerCase()}\n${text}`).digest('hex').slice(0, 12);

test('confirmCode: 12 characters of 0-9a-f', () => {
  assert.match(confirmCode(CONV_ID, 'Привет'), /^[0-9a-f]{12}$/);
});

test('confirmCode: first 12 hex characters of sha256(lower-case id + newline + text)', () => {
  assert.equal(confirmCode(CONV_ID, 'Привет, всё в силе'), expectedCode(CONV_ID, 'Привет, всё в силе'));
});

test('confirmCode: the id is lower-cased', () => {
  const id = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  assert.equal(confirmCode(id, 'Привет'), confirmCode(id.toLowerCase(), 'Привет'));
  assert.equal(confirmCode(id, 'Привет'), expectedCode(id.toLowerCase(), 'Привет'));
});

test('confirmCode: a different text or a different id gives a different code', () => {
  const base = confirmCode(CONV_ID, 'Привет');
  assert.notEqual(confirmCode(CONV_ID, 'Привет!'), base);
  assert.notEqual(confirmCode(CONV_ID.replace('1111', '9999'), 'Привет'), base);
});

// ---- sendMessage ----

const NO_KEY = (e) => {
  const shown = `${e.message} ${JSON.stringify(e.details ?? null)}`;
  for (const piece of [TOKEN, P2, P3, 'messaging-ws', 'wss://']) assert.ok(!shown.includes(piece), `leaked ${piece}: ${shown}`);
};

// a fake connection class; the test drives it by hand
function makeWS() {
  const instances = [];
  class FakeWS {
    constructor(...args) {
      this.args = args;
      this.url = args[0];
      this.sent = [];
      this.closed = 0;
      instances.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { this.closed += 1; }
  }
  return { FakeWS, instances };
}

// predictable uuids: ...0001, ...0002, ...
function fakeUuid() {
  let n = 0;
  const calls = [];
  const uuid = () => {
    n += 1;
    const v = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    calls.push(v);
    return v;
  };
  uuid.calls = calls;
  return uuid;
}

const tick = () => new Promise((r) => setImmediate(r));
const PENDING = Symbol('pending');
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const stillPending = async (s) => (await Promise.race([s, new Promise((r) => setTimeout(() => r(PENDING), 40))])) === PENDING;

async function start(opts = {}) {
  const { FakeWS, instances } = makeWS();
  const uuid = fakeUuid();
  const p = sendMessage({
    token: TOKEN, conversationId: CONV_ID, text: 'Привет', WebSocketImpl: FakeWS, uuid, timeoutMs: 2000, ...opts,
  });
  const s = settle(p);
  await tick();
  return { s, ws: instances[0], instances, uuid };
}

async function opened(opts) {
  const h = await start(opts);
  h.ws.onopen();
  await tick();
  return { ...h, frame: JSON.parse(h.ws.sent[0]) };
}

const reply = (frame, status, response) => JSON.stringify({
  request_id: frame.request_id, req_type: 'send_message', status, ...(response === undefined ? {} : { response }),
});

test('sendMessage: opens one connection with the address, no other constructor arguments', async () => {
  const { ws, instances, uuid, s } = await start();
  assert.equal(instances.length, 1);
  assert.equal(ws.args.length, 1);
  const url = new URL(ws.url);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.host, 'messaging-ws.kufar.by');
  assert.equal(url.pathname, '/v1/ws/');
  assert.equal(url.searchParams.get('token'), TOKEN);
  assert.equal(url.searchParams.get('X-App-Name'), 'Web Kufar');
  assert.ok(ws.url.includes('X-App-Name=Web%20Kufar'), ws.url);
  assert.equal(url.searchParams.get('X-Device-ID'), uuid.calls[0]);
  ws.onerror();
  await s;
});

test('sendMessage: nothing is sent before open', async () => {
  const { ws, s } = await start();
  assert.deepEqual(ws.sent, []);
  ws.onmessage({ data: JSON.stringify({ type: 'create_message' }) });
  await tick();
  assert.deepEqual(ws.sent, []);
  ws.onerror();
  await s;
});

test('sendMessage: after open exactly one send_message frame goes out', async () => {
  const { ws, frame, uuid, s } = await opened();
  assert.equal(ws.sent.length, 1);
  assert.equal(typeof ws.sent[0], 'string');
  assert.deepEqual(Object.keys(frame).sort(), ['payload', 'req_type', 'request_id']);
  assert.equal(frame.req_type, 'send_message');
  assert.deepEqual(frame.payload, {
    conversation_id: CONV_ID, client_message_id: frame.payload.client_message_id, text: 'Привет', type: 'text',
  });
  const ids = [frame.payload.client_message_id, frame.request_id];
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.ok(uuid.calls.slice(1).includes(id), `${id} is not from uuid()`);
  ws.onerror();
  await s;
});

test('sendMessage: success gives message_id and at', async () => {
  const { ws, frame, s } = await opened();
  ws.onmessage({ data: reply(frame, 'success', { message_id: 'mmm-1', client_message_id: frame.payload.client_message_id, message_ts: '2026-11-17T15:43:55.286878166Z', sequence_id: 0 }) });
  assert.deepEqual((await s).value, { message_id: 'mmm-1', at: '2026-11-17T15:43:55.286878166Z' });
});

test('sendMessage: success with missing fields gives nulls', async () => {
  for (const response of [{}, undefined, { message_id: 'm-2' }, { message_ts: 'T' }]) {
    const { ws, frame, s } = await opened();
    ws.onmessage({ data: reply(frame, 'success', response) });
    assert.deepEqual((await s).value, { message_id: response?.message_id ?? null, at: response?.message_ts ?? null });
  }
});

test('sendMessage: an error frame is SEND_FAILED with details.code', async () => {
  const { ws, frame, s } = await opened();
  ws.onmessage({ data: reply(frame, 'error', { code: 'rate_limited' }) });
  const { error } = await s;
  assert.equal(error.name, 'KufarError');
  assert.equal(error.code, 'SEND_FAILED');
  assert.deepEqual(error.details, { code: 'rate_limited' });
  NO_KEY(error);
});

test('sendMessage: details.code only for a string of up to 40 characters', async () => {
  const cases = [['x'.repeat(40), true], ['x'.repeat(41), false], [123, false], [null, false], [undefined, false], [{ a: 1 }, false]];
  for (const [code, kept] of cases) {
    const { ws, frame, s } = await opened();
    ws.onmessage({ data: reply(frame, 'error', code === undefined ? {} : { code }) });
    const { error } = await s;
    assert.equal(error.code, 'SEND_FAILED');
    if (kept) assert.deepEqual(error.details, { code });
    else assert.equal(error.details, undefined, JSON.stringify(code));
  }
});

test('sendMessage: an error frame without response is SEND_FAILED without details', async () => {
  const { ws, frame, s } = await opened();
  ws.onmessage({ data: reply(frame, 'error') });
  const { error } = await s;
  assert.equal(error.code, 'SEND_FAILED');
  assert.equal(error.details, undefined);
});

test('sendMessage: ack alone does not finish; success after it does', async () => {
  const { ws, frame, s } = await opened();
  ws.onmessage({ data: reply(frame, 'ack') });
  assert.equal(await stillPending(s), true);
  ws.onmessage({ data: reply(frame, 'success', { message_id: 'm-3', message_ts: 'T' }) });
  assert.deepEqual((await s).value, { message_id: 'm-3', at: 'T' });
});

test('sendMessage: frames with another request_id, without request_id and non-JSON are skipped', async () => {
  const { ws, frame, s } = await opened();
  ws.onmessage({ data: JSON.stringify({ request_id: 'other', req_type: 'send_message', status: 'success', response: { message_id: 'bad' } }) });
  ws.onmessage({ data: JSON.stringify({ request_id: 'other', req_type: 'send_message', status: 'error', response: { code: 'x' } }) });
  ws.onmessage({ data: JSON.stringify({ type: 'create_message', payload: { text: 'hi' } }) });
  ws.onmessage({ data: JSON.stringify({ req_type: 'send_message', status: 'success', response: { message_id: 'bad' } }) });
  ws.onmessage({ data: 'not json at all' });
  ws.onmessage({ data: '' });
  assert.equal(await stillPending(s), true);
  ws.onmessage({ data: reply(frame, 'success', { message_id: 'good', message_ts: 'T' }) });
  assert.equal((await s).value.message_id, 'good');
});

test('sendMessage: error or close before the frame was sent is NETWORK with the plain message', async () => {
  for (const event of ['onerror', 'onclose']) {
    const { ws, s } = await start();
    ws[event](new Error(`boom ${ws.url}`));
    const { error } = await s;
    assert.equal(error.code, 'NETWORK', event);
    assert.equal(error.message, 'Сетевая ошибка');
    assert.deepEqual(ws.sent, []);
    NO_KEY(error);
  }
});

test('sendMessage: error or close after the frame was sent is SEND_UNCONFIRMED', async () => {
  for (const event of ['onerror', 'onclose']) {
    const { ws, s } = await opened();
    ws[event](new Error(`boom ${ws.url}`));
    const { error } = await s;
    assert.equal(error.code, 'SEND_UNCONFIRMED', event);
    assert.equal(ws.sent.length, 1);
    NO_KEY(error);
  }
});

test('sendMessage: error or close after an ack but without the final frame is SEND_UNCONFIRMED', async () => {
  for (const event of ['onerror', 'onclose']) {
    const { ws, frame, s } = await opened();
    ws.onmessage({ data: reply(frame, 'ack') });
    ws[event]();
    assert.equal((await s).error.code, 'SEND_UNCONFIRMED', event);
  }
});

test('sendMessage: the deadline before open is TIMEOUT, nothing was sent', async () => {
  const { ws, s } = await start({ timeoutMs: 30 });
  const { error } = await s;
  assert.equal(error.code, 'TIMEOUT');
  assert.deepEqual(ws.sent, []);
  NO_KEY(error);
});

test('sendMessage: the deadline after the frame was sent is SEND_UNCONFIRMED, also after an ack', async () => {
  const a = await opened({ timeoutMs: 60 });
  const ea = (await a.s).error;
  assert.equal(ea.code, 'SEND_UNCONFIRMED');
  NO_KEY(ea);
  const b = await opened({ timeoutMs: 60 });
  b.ws.onmessage({ data: reply(b.frame, 'ack') });
  assert.equal((await b.s).error.code, 'SEND_UNCONFIRMED');
});

test('sendMessage: the deadline counts from creating the connection, not from open', async () => {
  const { ws, s } = await start({ timeoutMs: 80 });
  await new Promise((r) => setTimeout(r, 50));
  ws.onopen();
  const t0 = Date.now();
  const { error } = await s;
  assert.equal(error.code, 'SEND_UNCONFIRMED');
  assert.ok(Date.now() - t0 < 70, 'the deadline was restarted at open');
});

test('sendMessage: close() is called once on every outcome', async () => {
  const outcomes = [
    async () => { const h = await opened(); h.ws.onmessage({ data: reply(h.frame, 'success', {}) }); return h; },
    async () => { const h = await opened(); h.ws.onmessage({ data: reply(h.frame, 'error', { code: 'c' }) }); return h; },
    async () => { const h = await start(); h.ws.onerror(); return h; },
    async () => { const h = await start(); h.ws.onclose(); return h; },
    async () => { const h = await opened(); h.ws.onerror(); return h; },
    async () => { const h = await opened(); h.ws.onclose(); return h; },
    async () => start({ timeoutMs: 30 }),
    async () => opened({ timeoutMs: 30 }),
  ];
  for (const [i, run] of outcomes.entries()) {
    const h = await run();
    await h.s;
    assert.equal(h.ws.closed, 1, `outcome ${i}`);
  }
});

test('sendMessage: late events after the outcome change nothing', async () => {
  const { ws, frame, s } = await opened();
  ws.onmessage({ data: reply(frame, 'success', { message_id: 'm-4', message_ts: 'T' }) });
  const first = await s;
  const closedBefore = ws.closed;
  ws.onerror(new Error('late'));
  ws.onclose();
  ws.onmessage({ data: reply(frame, 'error', { code: 'late' }) });
  ws.onmessage({ data: reply(frame, 'success', { message_id: 'other' }) });
  await tick();
  assert.deepEqual(first.value, { message_id: 'm-4', at: 'T' });
  assert.equal(ws.closed, closedBefore);
  assert.equal(ws.sent.length, 1);
});

test('sendMessage: a late open after the outcome sends nothing', async () => {
  const { ws, s } = await start();
  ws.onerror();
  assert.equal((await s).error.code, 'NETWORK');
  ws.onopen();
  await tick();
  assert.deepEqual(ws.sent, []);
});

test('sendMessage: a late open after the deadline sends nothing', async () => {
  const { ws, s } = await start({ timeoutMs: 30 });
  assert.equal((await s).error.code, 'TIMEOUT');
  ws.onopen();
  await tick();
  assert.deepEqual(ws.sent, []);
});

test('sendMessage: the key and the address are in no error message or details', async () => {
  const runs = [
    async () => { const h = await start(); h.ws.onerror(new Error(h.ws.url)); return h; },
    async () => { const h = await opened(); h.ws.onerror(new Error(h.ws.url)); return h; },
    async () => { const h = await opened(); h.ws.onmessage({ data: reply(h.frame, 'error', { code: 'bad_request' }) }); return h; },
    async () => start({ timeoutMs: 30 }),
    async () => opened({ timeoutMs: 30 }),
  ];
  for (const run of runs) {
    const h = await run();
    const { error } = await h.s;
    assert.ok(error, 'no error');
    NO_KEY(error);
    const shown = errText(error);
    assert.ok(!shown.includes(TOKEN) && !shown.includes('messaging-ws'), shown);
  }
});
