import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildAd, maskContact, photoInfo, postCode, uploadPhoto, insertAd, submitAd } from '../scripts/lib/post.mjs';
import {
  tmpDir, rejectsCode, errText, NOW, DAY, goodToken, fakeFetch, jsonRes, headersOf,
} from './helpers.mjs';

const TOKEN = goodToken();
const UPLOAD_URL = 'https://ads-image-uploader.kufar.by/v1/images';
const INSERT_URL = 'https://api.kufar.by/insertion/v1/processing/insert';
const SEGMENTATION = 'routing=web_ad_insertion;application=ad_insertion;platform=web;taxonomy-version=2';
const now = () => NOW;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- buildAd ----

// form fields in the shape of step 3c (the answer of resolveForm with full: true), made by hand
const val = (...xs) => xs.map((v) => ({ value: v, label: `L${v}` }));
const FIELDS = [
  { name: 'subject', label: 'Заголовок', required: true, kind: 'text', min: 5, max: 50 },
  { name: 'body', label: 'Описание', required: true, kind: 'text', min: 5, max: 200 },
  { name: 'condition', label: 'Состояние', required: true, kind: 'choice', values: val('1', '2') },
  { name: 'tags', label: 'Теги', required: false, kind: 'choices', values: val('a', 'b', 'c') },
  { name: 'phone_hidden', label: 'Скрыть телефон', required: false, kind: 'flag' },
  { name: 'mileage', label: 'Пробег', required: false, kind: 'number' },
  { name: 'note', label: 'Заметка', required: false, kind: 'text', min: 3, max: 10 },
  { name: 'free', label: 'Свободный выбор', required: false, kind: 'choice' },
];
const CONTACT = { name: 'Тестовый Продавец', phone: '375290000000', email: 'seller@example.com' };
const DRAFT = { category: '2040', subject: 'Катушка зажигания', body: 'Новая, в упаковке', price: 59, condition: '2' };
const build = (over = {}, extra = {}) => buildAd({ draft: { ...DRAFT, ...over }, fields: FIELDS, type: null, contact: CONTACT, ...extra });
const without = (...keys) => Object.fromEntries(Object.entries(DRAFT).filter(([k]) => !keys.includes(k)));
const adOf = (over, extra) => build(over, extra).ad;

function draftErrors(fn) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.name, 'KufarError');
    assert.equal(e.code, 'DRAFT_INVALID');
    return e.details.fields;
  }
  return assert.fail('no error');
}
const errorsOf = (over, extra) => draftErrors(() => build(over, extra));

const BASE_AD = {
  type: 'sell', company_ad: '0', language: 'ru', currency: 'BYR', remuneration_type: '1',
  delivery_enabled: '0', safedeal_enabled: '0',
  category: '2040', price: '5900', subject: 'Катушка зажигания', body: 'Новая, в упаковке', condition: '2',
  name: CONTACT.name, phone: CONTACT.phone, email: CONTACT.email,
};

test('buildAd: a valid draft gives the full ad', () => {
  assert.deepStrictEqual(build().ad, BASE_AD);
});

test('buildAd: the keys of the ad are exactly the listed ones', () => {
  assert.deepEqual(Object.keys(adOf()).sort(), Object.keys(BASE_AD).sort());
});

test('buildAd: photos in the answer are the draft list', () => {
  assert.deepEqual(build({ photos: ['/a/1.jpg', '/a/2.png'] }).photos, ['/a/1.jpg', '/a/2.png']);
});

test('buildAd: photos in the answer are [] without them', () => {
  assert.deepStrictEqual(build().photos, []);
});

test('buildAd: photos never reach the ad', () => {
  assert.equal('photos' in adOf({ photos: ['/a/1.jpg'] }), false);
});

test('buildAd: photos that is not an array of strings, or longer than 9 -> bad_value', () => {
  assert.equal(errorsOf({ photos: '/a/1.jpg' }).photos, 'bad_value');
  assert.equal(errorsOf({ photos: [1] }).photos, 'bad_value');
  assert.equal(errorsOf({ photos: Array.from({ length: 10 }, (_, i) => `/a/${i}.jpg`) }).photos, 'bad_value');
});

