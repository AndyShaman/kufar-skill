import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  rejectsCode, throwsCode, errText, goodToken, fakeFetch, jsonRes, emptyRes, headersOf, hangUntilAbort,
} from './helpers.mjs';
import { VERSION } from '../skills/kufar/scripts/lib/transport.mjs';

// the module does not exist yet: it is imported inside each test, so the old tests still load
const manage = () => import('../skills/kufar/scripts/lib/manage.mjs');

const TOKEN = goodToken();
const ID = '1000000001';
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const url = (action) => `https://api.kufar.by/my-items-v2/v1/items/${ID}/${action}`;

// ---- manageRequest ----

const req = async (args) => (await manage()).manageRequest(args);
const badArgs = async (args) => {
  const { manageRequest } = await manage();
  throwsCode(() => manageRequest(args), 'BAD_ARGS');
};

test('manageRequest: an unknown or missing action -> BAD_ARGS', async () => {
  for (const action of ['deactivate', 'remove', 'OFF', '', undefined, null, 5]) await badArgs({ action });
});

test('manageRequest: off without a reason or with an unknown reason -> BAD_ARGS', async () => {
  await badArgs({ action: 'off' });
  await badArgs({ action: 'off', reason: '' });
  await badArgs({ action: 'off', reason: 'bored' });
  await badArgs({ action: 'off', reason: 'SOLD_ON_SITE', duration: 'one_day' });
});

test('manageRequest: sold_on_site without duration or with an unknown duration -> BAD_ARGS', async () => {
  await badArgs({ action: 'off', reason: 'sold_on_site' });
  await badArgs({ action: 'off', reason: 'sold_on_site', duration: 'one_year' });
  await badArgs({ action: 'off', reason: 'sold_on_site', duration: '' });
});

for (const duration of ['one_day', 'one_week', 'one_month', 'over_one_month']) {
  test(`manageRequest: sold_on_site with ${duration} -> deactivate body`, async () => {
    assert.deepStrictEqual(await req({ action: 'off', reason: 'sold_on_site', duration }), {
      action: 'deactivate', body: { reason: 'sold_on_site', duration, comment: '' },
    });
  });
}

test('manageRequest: other without a comment or with a blank one -> BAD_ARGS', async () => {
  await badArgs({ action: 'off', reason: 'other' });
  await badArgs({ action: 'off', reason: 'other', comment: '' });
  await badArgs({ action: 'off', reason: 'other', comment: '   \n ' });
});

test('manageRequest: other with a comment of 301 characters -> BAD_ARGS, 300 is fine', async () => {
  await badArgs({ action: 'off', reason: 'other', comment: 'x'.repeat(301) });
  const r = await req({ action: 'off', reason: 'other', comment: 'x'.repeat(300) });
  assert.equal(r.body.comment, 'x'.repeat(300));
});

test('manageRequest: other with a good comment -> body with the trimmed comment', async () => {
  assert.deepStrictEqual(await req({ action: 'off', reason: 'other', comment: '  Передумал продавать \n' }), {
    action: 'deactivate', body: { reason: 'other', duration: '', comment: 'Передумал продавать' },
  });
});

test('manageRequest: a comment of 300 characters plus spaces around is within the limit', async () => {
  const r = await req({ action: 'off', reason: 'other', comment: ` ${'x'.repeat(300)} ` });
  assert.equal(r.body.comment, 'x'.repeat(300));
});

test('manageRequest: duration with a reason other than sold_on_site -> BAD_ARGS', async () => {
  for (const reason of ['sold_other_means', 'give_up', 'hands_up']) await badArgs({ action: 'off', reason, duration: 'one_day' });
  await badArgs({ action: 'off', reason: 'other', comment: 'ok', duration: 'one_day' });
});

test('manageRequest: comment with a reason other than other -> BAD_ARGS', async () => {
  for (const reason of ['sold_other_means', 'give_up', 'hands_up']) await badArgs({ action: 'off', reason, comment: 'ok' });
  await badArgs({ action: 'off', reason: 'sold_on_site', duration: 'one_day', comment: 'ok' });
});

for (const reason of ['sold_other_means', 'give_up', 'hands_up']) {
  test(`manageRequest: ${reason} -> body with two empty strings`, async () => {
    assert.deepStrictEqual(await req({ action: 'off', reason }), {
      action: 'deactivate', body: { reason, duration: '', comment: '' },
    });
  });
}

