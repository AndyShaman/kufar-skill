import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  rejectsCode, errText, goodToken, fakeFetch, jsonRes, emptyRes, headersOf,
} from './helpers.mjs';

// the module does not exist yet: it is imported inside each test, so the old tests still load
const edit = () => import('../scripts/lib/edit.mjs');

const TOKEN = goodToken();
const ID = '1000000001';
const UPLOAD_URL = 'https://ads-image-uploader.kufar.by/v1/images';
const UPDATE_URL = `https://api.kufar.by/insertion/v1/processing/update/${ID}`;
const SEGMENTATION = 'routing=web_ad_insertion;application=ad_insertion;platform=web;taxonomy-version=2';
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---- editSupport ----

for (const [name, saved, want] of [
  ['an ordinary listing', { company_ad: '0', delivery_enabled: '0', safedeal_enabled: '0' }, null],
  ['no service keys at all', {}, null],
  ['company_ad "1"', { company_ad: '1' }, 'company'],
  ['company_ad true', { company_ad: true }, 'company'],
  ['delivery_enabled "1"', { delivery_enabled: '1' }, 'delivery'],
  ['delivery_enabled true', { delivery_enabled: true }, 'delivery'],
  ['safedeal_enabled "1"', { safedeal_enabled: '1' }, 'delivery'],
  ['safedeal_enabled true', { safedeal_enabled: true }, 'delivery'],
  ['halva "1"', { halva: '1' }, 'halva'],
  ['halva true', { halva: true }, 'halva'],
  ['halva "0"', { halva: '0' }, null],
]) {
  test(`editSupport: ${name} -> ${want}`, async () => {
    const { editSupport } = await edit();
    assert.equal(editSupport(saved), want);
  });
}

// ---- buildEdit ----

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
const SAVED = {
  category: '2040', type: 'sell', company_ad: '0', language: 'ru', currency: 'BYR', price: '5900', remuneration_type: '1',
  delivery_enabled: '0', safedeal_enabled: '0', name: 'Тест', phone: '375290000000',
  subject: 'Катушка зажигания', body: 'Новая, в упаковке', condition: '2',
  list_id: '1000000001', category_type: 'sell', clear_phone_1: '+375290000000',
  images: [{ media_storage: 'rms', path: 'adim1/a.jpg' }, { media_storage: 'rms', path: 'adim1/b.jpg' }],
};
const EMAIL = 'seller@example.com';
const BASE_AD = {
  category: '2040', type: 'sell', company_ad: '0', language: 'ru', currency: 'BYR', price: '5900', remuneration_type: '1',
  delivery_enabled: '0', safedeal_enabled: '0', name: 'Тест', phone: '375290000000', email: EMAIL,
  subject: 'Катушка зажигания', body: 'Новая, в упаковке', condition: '2',
};
const CHANGE = { subject: 'Новое название' };

const args = (over = {}) => ({
  saved: SAVED, changes: CHANGE, fields: FIELDS, savedFields: FIELDS, type: null, email: EMAIL, ...over,
});
const withSaved = (extra, over = {}) => args({ saved: { ...SAVED, ...extra }, ...over });
const build = async (over) => (await edit()).buildEdit(args(over));
const buildS = async (extra, over) => (await edit()).buildEdit(withSaved(extra, over));

async function failure(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.equal(e.name, 'KufarError');
    assert.equal(e.code, code);
    return e;
  }
  return assert.fail(`no error, wanted ${code}`);
}
const draftErrors = async (promise) => (await failure(promise, 'DRAFT_INVALID')).details.fields;
const errorsOf = (over) => draftErrors(build(over));
const errorsOfS = (extra, over) => draftErrors(buildS(extra, over));

test('buildEdit: the ad holds saved pass-through keys, email, unchanged and changed fields, price as saved', async () => {
  const r = await build();
  assert.deepStrictEqual(r.ad, { ...BASE_AD, subject: 'Новое название' });
});

test('buildEdit: nothing else gets into the ad', async () => {
  const { ad } = await build();
  for (const k of ['list_id', 'clear_phone_1', 'category_type', 'images', 'is_new_image', 'photos']) {
    assert.equal(k in ad, false, k);
  }
});