for (const [price, kopecks] of [[59, '5900'], [59.5, '5950'], ['59.50', '5950'], ['59', '5900'], [0.07, '7'], [19.99, '1999'], [1000000000, '100000000000']]) {
  test(`buildAd: price ${JSON.stringify(price)} -> ${kopecks} kopecks`, () => {
    assert.equal(adOf({ price }).price, kopecks);
  });
}

for (const price of [0, -5, 59.999, '59.999', 'abc', 1000000001, '', null, true]) {
  test(`buildAd: price ${JSON.stringify(price)} -> bad_value`, () => {
    assert.equal(errorsOf({ price }).price, 'bad_value');
  });
}

test('buildAd: a missing price -> required', () => {
  assert.equal(draftErrors(() => build({}, { draft: without('price') })).price, 'required');
});

test('buildAd: a form field price of kind number does not make a numeric price an error', () => {
  const fields = [...FIELDS, { name: 'price', label: 'Цена', required: true, kind: 'number' }];
  assert.equal(adOf({ price: 59 }, { fields }).price, '5900');
});

test('buildAd: strings are trimmed in the ad', () => {
  const ad = adOf({ subject: '  Катушка зажигания \n', condition: ' 2 ', note: '  abc ' });
  assert.equal(ad.subject, 'Катушка зажигания');
  assert.equal(ad.condition, '2');
  assert.equal(ad.note, 'abc');
});

test('buildAd: strings are trimmed before the checks', () => {
  assert.equal(errorsOf({ note: '  ab  ' }).note, 'length');
});

for (const v of ['1', true]) {
  test(`buildAd: flag ${JSON.stringify(v)} -> "1"`, () => {
    assert.equal(adOf({ phone_hidden: v }).phone_hidden, '1');
  });
}
for (const v of ['0', false]) {
  test(`buildAd: flag ${JSON.stringify(v)} -> the key is absent`, () => {
    assert.equal('phone_hidden' in adOf({ phone_hidden: v }), false);
  });
}
for (const v of ['yes', 1, 0, 'true', null]) {
  test(`buildAd: flag ${JSON.stringify(v)} -> bad_value`, () => {
    assert.equal(errorsOf({ phone_hidden: v }).phone_hidden, 'bad_value');
  });
}

test('buildAd: choices from the list pass and stay an array', () => {
  assert.deepStrictEqual(adOf({ tags: ['a', 'c'] }).tags, ['a', 'c']);
});
test('buildAd: choices that is not an array -> bad_value', () => {
  assert.equal(errorsOf({ tags: 'a' }).tags, 'bad_value');
});
test('buildAd: an element of choices outside the list -> not_in_list', () => {
  assert.equal(errorsOf({ tags: ['a', 'z'] }).tags, 'not_in_list');
});

test('buildAd: choice outside a non-empty list -> not_in_list', () => {
  assert.equal(errorsOf({ condition: '9' }).condition, 'not_in_list');
});
test('buildAd: choice without values accepts any string', () => {
  assert.equal(adOf({ free: 'anything' }).free, 'anything');
});
test('buildAd: choice that is not a string -> bad_value', () => {
  assert.equal(errorsOf({ condition: 2 }).condition, 'bad_value');
});

for (const v of ['12', '-5', '1.5']) {
  test(`buildAd: number ${JSON.stringify(v)} passes`, () => {
    assert.equal(adOf({ mileage: v }).mileage, v);
  });
}
for (const v of ['12a', 12, '', '1,5']) {
  test(`buildAd: number ${JSON.stringify(v)} -> bad_value`, () => {
    assert.equal(errorsOf({ mileage: v }).mileage, 'bad_value');
  });
}

test('buildAd: text shorter than min -> length', () => {
  assert.equal(errorsOf({ note: 'ab' }).note, 'length');
});
test('buildAd: text longer than max -> length', () => {
  assert.equal(errorsOf({ note: 'a'.repeat(11) }).note, 'length');
});
test('buildAd: text of exactly min and max passes', () => {
  assert.equal(adOf({ note: 'abc' }).note, 'abc');
  assert.equal(adOf({ note: 'a'.repeat(10) }).note, 'a'.repeat(10));
});
test('buildAd: text that is not a string -> bad_value', () => {
  assert.equal(errorsOf({ note: 123 }).note, 'bad_value');
});