for (const action of ['activate', 'prolong', 'delete']) {
  test(`manageRequest: ${action} -> no body`, async () => {
    assert.deepStrictEqual(await req({ action }), { action, body: null });
  });
  test(`manageRequest: ${action} with reason, duration or comment -> BAD_ARGS`, async () => {
    await badArgs({ action, reason: 'give_up' });
    await badArgs({ action, duration: 'one_day' });
    await badArgs({ action, comment: 'text' });
    await badArgs({ action, reason: 'other', comment: 'text' });
  });
}

// ---- manageCode ----

const OFF = { action: 'deactivate', body: { reason: 'other', duration: '', comment: 'Передумал' } };

test('manageCode: 12 hex characters', async () => {
  const { manageCode } = await manage();
  assert.match(manageCode(ID, OFF), /^[0-9a-f]{12}$/);
  assert.match(manageCode(ID, { action: 'delete', body: null }), /^[0-9a-f]{12}$/);
});

test('manageCode: the first 12 hex of sha256 of JSON [id, action, body]', async () => {
  const { manageCode } = await manage();
  assert.equal(manageCode(ID, OFF), sha12(JSON.stringify([ID, OFF.action, OFF.body])));
  const del = { action: 'delete', body: null };
  assert.equal(manageCode(ID, del), sha12(JSON.stringify([ID, 'delete', null])));
});

test('manageCode: the same input gives the same code', async () => {
  const { manageCode } = await manage();
  assert.equal(manageCode(ID, OFF), manageCode(ID, structuredClone(OFF)));
});

test('manageCode: changes with the id, the action, the reason and the comment', async () => {
  const { manageCode } = await manage();
  const base = manageCode(ID, OFF);
  assert.notEqual(manageCode('1000000002', OFF), base);
  assert.notEqual(manageCode(ID, { ...OFF, action: 'delete', body: null }), base);
  assert.notEqual(manageCode(ID, { ...OFF, body: { ...OFF.body, reason: 'give_up', comment: '' } }), base);
  assert.notEqual(manageCode(ID, { ...OFF, body: { ...OFF.body, comment: 'Другое' } }), base);
  assert.notEqual(manageCode(ID, { action: 'activate', body: null }), manageCode(ID, { action: 'prolong', body: null }));
});

// ---- manageAd ----

const run = async (fetchImpl, over = {}) => (await manage()).manageAd({
  token: TOKEN, id: ID, request: { action: 'delete', body: null }, fetchImpl, ...over,
});
const withBody = { action: 'deactivate', body: { reason: 'sold_on_site', duration: 'one_week', comment: '' } };

test('manageAd: PUT to the item action address with the key and the user agent', async () => {
  for (const action of ['activate', 'prolong', 'delete']) {
    const fetchImpl = fakeFetch(() => emptyRes(204));
    await run(fetchImpl, { request: { action, body: null } });
    const [call] = fetchImpl.calls;
    assert.equal(call.url, url(action));
    assert.equal(call.init.method, 'PUT');
    const h = headersOf(call.init);
    assert.equal(h.authorization, `Bearer ${TOKEN}`);
    assert.equal(h['user-agent'], `kufar-skill/${VERSION}`);
  }
});

test('manageAd: an action with a body sends Content-Type JSON and the body', async () => {
  const fetchImpl = fakeFetch(() => jsonRes(200, { is_sold_on_site_feedback_allowed: true }));
  await run(fetchImpl, { request: withBody });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, url('deactivate'));
  assert.equal(call.init.method, 'PUT');
  assert.equal(headersOf(call.init)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), withBody.body);
});

test('manageAd: an action without a body sends no body and no Content-Type', async () => {
  const fetchImpl = fakeFetch(() => emptyRes(200));
  await run(fetchImpl, { request: { action: 'prolong', body: null } });
  const [call] = fetchImpl.calls;
  assert.ok(call.init.body === undefined || call.init.body === null);
  assert.equal(headersOf(call.init)['content-type'], undefined);
});

for (const [status, bodyName, res] of [
  [200, 'a JSON body', () => jsonRes(200, { is_sold_on_site_feedback_allowed: false })],
  [200, 'an empty body', () => emptyRes(200)],
  [200, 'a body that is not JSON', () => jsonRes(200, 'not json')],
  [204, 'an empty body', () => emptyRes(204)],
  [201, 'a JSON body', () => jsonRes(201, {})],
]) {
  test(`manageAd: ${status} with ${bodyName} -> true`, async () => {
    assert.equal(await run(fakeFetch(res)), true);
  });
}