test('buildEdit: price from changes goes in kopecks', async () => {
  for (const [price, kopecks] of [[50, '5000'], [59.5, '5950'], ['59.50', '5950']]) {
    const { ad } = await build({ changes: { price } });
    assert.equal(ad.price, kopecks);
  }
});

test('buildEdit: type_field_name and type_field_value are set from type', async () => {
  const { ad } = await build({ type: { name: 'condition', url_name: 'cnd' } });
  assert.equal(ad.type_field_name, 'cnd');
  assert.equal(ad.type_field_value, '2');
});

test('buildEdit: no type_field keys when type is null', async () => {
  const { ad } = await build();
  assert.equal('type_field_name' in ad, false);
  assert.equal('type_field_value' in ad, false);
});

test('buildEdit: a changed value is trimmed', async () => {
  const { ad } = await build({ changes: { subject: '  Новое название \n' } });
  assert.equal(ad.subject, 'Новое название');
});

// normalisation of saved values

test('buildEdit: a saved number becomes a string', async () => {
  const { ad } = await buildS({ mileage: 100 });
  assert.equal(ad.mileage, '100');
});
test('buildEdit: a saved true flag becomes "1"', async () => {
  const { ad } = await buildS({ phone_hidden: true });
  assert.equal(ad.phone_hidden, '1');
});
for (const v of [false, null, '']) {
  test(`buildEdit: a saved ${JSON.stringify(v)} means no value, the key is not in the ad`, async () => {
    const { ad } = await buildS({ mileage: v, phone_hidden: v });
    assert.equal('mileage' in ad, false);
    assert.equal('phone_hidden' in ad, false);
  });
}
test('buildEdit: a saved string is trimmed', async () => {
  const { ad } = await buildS({ note: '  abc ' });
  assert.equal(ad.note, 'abc');
});
test('buildEdit: a saved comma string of a choices field becomes an array', async () => {
  const { ad } = await buildS({ tags: 'a,b' });
  assert.deepStrictEqual(ad.tags, ['a', 'b']);
});
test('buildEdit: a saved body with spaces at the edges and no real change -> NO_CHANGES', async () => {
  await failure(buildS({ body: '  Новая, в упаковке  ' }, { changes: { body: 'Новая, в упаковке' } }), 'NO_CHANGES');
});

// EDIT_UNSUPPORTED

test('buildEdit: a saved key that is not understood -> EDIT_UNSUPPORTED with the sorted names', async () => {
  const e = await failure(buildS({ zeta: '1', mystery: 'x' }), 'EDIT_UNSUPPORTED');
  assert.deepStrictEqual(e.details, { reason: 'dropped', dropped: ['mystery', 'zeta'] });
});
test('buildEdit: EDIT_UNSUPPORTED comes before DRAFT_INVALID', async () => {
  await failure(buildS({ mystery: 'x' }, { changes: { nope: '1', price: 0 } }), 'EDIT_UNSUPPORTED');
});
test('buildEdit: the listed service keys do not trigger EDIT_UNSUPPORTED', async () => {
  const extra = {
    refusal_reason: 'x', deactivated: '1', environment_id: 'e', type_field_name: 'cnd', type_field_value: '2',
  };
  await buildS(extra);
});
test('buildEdit: a saved key with an empty value does not trigger EDIT_UNSUPPORTED', async () => {
  await buildS({ mystery: '', other: null });
});
test('buildEdit: a field in savedFields but not in fields does not trigger EDIT_UNSUPPORTED', async () => {
  const savedFields = [...FIELDS, { name: 'region', label: 'Область', required: false, kind: 'choice', values: val('7') }];
  await buildS({ region: '7' }, { savedFields });
});

// DRAFT_INVALID