test('buildAd: an emoji in subject -> emoji', () => {
  assert.equal(errorsOf({ subject: 'Катушка зажигания 🔥' }).subject, 'emoji');
});
test('buildAd: an emoji in body -> emoji', () => {
  assert.equal(errorsOf({ body: 'Новая, в упаковке 😀' }).body, 'emoji');
});

test('buildAd: a missing required form field -> required', () => {
  assert.equal(draftErrors(() => build({}, { draft: without('condition') })).condition, 'required');
});
test('buildAd: a missing category -> required', () => {
  assert.equal(draftErrors(() => build({}, { draft: without('category') })).category, 'required');
});
for (const key of ['name', 'phone', 'email']) {
  test(`buildAd: ${key} missing in contact -> required under ${key}`, () => {
    const { [key]: _gone, ...contact } = CONTACT;
    assert.deepEqual(draftErrors(() => build({}, { contact })), { [key]: 'required' });
  });
}

test('buildAd: a key that is neither a service key nor a form field -> unknown', () => {
  assert.equal(errorsOf({ mystery: '1' }).mystery, 'unknown');
});
for (const key of ['halva', 'currency', 'delivery_enabled', 'safedeal_enabled', 'remuneration_type', 'images', 'type_field_name']) {
  test(`buildAd: ${key} in the draft -> unknown`, () => {
    assert.equal(errorsOf({ [key]: '1' })[key], 'unknown');
  });
}

test('buildAd: all errors come in one DRAFT_INVALID', () => {
  assert.deepEqual(errorsOf({ price: 0, condition: '9', mystery: '1' }),
    { price: 'bad_value', condition: 'not_in_list', mystery: 'unknown' });
});

test('buildAd: type_field_name and type_field_value are set from type', () => {
  const ad = adOf({}, { type: { name: 'condition', url_name: 'cnd' } });
  assert.equal(ad.type_field_name, 'cnd');
  assert.equal(ad.type_field_value, '2');
});
test('buildAd: no type_field keys when type is null', () => {
  const ad = adOf();
  assert.equal('type_field_name' in ad, false);
  assert.equal('type_field_value' in ad, false);
});

// ---- maskContact ----

test('maskContact: phone, email and name', () => {
  assert.deepEqual(maskContact(CONTACT), { name: CONTACT.name, phone: '…0000', email: 's…@example.com' });
});

// ---- photoInfo ----

async function photoFile(name, size) {
  const f = path.join(await tmpDir(), name);
  const data = Buffer.alloc(size, 7);
  data.write(`${name}-${size}`);
  await fs.writeFile(f, data);
  return { file: f, data };
}
const badFile = (p, index) => assert.rejects(p, (e) => {
  assert.equal(e.name, 'KufarError');
  assert.equal(e.code, 'DRAFT_INVALID');
  assert.equal(e.details.fields.photos, 'bad_file');
  assert.equal(e.details.index, index);
  return true;
});

