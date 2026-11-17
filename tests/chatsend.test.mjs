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

// ---- step 3d: hasKey (imported inside the tests: the export does not exist yet) ----

const hasKeyOf = async () => (await import('../scripts/lib/chatsend.mjs')).hasKey;

test('hasKey: a key-shaped string -> true', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey(`вот ${SHAPED} тут`, TOKEN), true);
  assert.equal(hasKey(SHAPED, undefined), true);
});

test('hasKey: the saved key itself -> true', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey(`ключ ${TOKEN}`, TOKEN), true);
});

test('hasKey: the second or the third part of 20+ characters -> true', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey(`код ${P2}`, TOKEN), true);
  assert.equal(hasKey(`код ${P3}`, TOKEN), true);
});

test('hasKey: the key split by spaces -> true', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey(TOKEN.match(/.{1,6}/g).join(' '), TOKEN), true);
});

test('hasKey: ordinary text -> false', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey('Катушка зажигания, новая, торг уместен', TOKEN), false);
});

test('hasKey: a short part of the key -> false', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey('Zq8Lm2Xv5Rt9', TOKEN), false);
});

test('hasKey: token undefined and ordinary text -> false', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey('Катушка зажигания', undefined), false);
});

test('hasKey: an empty string does not throw', async () => {
  const hasKey = await hasKeyOf();
  assert.equal(hasKey('', TOKEN), false);
});

// ---- step 3g: styleFlags and sendMessage with adId (imported inside the tests: not implemented yet) ----

const styleFlagsOf = async () => (await import('../scripts/lib/chatsend.mjs')).styleFlags;

test('styleFlags: an ordinary short chat text -> []', async () => {
  const styleFlags = await styleFlagsOf();
  assert.deepEqual(styleFlags('Добрый день, ещё продаёте? Торг возможен?'), []);
  assert.deepEqual(styleFlags('Здравствуйте. Катушка ещё продаётся?\nМожно забрать завтра.'), []);
});

test('styleFlags: long_dash for an em dash and for an en dash, a hyphen is not it', async () => {
  const styleFlags = await styleFlagsOf();
  assert.deepEqual(styleFlags('Цена — договорная'), ['long_dash']);
  assert.deepEqual(styleFlags('Цена – договорная'), ['long_dash']);
  assert.deepEqual(styleFlags('Кто-то продаёт, что-нибудь есть'), []);
});

test('styleFlags: long above 300 characters, not at 300', async () => {
  const styleFlags = await styleFlagsOf();
  assert.deepEqual(styleFlags('а'.repeat(300)), []);
  assert.deepEqual(styleFlags('а'.repeat(301)), ['long']);
});

test('styleFlags: exclaim for two exclamation marks, not for one', async () => {
  const styleFlags = await styleFlagsOf();
  assert.deepEqual(styleFlags('Здравствуйте! Ещё продаёте?'), []);
  assert.deepEqual(styleFlags('Здравствуйте! Ещё продаёте!'), ['exclaim']);
  assert.deepEqual(styleFlags('Здравствуйте!!'), ['exclaim']);
});

test('styleFlags: emoji', async () => {
  const styleFlags = await styleFlagsOf();
  assert.deepEqual(styleFlags('Добрый день 😀'), ['emoji']);
  assert.deepEqual(styleFlags('Добрый день 👍 ещё продаёте'), ['emoji']);
});

test('styleFlags: list for a line starting with -, •, *, 1. or 2), also after spaces and on a second line', async () => {
  const styleFlags = await styleFlagsOf();
  for (const line of ['- цена', '• цена', '* цена', '1. цена', '2) цена', '   - цена', '\t• цена']) {
    assert.deepEqual(styleFlags(line), ['list'], line);
    assert.deepEqual(styleFlags(`Добрый день\n${line}`), ['list'], `second line: ${line}`);
  }
});