for (const key of ['category', 'name', 'phone']) {
  test(`buildEdit: ${key} in changes -> fixed`, async () => {
    assert.equal((await errorsOf({ changes: { ...CHANGE, [key]: '1' } }))[key], 'fixed');
  });
}
test('buildEdit: a key that is neither a service key nor a field -> unknown', async () => {
  assert.equal((await errorsOf({ changes: { mystery: '1' } })).mystery, 'unknown');
});
test('buildEdit: price in changes with a currency other than BYR -> terms', async () => {
  assert.equal((await errorsOfS({ currency: 'USD' }, { changes: { price: 5 } })).price, 'terms');
});
test('buildEdit: price in changes with remuneration_type other than "1" -> terms', async () => {
  assert.equal((await errorsOfS({ remuneration_type: '2' }, { changes: { price: 5 } })).price, 'terms');
});
test('buildEdit: another currency without a price change is fine', async () => {
  const { ad } = await buildS({ currency: 'USD' });
  assert.equal(ad.currency, 'USD');
  assert.equal(ad.price, '5900');
});
for (const email of [undefined, '', '   ', 5]) {
  test(`buildEdit: email ${JSON.stringify(email)} -> required`, async () => {
    assert.equal((await errorsOf({ email })).email, 'required');
  });
}

const PHOTO_BAD = [
  ['not an array', '1'],
  ['longer than 9', Array.from({ length: 10 }, (_, i) => `/a/${i}.jpg`)],
  ['an element of the wrong type', [true]],
  ['an empty string', ['']],
  ['a fraction', [1.5]],
  ['number 0', [0]],
  ['a negative number', [-1]],
  ['a number above the saved count', [3]],
  ['a repeated number', [1, 1]],
];
for (const [name, photos] of PHOTO_BAD) {
  test(`buildEdit: photos ${name} -> bad_value`, async () => {
    assert.equal((await errorsOf({ changes: { photos } })).photos, 'bad_value');
  });
}

test('buildEdit: value rules apply to a changed value', async () => {
  assert.equal((await errorsOf({ changes: { note: 'ab' } })).note, 'length');
  assert.equal((await errorsOf({ changes: { condition: '9' } })).condition, 'not_in_list');
  assert.equal((await errorsOf({ changes: { subject: 'Катушка 🔥' } })).subject, 'emoji');
  assert.equal((await errorsOf({ changes: { price: 0 } })).price, 'bad_value');
  assert.equal((await errorsOf({ changes: { mileage: '12a' } })).mileage, 'bad_value');
});
test('buildEdit: value rules apply to a saved value, the field is named in the errors', async () => {
  assert.equal((await errorsOfS({ subject: 'а'.repeat(51) }, { changes: { body: 'Новое описание' } })).subject, 'length');
  assert.equal((await errorsOfS({ note: 'ab' }, { changes: { body: 'Новое описание' } })).note, 'length');
});
test('buildEdit: a saved required field that is missing -> required', async () => {
  const { condition, ...saved } = SAVED;
  assert.equal((await draftErrors(build({ saved }))).condition, 'required');
});
test('buildEdit: a saved value fixed by the same changes passes', async () => {
  const { ad } = await buildS({ subject: 'а'.repeat(51) }, { changes: { subject: 'Короткое название' } });
  assert.equal(ad.subject, 'Короткое название');
});
test('buildEdit: all errors come in one DRAFT_INVALID', async () => {
  assert.deepEqual(await errorsOf({ changes: { price: 0, condition: '9', mystery: '1', photos: 'x' }, email: undefined }),
    { price: 'bad_value', condition: 'not_in_list', mystery: 'unknown', photos: 'bad_value', email: 'required' });
});

// photos in the answer

test('buildEdit: without photos in changes all saved photos come as paths', async () => {
  const { photos } = await build();
  assert.deepStrictEqual(photos, [{ path: 'adim1/a.jpg' }, { path: 'adim1/b.jpg' }]);
});
test('buildEdit: numbers and files give the mixed ordered list', async () => {
  const { photos } = await build({ changes: { photos: [2, '/x/new.jpg', 1] } });
  assert.deepStrictEqual(photos, [{ path: 'adim1/b.jpg' }, { file: '/x/new.jpg' }, { path: 'adim1/a.jpg' }]);
});
test('buildEdit: an empty photos list is allowed', async () => {
  const r = await build({ changes: { photos: [] } });
  assert.deepStrictEqual(r.photos, []);
  assert.deepStrictEqual(r.changed, [{ name: 'photos', from: 2, to: 0 }]);
});

// changed