test('photoInfo: a good .jpg', async () => {
  const { file, data } = await photoFile('a.jpg', 20000);
  assert.deepEqual(await photoInfo([file]), [{ file, ext: 'jpg', bytes: 20000, sha256: sha(data), data }]);
});
test('photoInfo: a good .PNG has ext in lower case', async () => {
  const { file, data } = await photoFile('B.PNG', 15000);
  const [info] = await photoInfo([file]);
  assert.equal(info.ext, 'png');
  assert.equal(info.bytes, 15000);
  assert.equal(info.sha256, sha(data));
  assert.deepEqual(info.data, data);
});
test('photoInfo: an empty list gives []', async () => {
  assert.deepEqual(await photoInfo([]), []);
});
test('photoInfo: a missing file -> bad_file with the index', async () => {
  const { file } = await photoFile('a.jpg', 20000);
  await badFile(photoInfo([file, path.join(path.dirname(file), 'nope.jpg')]), 1);
});
test('photoInfo: a wrong extension -> bad_file', async () => {
  const { file } = await photoFile('a.gif', 20000);
  await badFile(photoInfo([file]), 0);
});
test('photoInfo: a file of exactly 10240 bytes -> bad_file', async () => {
  const { file } = await photoFile('a.jpg', 10240);
  await badFile(photoInfo([file]), 0);
});
test('photoInfo: a file of 10241 bytes passes', async () => {
  const { file } = await photoFile('a.jpg', 10241);
  assert.equal((await photoInfo([file]))[0].bytes, 10241);
});
test('photoInfo: a file above 10485760 bytes -> bad_file', async () => {
  const { file } = await photoFile('a.jpg', 10485761);
  await badFile(photoInfo([file]), 0);
});
test('photoInfo: a file of exactly 10485760 bytes passes', async () => {
  const { file } = await photoFile('a.jpg', 10485760);
  assert.equal((await photoInfo([file]))[0].bytes, 10485760);
});

// ---- postCode ----

const AD = { category: '2040', price: '5900', subject: 'Катушка' };
const PH = [{ sha256: 'aa'.repeat(32) }, { sha256: 'bb'.repeat(32) }];

test('postCode: 12 characters of 0-9a-f', () => {
  assert.match(postCode(AD, PH), /^[0-9a-f]{12}$/);
});
test('postCode: the first 12 characters of sha256 of the sorted pairs and the photo hashes', () => {
  const pairs = Object.entries(AD).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.equal(postCode(AD, PH), sha(JSON.stringify([pairs, PH.map((p) => p.sha256)])).slice(0, 12));
});
test('postCode: the same for the same ad with keys in another order', () => {
  assert.equal(postCode({ subject: 'Катушка', price: '5900', category: '2040' }, PH), postCode(AD, PH));
});
test('postCode: changes when one value changes', () => {
  assert.notEqual(postCode({ ...AD, price: '5901' }, PH), postCode(AD, PH));
});
test('postCode: changes when the hash of a photo changes', () => {
  assert.notEqual(postCode(AD, [PH[0], { sha256: 'cc'.repeat(32) }]), postCode(AD, PH));
});
test('postCode: changes when the order of photos changes', () => {
  assert.notEqual(postCode(AD, [PH[1], PH[0]]), postCode(AD, PH));
});

// ---- uploadPhoto ----

const DATA = Buffer.from('made-up photo bytes');
const upload = (fetchImpl, over = {}) => uploadPhoto({ token: TOKEN, data: DATA, ext: 'jpg', fetchImpl, ...over });
const okUpload = () => fakeFetch(() => jsonRes(200, { path: 'adim1/aaaa.jpg', id: 'aaaa' }));

test('uploadPhoto: the request goes to the uploader by POST with the key and a User-Agent', async () => {
  const fetchImpl = okUpload();
  await upload(fetchImpl);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, UPLOAD_URL);
  assert.equal(call.init.method, 'POST');
  const h = headersOf(call.init);
  assert.equal(h.authorization, `Bearer ${TOKEN}`);
  assert.match(h['user-agent'], /^kufar-skill\//);
});

