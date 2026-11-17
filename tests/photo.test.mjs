import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPhoto } from '../scripts/lib/photo.mjs';
import {
  SOI, APP0, APP2, DQT, SOF, SOS_TAIL, XMP, IPTC, COM, GPS_MARK, seg, tiff, exif, jpeg, orientationOf, countOf,
  PNG_SIG, chunk, IHDR, PHYS, IDAT, IEND, png,
} from './photofix.mjs';

const KEPT = [APP0, APP2(), DQT, SOF];
const CLEAN = jpeg(...KEPT);

// ---- JPEG: what goes ----

test('cleanPhoto jpeg: Exif with the GPS pointer -> location and exif, nothing of them left, the rest byte for byte', () => {
  const src = jpeg(APP0, exif('II', { make: true, gps: true }), APP2(), DQT, SOF);
  const r = cleanPhoto(src, 'jpg');
  assert.deepEqual(r.removed, ['location', 'exif']);
  assert.equal(countOf(r.data, 'Exif'), 0);
  assert.equal(countOf(r.data, GPS_MARK), 0);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: Exif without GPS -> exif only', () => {
  const r = cleanPhoto(jpeg(APP0, exif('MM', { make: true }), APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['exif']);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: XMP -> xmp', () => {
  const r = cleanPhoto(jpeg(APP0, XMP, APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['xmp']);
  assert.equal(countOf(r.data, 'SECRETXMP'), 0);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: another APP1 is dropped and counted as xmp', () => {
  const other = seg(0xe1, Buffer.from('SOMETHING ELSE\0 payload', 'latin1'));
  const r = cleanPhoto(jpeg(APP0, other, APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['xmp']);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: APP13 -> iptc', () => {
  const r = cleanPhoto(jpeg(APP0, IPTC, APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['iptc']);
  assert.equal(countOf(r.data, 'SECRETIPTC'), 0);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: COM -> comment', () => {
  const r = cleanPhoto(jpeg(APP0, COM, APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['comment']);
  assert.equal(countOf(r.data, 'SECRETCOMMENT'), 0);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: all kinds together give the fixed order whatever the order in the file', () => {
  const r = cleanPhoto(jpeg(APP0, COM, IPTC, XMP, exif('II', { make: true, gps: true }), APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['location', 'exif', 'xmp', 'iptc', 'comment']);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: a tag is reported once even when its segment is there twice', () => {
  const r = cleanPhoto(jpeg(APP0, COM, COM, IPTC, IPTC, APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['iptc', 'comment']);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: the ext jpeg is accepted too', () => {
  const r = cleanPhoto(jpeg(APP0, COM, APP2(), DQT, SOF), 'jpeg');
  assert.deepEqual(r.removed, ['comment']);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: a metadata-looking marker inside the scan is left alone', () => {
  // SOS_TAIL holds FF E1 00 03 77 among the scan bytes; everything after SOS is copied as it is
  const r = cleanPhoto(CLEAN, 'jpg');
  assert.deepEqual(r.data.subarray(r.data.length - SOS_TAIL.length), SOS_TAIL);
});

test('cleanPhoto jpeg: without APP0 the kept segments still keep their order', () => {
  const r = cleanPhoto(jpeg(COM, APP2(), XMP, DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['xmp', 'comment']);
  assert.deepEqual(r.data, jpeg(APP2(), DQT, SOF));
});

// ---- JPEG: orientation ----

const afterApp0 = (buf) => 2 + APP0.length;

function assertOneExifAfterApp0(out, rest) {
  assert.equal(countOf(out, 'Exif\0\0'), 1);
  assert.deepEqual(out.subarray(0, afterApp0(out)), Buffer.concat([SOI, APP0]));
  const at = afterApp0(out);
  assert.equal(out[at], 0xff);
  assert.equal(out[at + 1], 0xe1);
  const len = out.readUInt16BE(at + 2);
  assert.equal(out.toString('latin1', at + 4, at + 10), 'Exif\0\0');
  assert.deepEqual(out.subarray(at + 2 + len), rest);
  assert.equal(countOf(out, GPS_MARK), 0);
}

for (const order of ['II', 'MM']) {
  test(`cleanPhoto jpeg: orientation 6 in a ${order} Exif is kept as the only Exif, right after APP0`, () => {
    const src = jpeg(APP0, exif(order, { orientation: 6, make: true, gps: true }), APP2(), DQT, SOF);
    const r = cleanPhoto(src, 'jpg');
    assert.deepEqual(r.removed, ['location', 'exif']);
    assertOneExifAfterApp0(r.data, Buffer.concat([APP2(), DQT, SOF, SOS_TAIL]));
    assert.equal(orientationOf(r.data), 6);
  });

  test(`cleanPhoto jpeg: cleaning the ${order} result again changes nothing and reports nothing`, () => {
    const first = cleanPhoto(jpeg(APP0, exif(order, { orientation: 8, make: true, gps: true }), APP2(), DQT, SOF), 'jpg');
    const second = cleanPhoto(first.data, 'jpg');
    assert.deepEqual(second.data, first.data);
    assert.deepEqual(second.removed, []);
  });
}

test('cleanPhoto jpeg: an Exif with the orientation only is kept as it is and not reported', () => {
  const src = jpeg(APP0, exif('MM', { orientation: 3 }), APP2(), DQT, SOF);
  const r = cleanPhoto(src, 'jpg');
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.data, src);
});

test('cleanPhoto jpeg: the orientation Exif goes after SOI when there is no APP0', () => {
  const r = cleanPhoto(jpeg(exif('II', { orientation: 5, make: true }), APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['exif']);
  assert.deepEqual(r.data.subarray(0, 2), SOI);
  assert.equal(r.data[2], 0xff);
  assert.equal(r.data[3], 0xe1);
  assert.equal(countOf(r.data, 'Exif\0\0'), 1);
  assert.equal(orientationOf(r.data), 5);
});

test('cleanPhoto jpeg: orientation 2 and 7 are kept too', () => {
  for (const o of [2, 7]) {
    const r = cleanPhoto(jpeg(APP0, exif('II', { orientation: o, make: true }), APP2(), DQT, SOF), 'jpg');
    assert.equal(orientationOf(r.data), o);
  }
});

test('cleanPhoto jpeg: orientation 1 means no Exif in the result', () => {
  const r = cleanPhoto(jpeg(APP0, exif('II', { orientation: 1, make: true }), APP2(), DQT, SOF), 'jpg');
  assert.deepEqual(r.removed, ['exif']);
  assert.equal(countOf(r.data, 'Exif'), 0);
  assert.deepEqual(r.data, CLEAN);
});

test('cleanPhoto jpeg: no orientation tag means no Exif in the result', () => {
  const r = cleanPhoto(jpeg(APP0, exif('MM', { make: true, gps: true }), APP2(), DQT, SOF), 'jpg');
  assert.equal(countOf(r.data, 'Exif'), 0);
  assert.deepEqual(r.data, CLEAN);
});

// ---- JPEG: clean and broken input ----

test('cleanPhoto jpeg: a clean file comes back with the same bytes and removed []', () => {
  const r = cleanPhoto(CLEAN, 'jpg');
  assert.deepEqual(r.data, CLEAN);
  assert.deepEqual(r.removed, []);
});

test('cleanPhoto jpeg: the result is a new Buffer and the input is not mutated', () => {
  for (const src of [CLEAN, jpeg(APP0, exif('II', { orientation: 6, make: true, gps: true }), COM, APP2(), DQT, SOF)]) {
    const before = Buffer.from(src);
    const r = cleanPhoto(src, 'jpg');
    assert.ok(Buffer.isBuffer(r.data));
    assert.notEqual(r.data, src);
    assert.deepEqual(src, before);
  }
});

test('cleanPhoto jpeg: bytes that do not start with FF D8 -> null', () => {
  assert.equal(cleanPhoto(Buffer.alloc(300, 7), 'jpg'), null);
  assert.equal(cleanPhoto(png(IHDR, IDAT, IEND), 'jpg'), null);
  assert.equal(cleanPhoto(Buffer.alloc(0), 'jpg'), null);
});

test('cleanPhoto jpeg: a segment whose length runs past the end -> null', () => {
  const bad = Buffer.concat([SOI, APP0, Buffer.from([0xff, 0xe1, 0x01, 0xf4]), Buffer.from('Exif\0\0short', 'latin1')]);
  assert.equal(cleanPhoto(bad, 'jpg'), null);
});

test('cleanPhoto jpeg: a file cut inside a segment header -> null', () => {
  assert.equal(cleanPhoto(Buffer.concat([SOI, APP0, Buffer.from([0xff, 0xe1, 0x00])]), 'jpg'), null);
});

test('cleanPhoto jpeg: no SOS -> null', () => {
  assert.equal(cleanPhoto(Buffer.concat([SOI, APP0, DQT, Buffer.from([0xff, 0xd9])]), 'jpg'), null);
});

// ---- PNG ----

const TEXT = chunk('tEXt', Buffer.from('Comment\0SECRETTEXT', 'latin1'));
const ZTXT = chunk('zTXt', Buffer.from('Software\0\0xx', 'latin1'));
const ITXT = chunk('iTXt', Buffer.from('Title\0\0\0\0\0hello', 'latin1'));
const TIME = chunk('tIME', Buffer.from([0x07, 0xea, 11, 17, 12, 0, 0]));
const EXIF_CHUNK = chunk('eXIf', tiff('MM', { make: true, gps: true }));
const PNG_CLEAN = png(IHDR, PHYS, IDAT, IEND);

test('cleanPhoto png: eXIf -> exif', () => {
  const r = cleanPhoto(png(IHDR, EXIF_CHUNK, PHYS, IDAT, IEND), 'png');
  assert.deepEqual(r.removed, ['exif']);
  assert.deepEqual(r.data, PNG_CLEAN);
});

test('cleanPhoto png: tEXt, zTXt, iTXt are all one tag text', () => {
  for (const c of [TEXT, ZTXT, ITXT]) {
    const r = cleanPhoto(png(IHDR, c, PHYS, IDAT, IEND), 'png');
    assert.deepEqual(r.removed, ['text']);
    assert.deepEqual(r.data, PNG_CLEAN);
  }
  assert.deepEqual(cleanPhoto(png(IHDR, TEXT, ZTXT, ITXT, IDAT, IEND), 'png').removed, ['text']);
});

test('cleanPhoto png: tIME -> time', () => {
  const r = cleanPhoto(png(IHDR, TIME, PHYS, IDAT, IEND), 'png');
  assert.deepEqual(r.removed, ['time']);
  assert.deepEqual(r.data, PNG_CLEAN);
});

test('cleanPhoto png: tags come in the order exif, text, time whatever the order in the file', () => {
  const r = cleanPhoto(png(IHDR, TIME, TEXT, PHYS, EXIF_CHUNK, ITXT, IDAT, IEND), 'png');
  assert.deepEqual(r.removed, ['exif', 'text', 'time']);
  assert.deepEqual(r.data, PNG_CLEAN);
  assert.equal(countOf(r.data, 'SECRETTEXT'), 0);
});

test('cleanPhoto png: other chunks are kept byte for byte, in order', () => {
  const plte = chunk('PLTE', Buffer.from([1, 2, 3, 4, 5, 6]));
  const idat2 = chunk('IDAT', Buffer.from('more'));
  const src = png(IHDR, PHYS, plte, TEXT, IDAT, idat2, IEND);
  assert.deepEqual(cleanPhoto(src, 'png').data, png(IHDR, PHYS, plte, IDAT, idat2, IEND));
});

test('cleanPhoto png: a clean file comes back with the same bytes and removed []', () => {
  const r = cleanPhoto(PNG_CLEAN, 'png');
  assert.deepEqual(r.data, PNG_CLEAN);
  assert.deepEqual(r.removed, []);
});

test('cleanPhoto png: bytes after IEND are dropped', () => {
  const r = cleanPhoto(Buffer.concat([PNG_CLEAN, Buffer.from('TRAILING SECRET')]), 'png');
  assert.deepEqual(r.data, PNG_CLEAN);
});

test('cleanPhoto png: the input is not mutated and the result is a new Buffer', () => {
  const src = png(IHDR, TEXT, IDAT, IEND);
  const before = Buffer.from(src);
  const r = cleanPhoto(src, 'png');
  assert.notEqual(r.data, src);
  assert.deepEqual(src, before);
});

test('cleanPhoto png: a wrong signature -> null', () => {
  assert.equal(cleanPhoto(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), IHDR, IDAT, IEND]), 'png'), null);
  assert.equal(cleanPhoto(CLEAN, 'png'), null);
  assert.equal(cleanPhoto(Buffer.alloc(100, 1), 'png'), null);
});

test('cleanPhoto png: a chunk that runs past the end -> null', () => {
  const cut = IDAT.subarray(0, IDAT.length - 6);
  assert.equal(cleanPhoto(Buffer.concat([PNG_SIG, IHDR, cut]), 'png'), null);
});

test('cleanPhoto png: no IEND -> null', () => {
  assert.equal(cleanPhoto(png(IHDR, PHYS, IDAT), 'png'), null);
  assert.equal(cleanPhoto(PNG_SIG, 'png'), null);
});