test('buildEdit: changed lists a field with from and to', async () => {
  const { changed } = await build();
  assert.deepStrictEqual(changed, [{ name: 'subject', from: 'Катушка зажигания', to: 'Новое название' }]);
});
test('buildEdit: a field that had no value has from null', async () => {
  const { changed } = await build({ changes: { note: 'abc' } });
  assert.deepStrictEqual(changed, [{ name: 'note', from: null, to: 'abc' }]);
});
test('buildEdit: changed follows fields order, then switched-off fields, then price, then photos', async () => {
  const savedFields = [...FIELDS, { name: 'region', label: 'Область', required: false, kind: 'choice', values: val('7') }];
  const { ad, changed } = await buildS({ region: '7' }, {
    savedFields,
    changes: { photos: [1], price: 50, note: 'abc', subject: 'Новое название' },
  });
  assert.deepStrictEqual(changed, [
    { name: 'subject', from: 'Катушка зажигания', to: 'Новое название' },
    { name: 'note', from: null, to: 'abc' },
    { name: 'region', from: '7', to: null },
    { name: 'price', from: '5900', to: '5000' },
    { name: 'photos', from: 2, to: 1 },
  ]);
  assert.equal('region' in ad, false);
});
test('buildEdit: price entry has from null when there was no saved price', async () => {
  const { price, ...saved } = SAVED;
  const { changed, ad } = await build({ saved, changes: { price: 50 } });
  assert.deepStrictEqual(changed, [{ name: 'price', from: null, to: '5000' }]);
  assert.equal(ad.price, '5000');
});
test('buildEdit: no saved price and no price change -> no price in the ad', async () => {
  const { price, ...saved } = SAVED;
  const { ad } = await build({ saved });
  assert.equal('price' in ad, false);
});
test('buildEdit: the same price gives no entry', async () => {
  await failure(build({ changes: { price: 59 } }), 'NO_CHANGES');
});
test('buildEdit: arrays are compared element by element', async () => {
  await failure(buildS({ tags: 'a,b' }, { changes: { tags: ['a', 'b'] } }), 'NO_CHANGES');
  const { changed } = await buildS({ tags: 'a,b' }, { changes: { tags: ['b', 'a'] } });
  assert.deepStrictEqual(changed, [{ name: 'tags', from: ['a', 'b'], to: ['b', 'a'] }]);
});
test('buildEdit: a switched-off flag equals no value', async () => {
  await failure(build({ changes: { phone_hidden: false } }), 'NO_CHANGES');
  await failure(build({ changes: { phone_hidden: '0' } }), 'NO_CHANGES');
  await failure(buildS({ phone_hidden: '0' }, { changes: { phone_hidden: false } }), 'NO_CHANGES');
  await failure(buildS({ phone_hidden: true }, { changes: { phone_hidden: true } }), 'NO_CHANGES');
});
test('buildEdit: switching a flag on and off', async () => {
  const on = await build({ changes: { phone_hidden: true } });
  assert.deepStrictEqual(on.changed, [{ name: 'phone_hidden', from: null, to: '1' }]);
  assert.equal(on.ad.phone_hidden, '1');
  const off = await buildS({ phone_hidden: '1' }, { changes: { phone_hidden: '0' } });
  assert.deepStrictEqual(off.changed, [{ name: 'phone_hidden', from: '1', to: null }]);
  assert.equal('phone_hidden' in off.ad, false);
});
test('buildEdit: a field switched off by the change gives to null and is not in the ad', async () => {
  const savedFields = [...FIELDS, { name: 'region', label: 'Область', required: false, kind: 'choice', values: val('7') }];
  const { ad, changed } = await buildS({ region: '7' }, { savedFields });
  assert.deepStrictEqual(changed, [
    { name: 'subject', from: 'Катушка зажигания', to: 'Новое название' },
    { name: 'region', from: '7', to: null },
  ]);
  assert.equal('region' in ad, false);
});
test('buildEdit: photos entry when a file is added', async () => {
  const { changed } = await build({ changes: { photos: [1, 2, '/x/new.jpg'] } });
  assert.deepStrictEqual(changed, [{ name: 'photos', from: 2, to: 3 }]);
});
test('buildEdit: photos entry when the order differs', async () => {
  const { changed } = await build({ changes: { photos: [2, 1] } });
  assert.deepStrictEqual(changed, [{ name: 'photos', from: 2, to: 2 }]);
});
test('buildEdit: photos entry when the count differs', async () => {
  const { changed } = await build({ changes: { photos: [1] } });
  assert.deepStrictEqual(changed, [{ name: 'photos', from: 2, to: 1 }]);
});
test('buildEdit: the same photos in the same order give no entry', async () => {
  await failure(build({ changes: { photos: [1, 2] } }), 'NO_CHANGES');
});