test('styleFlags: a hyphen, a bullet or a number inside a line is not a list', async () => {
  const styleFlags = await styleFlagsOf();
  assert.deepEqual(styleFlags('Здравствуйте, кто-то - не вы - писал'), []);
  assert.deepEqual(styleFlags('Ещё продаёте? Цена 2) или 3 тысячи'), []);
  assert.deepEqual(styleFlags('Привет • пока'), []);
});

const FORMAL = [
  'заинтересовал', 'подскажите, пожалуйста', 'буду признател', 'буду благодар', 'заранее благодар', 'заранее спасибо',
  'с уважением', 'хотел бы уточнить', 'хотела бы уточнить', 'надеюсь на', 'доброго времени суток',
];
for (const phrase of FORMAL) {
  test(`styleFlags: formal for "${phrase}", in any case`, async () => {
    const styleFlags = await styleFlagsOf();
    assert.deepEqual(styleFlags(`Здравствуйте. ${phrase}`), ['formal']);
    assert.deepEqual(styleFlags(`Здравствуйте. ${phrase.toUpperCase()}`), ['formal']);
    assert.deepEqual(styleFlags(`Здравствуйте. ${phrase[0].toUpperCase()}${phrase.slice(1)} вас`), ['formal']);
  });
}

test('styleFlags: several flags come in the contract order, each once', async () => {
  const styleFlags = await styleFlagsOf();
  const all = `Заранее спасибо!! 😀 — ещё раз — !!\n- ${'а'.repeat(300)}`;
  assert.deepEqual(styleFlags(all), ['long_dash', 'long', 'exclaim', 'emoji', 'list', 'formal']);
  assert.deepEqual(styleFlags('С уважением!! — 😀 с уважением'), ['long_dash', 'exclaim', 'emoji', 'formal']);
  assert.deepEqual(styleFlags('1. цена — 😀'), ['long_dash', 'emoji', 'list']);
});

const AD_ID = '1000000001';

const startAd = (opts = {}) => start({ conversationId: undefined, adId: AD_ID, ...opts });
async function openedAd(opts) {
  const h = await startAd(opts);
  h.ws.onopen();
  await tick();
  return { ...h, frame: JSON.parse(h.ws.sent[0]) };
}
const replyCreate = (frame, status, response, reqType = 'create_conversation') => JSON.stringify({
  request_id: frame.request_id, req_type: reqType, status, ...(response === undefined ? {} : { response }),
});

test('sendMessage adId: after open one create_conversation frame goes out, all ids from uuid()', async () => {
  const { ws, frame, uuid, s } = await openedAd();
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(Object.keys(frame).sort(), ['payload', 'req_type', 'request_id']);
  assert.equal(frame.req_type, 'create_conversation');
  assert.equal(frame.payload.ad_id, 1000000001);
  assert.equal(typeof frame.payload.ad_id, 'number');
  assert.deepEqual(frame.payload.message, { client_message_id: frame.payload.message.client_message_id, text: 'Привет', type: 'text' });
  const ids = [frame.payload.client_conversation_id, frame.payload.message.client_message_id, frame.request_id];
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.ok(uuid.calls.slice(1).includes(id), `${id} is not from uuid()`);
  assert.ok(!('conversation_id' in frame.payload));
  ws.onerror();
  await s;
});

test('sendMessage adId: nothing is sent before open', async () => {
  const { ws, s } = await startAd();
  assert.deepEqual(ws.sent, []);
  ws.onerror();
  await s;
});

test('sendMessage adId: ack does not finish, success after it gives conversation_id, message_id and at', async () => {
  const { ws, frame, s } = await openedAd();
  ws.onmessage({ data: replyCreate(frame, 'ack') });
  assert.equal(await stillPending(s), true);
  ws.onmessage({ data: replyCreate(frame, 'success', { conversation_id: 'c-1', message_id: 'm-1', message_ts: '2026-11-17T15:43:55Z' }) });
  assert.deepEqual((await s).value, { conversation_id: 'c-1', message_id: 'm-1', at: '2026-11-17T15:43:55Z' });
});

