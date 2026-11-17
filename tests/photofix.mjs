// Image bytes built by hand for the photo tests (no real pictures, no system tools).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// a temp folder under os.tmpdir() that goes away in t.after
export async function photoDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kufar-photo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---- JPEG ----

export const SOI = Buffer.from([0xff, 0xd8]);
export const EOI = Buffer.from([0xff, 0xd9]);

// one marker segment: FF <marker> <length incl. the two length bytes> <payload>
export function seg(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, Buffer.from(payload)]);
}

export const APP0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
export const APP2 = (n = 16) => seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(n, 0x41)]));
export const DQT = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 3)]));
export const SOF = seg(0xc0, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0]));
// the scan header, the scan bytes (with a stuffed FF00 and a marker-looking FF E1 inside) and EOI
export const SOS_TAIL = Buffer.concat([
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xe1, 0x00, 0x03, 0x77]),
  EOI,
]);

const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/\0';
export const XMP = seg(0xe1, Buffer.concat([Buffer.from(XMP_HEAD, 'latin1'), Buffer.from('<x:xmpmeta>SECRETXMP</x:xmpmeta>')]));
export const IPTC = seg(0xed, Buffer.from('Photoshop 3.0\0SECRETIPTC', 'latin1'));
export const COM = seg(0xfe, Buffer.from('SECRETCOMMENT'));

export const GPS_MARK = 'GPSMARK1';

// a TIFF block: IFD0 with the listed things, in either byte order.
// { orientation, make, gps, nextIfd } -> entries sorted by tag
export function tiff(order, { orientation, make, gps = false, nextIfd = false } = {}) {
  const le = order === 'II';
  const u16 = (v) => { const b = Buffer.alloc(2); (le ? b.writeUInt16LE(v) : b.writeUInt16BE(v)); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); (le ? b.writeUInt32LE(v) : b.writeUInt32BE(v)); return b; };
  const entries = [];
  if (make) entries.push({ tag: 0x010f, type: 2, count: 2, value: Buffer.from('K\0\0\0', 'latin1') });
  if (orientation !== undefined) entries.push({ tag: 0x0112, type: 3, count: 1, value: Buffer.concat([u16(orientation), Buffer.alloc(2)]) });
  const ifd0Size = 2 + (entries.length + (gps ? 1 : 0)) * 12 + 4;
  const gpsOffset = 8 + ifd0Size;
  if (gps) entries.push({ tag: 0x8825, type: 4, count: 1, value: u32(gpsOffset) });
  const ifd0 = Buffer.concat([
    u16(entries.length),
    ...entries.map((e) => Buffer.concat([u16(e.tag), u16(e.type), u32(e.count), e.value])),
    u32(nextIfd ? 8 + ifd0Size + (gps ? 27 : 0) : 0),
  ]);
  const parts = [Buffer.from(order, 'latin1'), u16(42), u32(8), ifd0];
  if (gps) {
    // GPS IFD: one ASCII entry whose value lies right after the IFD
    parts.push(u16(1), u16(0x0002), u16(2), u32(9), u32(gpsOffset + 2 + 12 + 4), u32(0), Buffer.from(`${GPS_MARK}\0`, 'latin1'));
  }
  if (nextIfd) parts.push(Buffer.alloc(6));
  return Buffer.concat(parts);
}

export const exif = (order, opts) => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(order, opts)]));

// SOI + the segments + the scan
export const jpeg = (...segs) => Buffer.concat([SOI, ...segs, SOS_TAIL]);

// the Orientation value of the (first) Exif APP1 of a JPEG, or undefined
export function orientationOf(buf) {
  const at = buf.indexOf('Exif\0\0', 0, 'latin1');
  if (at < 0) return undefined;
  const t = at + 6;
  const le = buf.toString('latin1', t, t + 2) === 'II';
  const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = t + r32(t + 4);
  for (let i = 0; i < r16(ifd); i++) {
    const e = ifd + 2 + i * 12;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return undefined;
}

// how many times a byte string occurs
export const countOf = (buf, str) => {
  let n = 0;
  for (let i = buf.indexOf(str, 0, 'latin1'); i >= 0; i = buf.indexOf(str, i + 1, 'latin1')) n++;
  return n;
};

// A jpeg whose cleaned form is exactly `cleanedSize` bytes: { clean, dirty }, dirty has `extras` after APP0
export function sizedJpeg(cleanedSize, extras = []) {
  const base = jpeg(APP0, APP2(0), DQT).length;
  const pad = cleanedSize - base;
  const kept = [APP0, APP2(pad), DQT];
  return { clean: jpeg(...kept), dirty: jpeg(APP0, ...extras, ...kept.slice(1)) };
}

// ---- PNG ----

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// a chunk with a made-up CRC (the cleaner is not asked to check it)
export function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), Buffer.from(data), Buffer.from([1, 2, 3, 4])]);
}

export const IHDR = chunk('IHDR', Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0]));
export const PHYS = chunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));
export const IDAT = chunk('IDAT', Buffer.from('some compressed bytes'));
export const IEND = chunk('IEND');
export const png = (...chunks) => Buffer.concat([PNG_SIG, ...chunks]);