// NO_CHANGES and the order of errors

test('buildEdit: a change equal to the saved value -> NO_CHANGES', async () => {
  await failure(build({ changes: { subject: 'Катушка зажигания' } }), 'NO_CHANGES');
  await failure(build({ changes: { subject: '  Катушка зажигания ' } }), 'NO_CHANGES');
});
test('buildEdit: the order is EDIT_UNSUPPORTED, then DRAFT_INVALID, then NO_CHANGES', async () => {
  await failure(buildS({ mystery: 'x' }, { changes: { subject: 'Катушка зажигания', nope: '1' } }), 'EDIT_UNSUPPORTED');
  await failure(build({ changes: { subject: 'Катушка зажигания', nope: '1' } }), 'DRAFT_INVALID');
  await failure(build({ changes: { subject: 'Катушка зажигания' } }), 'NO_CHANGES');
});

// ---- editCode ----

const KEYS = ['adim1/a.jpg', 'adim1/b.jpg'];
const AD = { category: '2040', price: '5900', subject: 'Катушка' };

test('editCode: 12 characters of 0-9a-f', async () => {
  const { editCode } = await edit();
  assert.match(editCode(ID, AD, KEYS), /^[0-9a-f]{12}$/);
});
test('editCode: the first 12 characters of sha256 of [id, sorted pairs, photo keys]', async () => {
  const { editCode } = await edit();
  const pairs = Object.entries(AD).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.equal(editCode(ID, AD, KEYS), sha(JSON.stringify([ID, pairs, KEYS])).slice(0, 12));
});
test('editCode: stable to the key order of ad', async () => {
  const { editCode } = await edit();
  assert.equal(editCode(ID, { subject: 'Катушка', price: '5900', category: '2040' }, KEYS), editCode(ID, AD, KEYS));
});
test('editCode: changes with the id, a value, a photo key and the photo order', async () => {
  const { editCode } = await edit();
  const base = editCode(ID, AD, KEYS);
  assert.notEqual(editCode('1000000002', AD, KEYS), base);
  assert.notEqual(editCode(ID, { ...AD, price: '5901' }, KEYS), base);
  assert.notEqual(editCode(ID, AD, [KEYS[0], 'cc'.repeat(32)]), base);
  assert.notEqual(editCode(ID, AD, [KEYS[1], KEYS[0]]), base);
});

// ---- updateAd ----

const update = async (fetchImpl, over = {}) => (await edit()).updateAd({ token: TOKEN, id: ID, ad: AD, fetchImpl, ...over });
const refusal = (fields) => jsonRes(422, { code: 'ADINS0001', message: 'ad validation failed', details: { fields } });

test('updateAd: PUT to the update address with the headers and the body', async () => {
  const fetchImpl = fakeFetch(() => jsonRes(200, {}));
  await update(fetchImpl);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, UPDATE_URL);
  assert.equal(call.init.method, 'PUT');
  const h = headersOf(call.init);
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h.authorization, `Bearer ${TOKEN}`);
  assert.equal(h['x-segmentation'], SEGMENTATION);
  assert.match(h['user-agent'], /^kufar-skill\//);
  assert.deepEqual(JSON.parse(call.init.body), { ad: AD, delivery: null });
});

for (const [name, res] of [
  ['a JSON body', () => jsonRes(200, { ad_id: 1 })],
  ['an empty body', () => emptyRes(200)],
  ['a body that is not JSON', () => jsonRes(200, 'not json')],
]) {
  test(`updateAd: 200 with ${name} -> true`, async () => {
    assert.equal(await update(fakeFetch(res)), true);
  });
}