test('sendMessage adId: success with missing fields gives nulls, a number is kept', async () => {
  for (const response of [{}, undefined, { conversation_id: 'c-2' }, { message_id: 7, message_ts: 1763394235 }]) {
    const { ws, frame, s } = await openedAd();
    ws.onmessage({ data: replyCreate(frame, 'success', response) });
    assert.deepEqual((await s).value, {
      conversation_id: response?.conversation_id ?? null, message_id: response?.message_id ?? null, at: response?.message_ts ?? null,
    });
  }
});

test('sendMessage adId: a value that is an object is null', async () => {
  const { ws, frame, s } = await openedAd();
  ws.onmessage({ data: replyCreate(frame, 'success', { conversation_id: { id: 'c' }, message_id: { id: 'm' }, message_ts: { t: 1 } }) });
  assert.deepEqual((await s).value, { conversation_id: null, message_id: null, at: null });
});

test('sendMessage adId: success with another request_id or with req_type send_message is skipped', async () => {
  const { ws, frame, s } = await openedAd();
  ws.onmessage({ data: JSON.stringify({ request_id: 'other', req_type: 'create_conversation', status: 'success', response: { conversation_id: 'bad' } }) });
  ws.onmessage({ data: replyCreate(frame, 'success', { message_id: 'bad' }, 'send_message') });
  ws.onmessage({ data: replyCreate(frame, 'error', { code: 'x' }, 'send_message') });
  assert.equal(await stillPending(s), true);
  ws.onmessage({ data: replyCreate(frame, 'success', { conversation_id: 'good' }) });
  assert.equal((await s).value.conversation_id, 'good');
});

test('sendMessage adId: an error frame is SEND_FAILED with details.code', async () => {
  const { ws, frame, s } = await openedAd();
  ws.onmessage({ data: replyCreate(frame, 'error', { code: 'rate_limited' }) });
  const { error } = await s;
  assert.equal(error.code, 'SEND_FAILED');
  assert.deepEqual(error.details, { code: 'rate_limited' });
  NO_KEY(error);
});

test('sendMessage adId: error or close before the frame was sent is NETWORK, after it SEND_UNCONFIRMED', async () => {
  for (const event of ['onerror', 'onclose']) {
    const a = await startAd();
    a.ws[event](new Error(`boom ${a.ws.url}`));
    const ea = (await a.s).error;
    assert.equal(ea.code, 'NETWORK', event);
    assert.deepEqual(a.ws.sent, []);
    NO_KEY(ea);
    const b = await openedAd();
    b.ws[event](new Error(`boom ${b.ws.url}`));
    const eb = (await b.s).error;
    assert.equal(eb.code, 'SEND_UNCONFIRMED', event);
    NO_KEY(eb);
  }
});

test('sendMessage adId: no answer in timeoutMs is SEND_UNCONFIRMED after the frame, TIMEOUT before it', async () => {
  const a = await openedAd({ timeoutMs: 40 });
  assert.equal((await a.s).error.code, 'SEND_UNCONFIRMED');
  const b = await startAd({ timeoutMs: 40 });
  assert.equal((await b.s).error.code, 'TIMEOUT');
});

test('sendMessage: both conversationId and adId, or neither, is BAD_ARGS and no socket is opened', async () => {
  for (const ids of [{ conversationId: CONV_ID, adId: AD_ID }, { conversationId: undefined, adId: undefined }]) {
    const { FakeWS, instances } = makeWS();
    await rejectsCode(sendMessage({ token: TOKEN, text: 'Привет', WebSocketImpl: FakeWS, uuid: fakeUuid(), timeoutMs: 200, ...ids }), 'BAD_ARGS');
    assert.equal(instances.length, 0);
  }
});

test('sendMessage: with conversationId the frame is still send_message', async () => {
  const { ws, frame, s } = await opened();
  assert.equal(frame.req_type, 'send_message');
  assert.equal(frame.payload.conversation_id, CONV_ID);
  assert.ok(!('ad_id' in frame.payload));
  ws.onerror();
  await s;
});