for (const [ext, type] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg']]) {
  test(`uploadPhoto: ${ext} goes as one part file of type ${type} named photo.${ext}`, async () => {
    const fetchImpl = okUpload();
    await upload(fetchImpl, { ext });
    const body = fetchImpl.calls[0].init.body;
    assert.ok(body instanceof FormData);
    assert.deepEqual([...body.keys()], ['file']);
    const part = body.get('file');
    assert.equal(part.type, type);
    assert.equal(part.name, `photo.${ext}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), DATA);
  });
}

test('uploadPhoto: 200 with path -> the path', async () => {
  assert.equal(await upload(okUpload()), 'adim1/aaaa.jpg');
});
test('uploadPhoto: 401 -> AUTH_EXPIRED', async () => {
  await rejectsCode(upload(fakeFetch(() => jsonRes(401, {}))), 'AUTH_EXPIRED');
});
for (const [name, res, status] of [['500', () => jsonRes(500, {}), 500], ['200 without path', () => jsonRes(200, { id: 'x' }), 200]]) {
  test(`uploadPhoto: ${name} -> PHOTO_FAILED with the status`, async () => {
    await assert.rejects(upload(fakeFetch(res)), (e) => {
      assert.equal(e.code, 'PHOTO_FAILED');
      assert.equal(e.details.status, status);
      return true;
    });
  });
}
test('uploadPhoto: a rejected fetch -> NETWORK, the key is not in the error', async () => {
  await assert.rejects(upload(fakeFetch(() => { throw new Error(`boom ${TOKEN}`); })), (e) => {
    assert.equal(e.code, 'NETWORK');
    assert.ok(!errText(e).includes(TOKEN));
    return true;
  });
});

// ---- insertAd ----

const insert = (fetchImpl) => insertAd({ token: TOKEN, ad: AD, fetchImpl });
const refusal = (fields) => jsonRes(422, { code: 'ADINS0001', message: 'ad validation failed', details: { fields } });

test('insertAd: the request goes to the insert address by POST with the headers and the body', async () => {
  const fetchImpl = fakeFetch(() => jsonRes(200, { ad_id: 123, pending_slot: false }));
  await insert(fetchImpl);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, INSERT_URL);
  assert.equal(call.init.method, 'POST');
  const h = headersOf(call.init);
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h.authorization, `Bearer ${TOKEN}`);
  assert.equal(h['x-segmentation'], SEGMENTATION);
  assert.match(h['user-agent'], /^kufar-skill\//);
  assert.deepEqual(JSON.parse(call.init.body), { ad: AD, delivery: null });
});

test('insertAd: 200 with ad_id -> ad_id as a string and pending_slot', async () => {
  const r = await insert(fakeFetch(() => jsonRes(200, { ad_id: 123, pending_slot: false })));
  assert.deepEqual(r, { ad_id: '123', pending_slot: false });
});
test('insertAd: pending_slot true passes through', async () => {
  const r = await insert(fakeFetch(() => jsonRes(200, { ad_id: 123, pending_slot: true })));
  assert.deepEqual(r, { ad_id: '123', pending_slot: true });
});

test('insertAd: 422 -> POST_REFUSED with the Russian translation, or the message without one', async () => {
  await assert.rejects(insert(fakeFetch(() => refusal({
    subject: { message: 'ERROR_NOT_FOUND', translations: { ru: 'Заполните обязательное поле', by: 'x' } },
    body: { message: 'ONLY_MESSAGE' },
  }))), (e) => {
    assert.equal(e.code, 'POST_REFUSED');
    assert.deepEqual(e.details.fields, { subject: 'Заполните обязательное поле', body: 'ONLY_MESSAGE' });
    return true;
  });
});
test('insertAd: 422 values are cut to 200 characters', async () => {
  await assert.rejects(insert(fakeFetch(() => refusal({ common: { translations: { ru: 'x'.repeat(300) } } }))), (e) => {
    assert.equal(e.details.fields.common, 'x'.repeat(200));
    return true;
  });
});
test('insertAd: 422 holds at most 30 fields', async () => {
  const fields = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`f${i}`, { message: 'M' }]));
  await assert.rejects(insert(fakeFetch(() => refusal(fields))), (e) => {
    assert.equal(e.code, 'POST_REFUSED');
    assert.equal(Object.keys(e.details.fields).length, 30);
    return true;
  });
});

for (const status of [401, 403, 400]) {
  test(`insertAd: ${status} -> POST_FAILED with the status`, async () => {
    await assert.rejects(insert(fakeFetch(() => jsonRes(status, {}))), (e) => {
      assert.equal(e.code, 'POST_FAILED');
      assert.equal(e.details.status, status);
      return true;
    });
  });
}

const UNCONFIRMED = [
  ['500', () => jsonRes(500, {})],
  ['502', () => jsonRes(502, {})],
  ['200 without ad_id', () => jsonRes(200, { pending_slot: false })],
  ['200 with a non-JSON body', () => jsonRes(200, 'not json')],
  ['a rejected fetch', () => { throw new Error(`boom ${TOKEN}`); }],
];
for (const [name, res] of UNCONFIRMED) {
  test(`insertAd: ${name} -> POST_UNCONFIRMED, the key is not in the error`, async () => {
    await assert.rejects(insert(fakeFetch(res)), (e) => {
      assert.equal(e.code, 'POST_UNCONFIRMED');
      assert.ok(!errText(e).includes(TOKEN));
      return true;
    });
  });
}

test('insertAd: the key is in no refusal or failure', async () => {
  for (const res of [() => refusal({ common: { message: 'M' } }), () => jsonRes(403, {})]) {
    await assert.rejects(insert(fakeFetch(res)), (e) => !errText(e).includes(TOKEN));
  }
});

// ---- submitAd ----

const SUBMIT_AD = { category: '2040', price: '5900' };
const CODE = '0123456789ab';
const recordFile = (dir) => path.join(dir, 'post-last.json');
const readRecord = async (dir) => JSON.parse(await fs.readFile(recordFile(dir), 'utf8'));
const exists = (f) => fs.stat(f).then(() => true, () => false);
const PHOTOS = [
  { file: '/x/1.jpg', ext: 'jpg', bytes: 3, sha256: 'a', data: Buffer.from('one') },
  { file: '/x/2.png', ext: 'png', bytes: 3, sha256: 'b', data: Buffer.from('two') },
];

// uploads answer adim1/<n>.jpg; the insert answers by insertRes
function submitFetch(insertRes = () => jsonRes(200, { ad_id: 123, pending_slot: false })) {
  let n = 0;
  return fakeFetch((url, init, count) => (url === UPLOAD_URL ? jsonRes(200, { path: `adim1/${++n}.jpg` }) : insertRes(url, init, count)));
}
const submit = (dir, fetchImpl, over = {}) => submitAd({
  stateDir: dir, code: CODE, ad: SUBMIT_AD, photos: [], token: TOKEN, fetchImpl, now, ...over,
});
const insertCalls = (f) => f.calls.filter((c) => c.url === INSERT_URL);

test('submitAd: photos go one by one in order, then one insert with images and is_new_image', async () => {
  const dir = await tmpDir();
  const f = submitFetch();
  await submit(dir, f, { photos: PHOTOS });
  assert.deepEqual(f.calls.map((c) => c.url), [UPLOAD_URL, UPLOAD_URL, INSERT_URL]);
  assert.deepEqual(Buffer.from(await f.calls[0].init.body.get('file').arrayBuffer()), PHOTOS[0].data);
  assert.deepEqual(Buffer.from(await f.calls[1].init.body.get('file').arrayBuffer()), PHOTOS[1].data);
  assert.equal(f.calls[0].init.body.get('file').name, 'photo.jpg');
  assert.equal(f.calls[1].init.body.get('file').name, 'photo.png');
  const { ad } = JSON.parse(f.calls[2].init.body);
  assert.deepEqual(ad.images, ['adim1/1.jpg', 'adim1/2.jpg']);
  assert.deepEqual(ad.is_new_image, [true, true]);
  assert.equal(ad.category, '2040');
});

test('submitAd: without photos the insert body has neither images nor is_new_image', async () => {
  const f = submitFetch();
  await submit(await tmpDir(), f);
  assert.equal(f.calls.length, 1);
  const { ad } = JSON.parse(f.calls[0].init.body);
  assert.equal('images' in ad, false);
  assert.equal('is_new_image' in ad, false);
});

test('submitAd: on success the answer and post-last.json', async () => {
  const dir = await tmpDir();
  const r = await submit(dir, submitFetch());
  assert.deepEqual(r, { ad_id: '123', pending_slot: false });
  assert.deepEqual(await readRecord(dir), { code: CODE, at: NOW, ad_id: '123' });
});

test('submitAd: before the insert request the record holds code and at, without ad_id', async () => {
  const dir = await tmpDir();
  let seen;
  const f = submitFetch(async () => {
    seen = await readRecord(dir);
    return jsonRes(200, { ad_id: 5, pending_slot: false });
  });
  await submit(dir, f);
  assert.deepEqual(seen, { code: CODE, at: NOW });
});

test('submitAd: a second call with the same code -> ALREADY_POSTED with ad_id, no request', async () => {
  const dir = await tmpDir();
  await submit(dir, submitFetch());
  const f = submitFetch();
  await assert.rejects(submit(dir, f, { photos: PHOTOS }), (e) => {
    assert.equal(e.code, 'ALREADY_POSTED');
    assert.equal(e.details.ad_id, '123');
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test('submitAd: after POST_UNCONFIRMED the record stays without ad_id', async () => {
  const dir = await tmpDir();
  await rejectsCode(submit(dir, submitFetch(() => jsonRes(500, {}))), 'POST_UNCONFIRMED');
  const rec = await readRecord(dir);
  assert.equal(rec.code, CODE);
  assert.equal('ad_id' in rec, false);
});

test('submitAd: after POST_UNCONFIRMED a second call with the same code -> POST_UNCONFIRMED, no request', async () => {
  const dir = await tmpDir();
  await rejectsCode(submit(dir, submitFetch(() => jsonRes(500, {}))), 'POST_UNCONFIRMED');
  const f = submitFetch();
  await rejectsCode(submit(dir, f), 'POST_UNCONFIRMED');
  assert.equal(f.calls.length, 0);
});

for (const [name, res, code] of [
  ['POST_REFUSED', () => refusal({ common: { message: 'M' } }), 'POST_REFUSED'],
  ['POST_FAILED', () => jsonRes(400, {}), 'POST_FAILED'],
]) {
  test(`submitAd: after ${name} the record is gone and a second call sends again`, async () => {
    const dir = await tmpDir();
    await rejectsCode(submit(dir, submitFetch(res)), code);
    assert.equal(await exists(recordFile(dir)), false);
    const f = submitFetch();
    assert.deepEqual(await submit(dir, f), { ad_id: '123', pending_slot: false });
    assert.equal(insertCalls(f).length, 1);
  });
}

test('submitAd: a failed photo upload leaves no record and makes no insert request', async () => {
  const dir = await tmpDir();
  const f = fakeFetch(() => jsonRes(500, {}));
  await rejectsCode(submit(dir, f, { photos: PHOTOS }), 'PHOTO_FAILED');
  assert.equal(await exists(recordFile(dir)), false);
  assert.equal(insertCalls(f).length, 0);
});

test('submitAd: a record older than 24 hours does not block', async () => {
  const dir = await tmpDir();
  await fs.writeFile(recordFile(dir), JSON.stringify({ code: CODE, at: NOW - DAY - 1000, ad_id: '99' }));
  const f = submitFetch();
  assert.deepEqual(await submit(dir, f), { ad_id: '123', pending_slot: false });
  assert.equal(insertCalls(f).length, 1);
});

test('submitAd: a record with another code does not block', async () => {
  const dir = await tmpDir();
  await fs.writeFile(recordFile(dir), JSON.stringify({ code: 'ffffffffffff', at: NOW, ad_id: '99' }));
  const f = submitFetch();
  assert.deepEqual(await submit(dir, f), { ad_id: '123', pending_slot: false });
  assert.equal(insertCalls(f).length, 1);
});

// ---- titleHints ----

const hints = async (s) => (await import('../scripts/lib/post.mjs')).titleHints(s);

test('titleHints: an ordinary title gives no hints', async () => {
  for (const s of ['Диван угловой, ткань', 'Шины зимние 205/55 R16', 'Фильтр масляный 0 280 158 827', 'Стеллаж 4 ряда', 'Флешка 128 ГБ']) {
    assert.deepEqual(await hints(s), [], s);
  }
});

test('titleHints: selling_word at the start of the title', async () => {
  for (const s of ['Продам iPhone 12', 'продаю велосипед', 'Продается диван', 'ПРОДАЁТСЯ гараж', 'Куплю шины', 'Срочно нужен диван', '   Продам стол', 'Продам: стол']) {
    assert.deepEqual(await hints(s), ['selling_word'], s);
  }
});

test('titleHints: selling_word is not given for a longer word or a word not at the start', async () => {
  for (const s of ['Продамся', 'Срочное дело', 'Диван, продам', 'Продажа гаража', 'Куплютка']) {
    assert.deepEqual(await hints(s), [], s);
  }
});

test('titleHints: price in rubles, currencies and signs', async () => {
  for (const s of ['Диван 100 руб', 'Диван 100р.', 'Диван 100 р', 'Диван 100руб.', 'Диван 5 рублей', 'Диван 5 рубля', 'Диван 100 BYN', 'Диван 50usd', 'Диван 50 EUR', 'Диван $50', 'Диван за €']) {
    assert.deepEqual(await hints(s), ['price'], s);
  }
});

test('titleHints: price is not given for words that only look like it', async () => {
  for (const s of ['Стеллаж 4 ряда', 'Шины R16', 'Шины 205/55', 'Колесо 4 рубина', 'Телефон 5 euro', 'Деталь 12 рамка', 'Масло 5W-40 4 литра']) {
    assert.deepEqual(await hints(s), [], s);
  }
});

test('titleHints: contact in the title', async () => {
  for (const s of ['Диван пишите a@b.example', 'Диван http://example.com', 'Диван https://example.com', 'Диван www.example.com',
    'Диван +375 29 000-00-00', 'Диван +375(29)000-00-00', 'Диван 80290000000', 'Диван 80 29 000 00 00']) {
    assert.ok((await hints(s)).includes('contact'), s);
  }
});

test('titleHints: contact is not given for a part number or a short digit run', async () => {
  for (const s of ['Форсунка 0 280 158 827', 'Фильтр 80 мм', 'Деталь 8029000000', 'Диск 375 мм', 'Шина 205/55 R16 91V']) {
    assert.ok(!(await hints(s)).includes('contact'), s);
  }
});

test('titleHints: glued number and memory unit', async () => {
  for (const s of ['iPhone 128gb', 'Флешка 64гб', 'Диск 1ТБ', 'Диск 512Tb', 'Телефон 128GB чёрный']) {
    assert.deepEqual(await hints(s), ['glued'], s);
  }
});

test('titleHints: glued is not given for a spaced unit or a longer word', async () => {
  for (const s of ['iPhone 128 ГБ', 'Диск 1 TB', 'Флешка 128gbit', 'Модель gb', 'Диск 2tbx']) {
    assert.deepEqual(await hints(s), [], s);
  }
});

test('titleHints: several hints come in the order of the contract, each once', async () => {
  assert.deepEqual(await hints('Срочно 100 руб +375 29 000-00-00 128gb'), ['selling_word', 'price', 'contact', 'glued']);
  assert.deepEqual(await hints('Продам 100 руб 200 руб $5'), ['selling_word', 'price']);
  assert.deepEqual(await hints('Телефон 128gb +375 29 000-00-00'), ['contact', 'glued']);
  assert.deepEqual(await hints('Куплю a@b.example 1ТБ 2ТБ'), ['selling_word', 'contact', 'glued']);
});

test('titleHints: a non-string gives an empty list', async () => {
  for (const v of [undefined, null, 123, {}, ['Продам']]) {
    assert.deepEqual(await hints(v), []);
  }
});

// ---- buildAd: a form field named like a fixed term of the listing ----
// Seen in a live form: in some categories `type` is a required choice field (sell / let).

const TYPE_FIELD = { name: 'type', label: 'Я ищу', required: true, kind: 'choice', values: val('sell', 'let') };

test('buildAd: a form field with the fixed value passes and the term stays fixed', () => {
  assert.equal(adOf({ type: 'sell' }, { fields: [...FIELDS, TYPE_FIELD] }).type, 'sell');
});

test('buildAd: a form field cannot change a fixed term of the listing -> fixed', () => {
  assert.equal(errorsOf({ type: 'let' }, { fields: [...FIELDS, TYPE_FIELD] }).type, 'fixed');
  const flag = { name: 'delivery_enabled', label: 'Доставка', required: false, kind: 'flag' };
  assert.equal(errorsOf({ delivery_enabled: '1' }, { fields: [...FIELDS, flag] }).delivery_enabled, 'fixed');
});