test('updateAd: 422 -> EDIT_REFUSED with the fields parsed like POST_REFUSED', async () => {
  await assert.rejects(update(fakeFetch(() => refusal({
    subject: { message: 'ERROR_NOT_FOUND', translations: { ru: 'Заполните обязательное поле', by: 'x' } },
    body: { message: 'ONLY_MESSAGE' },
  }))), (e) => {
    assert.equal(e.code, 'EDIT_REFUSED');
    assert.deepEqual(e.details.fields, { subject: 'Заполните обязательное поле', body: 'ONLY_MESSAGE' });
    return true;
  });
});
test('updateAd: 422 values are cut to 200 characters and at most 30 fields are kept', async () => {
  await assert.rejects(update(fakeFetch(() => refusal({ common: { translations: { ru: 'x'.repeat(300) } } }))), (e) => {
    assert.equal(e.details.fields.common, 'x'.repeat(200));
    return true;
  });
  const many = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`f${i}`, { message: 'M' }]));
  await assert.rejects(update(fakeFetch(() => refusal(many))), (e) => {
    assert.equal(Object.keys(e.details.fields).length, 30);
    return true;
  });
});

for (const status of [401, 403, 404, 400]) {
  test(`updateAd: ${status} -> EDIT_FAILED with the status`, async () => {
    await assert.rejects(update(fakeFetch(() => jsonRes(status, {}))), (e) => {
      assert.equal(e.code, 'EDIT_FAILED');
      assert.equal(e.details.status, status);
      return true;
    });
  });
}

const UNCONFIRMED = [
  ['500', () => jsonRes(500, {})],
  ['502', () => jsonRes(502, {})],
  ['a rejected fetch', () => { throw new Error(`boom ${TOKEN}`); }],
  ['a timeout error', () => { throw new DOMException('timed out', 'TimeoutError'); }],
];
for (const [name, res] of UNCONFIRMED) {
  test(`updateAd: ${name} -> EDIT_UNCONFIRMED, the key is not in the error`, async () => {
    await assert.rejects(update(fakeFetch(res)), (e) => {
      assert.equal(e.code, 'EDIT_UNCONFIRMED');
      assert.ok(!errText(e).includes(TOKEN));
      return true;
    });
  });
}
test('updateAd: a request that does not finish within timeoutMs -> EDIT_UNCONFIRMED', async () => {
  const hang = async (url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  });
  await rejectsCode(update(hang, { timeoutMs: 30 }), 'EDIT_UNCONFIRMED');
});

test('updateAd: the key is in no refusal or failure', async () => {
  for (const res of [() => refusal({ common: { message: 'M' } }), () => jsonRes(403, {})]) {
    await assert.rejects(update(fakeFetch(res)), (e) => !errText(e).includes(TOKEN));
  }
});

// ---- submitEdit ----

const SUBMIT_AD = { category: '2040', price: '5900', subject: 'Новое название' };
const NEW1 = { file: '/x/1.jpg', ext: 'jpg', bytes: 3, sha256: 'a', data: Buffer.from('one') };
const NEW2 = { file: '/x/2.png', ext: 'png', bytes: 3, sha256: 'b', data: Buffer.from('two') };

// uploads answer adim1/<n>.jpg; the update answers by updateRes
function submitFetch(updateRes = () => jsonRes(200, {})) {
  let n = 0;
  return fakeFetch((url, init, count) => (url === UPLOAD_URL ? jsonRes(200, { path: `adim1/${++n}.jpg` }) : updateRes(url, init, count)));
}
const submit = async (fetchImpl, photos) => (await edit()).submitEdit({ token: TOKEN, id: ID, ad: SUBMIT_AD, photos, fetchImpl });