test('manageAd: 401 -> AUTH_EXPIRED', async () => {
  await rejectsCode(run(fakeFetch(() => jsonRes(401, {}))), 'AUTH_EXPIRED');
});

for (const status of [400, 403, 404, 422]) {
  test(`manageAd: ${status} -> MANAGE_FAILED with the status and the Russian reason`, async () => {
    await assert.rejects(run(fakeFetch(() => jsonRes(status, {
      message: 'FALLBACK', details: { translations: { ru: 'Нельзя удалить так рано', by: 'x' } },
    }))), (e) => {
      assert.equal(e.name, 'KufarError');
      assert.equal(e.code, 'MANAGE_FAILED');
      assert.equal(e.details.status, status);
      assert.equal(e.details.reason, 'Нельзя удалить так рано');
      return true;
    });
  });
}

test('manageAd: the reason falls back to message', async () => {
  await assert.rejects(run(fakeFetch(() => jsonRes(403, { message: 'FORBIDDEN_NOW', details: {} }))), (e) => {
    assert.equal(e.code, 'MANAGE_FAILED');
    assert.equal(e.details.reason, 'FORBIDDEN_NOW');
    return true;
  });
});

test('manageAd: the reason is cut to 300 characters', async () => {
  await assert.rejects(run(fakeFetch(() => jsonRes(422, { details: { translations: { ru: 'я'.repeat(500) } } }))), (e) => {
    assert.equal(e.details.reason, 'я'.repeat(300));
    return true;
  });
  await assert.rejects(run(fakeFetch(() => jsonRes(422, { message: 'm'.repeat(500) }))), (e) => {
    assert.equal(e.details.reason, 'm'.repeat(300));
    return true;
  });
});

test('manageAd: no reason in the answer, or an answer that is not JSON -> reason null', async () => {
  for (const res of [() => jsonRes(404, {}), () => jsonRes(404, { details: {} }), () => jsonRes(400, 'not json'), () => emptyRes(403)]) {
    await assert.rejects(run(fakeFetch(res)), (e) => {
      assert.equal(e.code, 'MANAGE_FAILED');
      assert.equal(e.details.reason, null);
      assert.ok('status' in e.details);
      return true;
    });
  }
});

test('manageAd: the info object with a link in the answer does not get into the error', async () => {
  const res = () => jsonRes(403, {
    message: 'M', info: { link: 'https://evil.example.com/LINK-MARK', button: 'BUTTON-MARK' },
    details: { translations: { ru: 'Отказ' }, info: { link: 'https://evil.example.com/LINK-MARK' } },
  });
  await assert.rejects(run(fakeFetch(res)), (e) => {
    const text = errText(e);
    assert.ok(!text.includes('LINK-MARK') && !text.includes('BUTTON-MARK') && !text.includes('evil.example.com'), text);
    return true;
  });
});

const UNCONFIRMED = [
  ['500', () => jsonRes(500, {})],
  ['503', () => jsonRes(503, 'down')],
  ['a rejected fetch', () => { throw new Error(`boom ${TOKEN}`); }],
  ['a timeout error', () => { throw new DOMException('timed out', 'TimeoutError'); }],
];
for (const [name, res] of UNCONFIRMED) {
  test(`manageAd: ${name} -> MANAGE_UNCONFIRMED, the key and the network text are not in the error`, async () => {
    await assert.rejects(run(fakeFetch(res)), (e) => {
      assert.equal(e.code, 'MANAGE_UNCONFIRMED');
      assert.ok(!errText(e).includes(TOKEN));
      assert.ok(!errText(e).includes('boom'));
      return true;
    });
  });
}

test('manageAd: a request that does not finish within timeoutMs -> MANAGE_UNCONFIRMED', async () => {
  const hang = async (u, init) => hangUntilAbort(init);
  await rejectsCode(run(hang, { timeoutMs: 30 }), 'MANAGE_UNCONFIRMED');
});

test('manageAd: the key is in no refusal or failure message', async () => {
  for (const res of [() => jsonRes(403, { message: `x ${TOKEN}` }), () => jsonRes(401, {}), () => jsonRes(500, {})]) {
    await assert.rejects(run(fakeFetch(res)), (e) => e.code !== 'MANAGE_FAILED' || !e.message.includes(TOKEN));
  }
});