test('submitEdit: only new photos are uploaded, in order, then one PUT with images and is_new_image in the final order', async () => {
  const f = submitFetch();
  const r = await submit(f, [{ path: 'adim1/a.jpg' }, NEW1, { path: 'adim1/b.jpg' }, NEW2]);
  assert.equal(r, true);
  assert.deepEqual(f.calls.map((c) => c.url), [UPLOAD_URL, UPLOAD_URL, UPDATE_URL]);
  assert.deepEqual(Buffer.from(await f.calls[0].init.body.get('file').arrayBuffer()), NEW1.data);
  assert.deepEqual(Buffer.from(await f.calls[1].init.body.get('file').arrayBuffer()), NEW2.data);
  assert.equal(f.calls[0].init.body.get('file').name, 'photo.jpg');
  assert.equal(f.calls[1].init.body.get('file').name, 'photo.png');
  assert.equal(f.calls[2].init.method, 'PUT');
  const { ad, delivery } = JSON.parse(f.calls[2].init.body);
  assert.equal(delivery, null);
  assert.deepEqual(ad.images, ['adim1/a.jpg', 'adim1/1.jpg', 'adim1/b.jpg', 'adim1/2.jpg']);
  assert.deepEqual(ad.is_new_image, [false, true, false, true]);
  assert.equal(ad.subject, 'Новое название');
});

test('submitEdit: only kept photos -> no upload, is_new_image all false', async () => {
  const f = submitFetch();
  await submit(f, [{ path: 'adim1/b.jpg' }, { path: 'adim1/a.jpg' }]);
  assert.deepEqual(f.calls.map((c) => c.url), [UPDATE_URL]);
  const { ad } = JSON.parse(f.calls[0].init.body);
  assert.deepEqual(ad.images, ['adim1/b.jpg', 'adim1/a.jpg']);
  assert.deepEqual(ad.is_new_image, [false, false]);
});

test('submitEdit: an empty photo list still sends both keys, empty', async () => {
  const f = submitFetch();
  await submit(f, []);
  const { ad } = JSON.parse(f.calls[0].init.body);
  assert.ok('images' in ad);
  assert.ok('is_new_image' in ad);
  assert.deepEqual(ad.images, []);
  assert.deepEqual(ad.is_new_image, []);
});

test('submitEdit: an upload error stops before the PUT', async () => {
  const f = fakeFetch(() => jsonRes(500, {}));
  await rejectsCode(submit(f, [{ path: 'adim1/a.jpg' }, NEW1]), 'PHOTO_FAILED');
  assert.equal(f.calls.filter((c) => c.url === UPDATE_URL).length, 0);
});

test('submitEdit: the errors of the PUT pass through', async () => {
  await rejectsCode(submit(submitFetch(() => jsonRes(500, {})), []), 'EDIT_UNCONFIRMED');
  await rejectsCode(submit(submitFetch(() => jsonRes(403, {})), []), 'EDIT_FAILED');
});

// ---- submitEdit: the record of the last sent edit ----
// Seen live: while the moderator looks at an edit, Kufar gives the previous version back, so a new
// preview shows the same changes and the same code. The record keeps the same edit from going twice.

const HOUR = 60 * 60 * 1000;
async function stateDir() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'kufar-edit-'));
}
const submitS = async (dir, fetchImpl, over = {}) => (await edit()).submitEdit({
  token: TOKEN, id: ID, ad: SUBMIT_AD, photos: [], fetchImpl, stateDir: dir, code: 'aaaaaaaaaaaa', now: () => 1000, ...over,
});

test('submitEdit: the same edit of the same listing within a day -> EDIT_PENDING, nothing is sent', async () => {
  const dir = await stateDir();
  assert.equal(await submitS(dir, submitFetch()), true);
  const f = submitFetch();
  let e;
  await submitS(dir, f, { photos: [NEW1], now: () => 1000 + 23 * HOUR }).catch((x) => { e = x; });
  assert.equal(e?.code, 'EDIT_PENDING');
  assert.equal(e.details.at, 1000);
  assert.equal(f.calls.length, 0);
});

test('submitEdit: another code, another listing or more than a day later -> sent again', async () => {
  const dir = await stateDir();
  await submitS(dir, submitFetch());
  for (const over of [{ code: 'bbbbbbbbbbbb' }, { id: '1000000002', code: 'aaaaaaaaaaaa' }]) {
    const f = submitFetch(() => jsonRes(200, {}));
    assert.equal(await submitS(dir, f, over), true);
    assert.equal(f.calls.length, 1);
    await submitS(dir, submitFetch());
  }
  const f = submitFetch();
  assert.equal(await submitS(dir, f, { now: () => 1000 + 25 * HOUR }), true);
  assert.equal(f.calls.length, 1);
});

test('submitEdit: an edit Kufar refused is not remembered; an unconfirmed one is', async () => {
  for (const [status, code] of [[422, 'EDIT_REFUSED'], [403, 'EDIT_FAILED']]) {
    const dir = await stateDir();
    await rejectsCode(submitS(dir, submitFetch(() => jsonRes(status, {}))), code);
    assert.equal(await submitS(dir, submitFetch()), true);
  }
  const dir = await stateDir();
  await rejectsCode(submitS(dir, submitFetch(() => jsonRes(500, {}))), 'EDIT_UNCONFIRMED');
  const f = submitFetch();
  await rejectsCode(submitS(dir, f), 'EDIT_PENDING');
  assert.equal(f.calls.length, 0);
});

test('submitEdit: a failed photo upload leaves no record', async () => {
  const dir = await stateDir();
  await rejectsCode(submitS(dir, fakeFetch(() => jsonRes(500, {})), { photos: [NEW1] }), 'PHOTO_FAILED');
  assert.equal(await submitS(dir, submitFetch()), true);
});

test('submitEdit: the record holds neither the key nor the text of the listing', async () => {
  const dir = await stateDir();
  await submitS(dir, submitFetch());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const names = await readdir(dir);
  assert.deepEqual(names, ['edit-last.json']);
  const text = await readFile(join(dir, names[0]), 'utf8');
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(SUBMIT_AD.subject));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['at', 'code', 'id']);
});

// ---- buildEdit: a form field named like a term taken as saved ----

const TYPE_FIELD = { name: 'type', label: 'Я ищу', required: true, kind: 'choice', values: val('sell', 'let') };
const withType = (changes) => ({ changes, fields: [...FIELDS, TYPE_FIELD], savedFields: [...FIELDS, TYPE_FIELD] });

test('buildEdit: a change cannot replace a term taken as saved -> fixed', async () => {
  assert.equal((await errorsOfS({}, withType({ type: 'let' }))).type, 'fixed');
});

test('buildEdit: the saved value of such a field is kept when other fields change', async () => {
  const { ad } = await buildS({}, withType({ body: 'Новое описание' }));
  assert.equal(ad.type, 'sell');
});

test('buildEdit: a change that repeats the saved term is not an error, with spaces around too', async () => {
  const flag = { name: 'delivery_enabled', label: 'Доставка', required: false, kind: 'flag' };
  const fields = [...FIELDS, TYPE_FIELD, flag];
  const { ad } = await buildS({}, { changes: { type: ' sell ', delivery_enabled: '0', body: 'Новое описание' }, fields, savedFields: fields });
  assert.equal(ad.type, 'sell');
  assert.equal(ad.delivery_enabled, '0');
});

// ---- audit: a service flag that is off ----

const DELIVERY_FIELD = { name: 'delivery_enabled', label: 'Доставка', required: false, kind: 'flag' };
const WITH_DELIVERY = [...FIELDS, DELIVERY_FIELD];

test('buildEdit: delivery_enabled "0" over a saved "0" or no value is NO_CHANGES', async () => {
  const { buildEdit } = await edit();
  const noValue = { ...SAVED };
  delete noValue.delivery_enabled;
  for (const saved of [SAVED, noValue]) {
    await failure(Promise.resolve().then(() => buildEdit(args({
      saved, changes: { delivery_enabled: '0' }, fields: WITH_DELIVERY, savedFields: WITH_DELIVERY,
    }))), 'NO_CHANGES');
  }
});

test('buildEdit: delivery_enabled "0" next to a real change does not appear in changed', async () => {
  const { buildEdit } = await edit();
  const r = buildEdit(args({
    changes: { delivery_enabled: '0', body: 'Новое описание' }, fields: WITH_DELIVERY, savedFields: WITH_DELIVERY,
  }));
  assert.deepStrictEqual(r.changed.map((c) => c.name), ['body']);
});

test('buildEdit: a number given as a JSON number is accepted and stored as a string', async () => {
  const { ad } = await build({ changes: { mileage: 2020 } });
  assert.equal(ad.mileage, '2020');
  assert.equal((await errorsOf({ changes: { mileage: NaN } })).mileage, 'bad_value');
});
