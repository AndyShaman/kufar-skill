import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const JPEG_ORDER = ['location', 'exif', 'xmp', 'iptc', 'comment', 'other', 'extra'];
const PNG_ORDER = ['exif', 'text', 'time', 'other'];
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = { eXIf: 'exif', tEXt: 'text', zTXt: 'text', iTXt: 'text', tIME: 'time' };
// the chunks a picture is drawn from; any other chunk is dropped
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'sPLT', 'cICP']);

export const isPng = (data) => data.length >= 8 && data.subarray(0, 8).equals(PNG_SIG);
const EXIF_HEAD = 'Exif\0\0';

const ordered = (found, order) => order.filter((t) => found.has(t));

// the IFD0 entries of an Exif APP1 payload ({ entries: Map tag -> u16 value, next }), or null when malformed
function readIfd0(tiff) {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const r16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const r32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = r32(4);
  if (ifd + 2 > tiff.length) return null;
  const n = r16(ifd);
  if (ifd + 2 + n * 12 + 4 > tiff.length) return null;
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    entries.set(r16(e), r16(e + 8));
  }
  return { entries, next: r32(ifd + 2 + n * 12) };
}

// an Exif APP1 with nothing but the Orientation tag
function orientationSegment(value) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(value, 18);
  const payload = Buffer.concat([Buffer.from(EXIF_HEAD, 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// where the picture ends: right after its end marker, or at the last byte when there is none
function jpegEnd(data, pos) {
  let i = pos + 2 + data.readUInt16BE(pos + 2);
  while (i + 1 < data.length) {
    if (data[i] !== 0xff) i += 1;
    else if (data[i + 1] === 0xff) i += 1;
    else if (data[i + 1] === 0 || (data[i + 1] >= 0xd0 && data[i + 1] <= 0xd7)) i += 2;
    else if (data[i + 1] === 0xd9) return i + 2;
    // a marker between scans: skip it with its payload
    else if (i + 4 <= data.length) i += 2 + data.readUInt16BE(i + 2);
    else break;
  }
  return data.length;
}

function cleanJpeg(data) {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  const kept = [];
  const found = new Set();
  let orientation;
  let pos = 2;
  for (;;) {
    // fill bytes before a marker
    while (pos + 1 < data.length && data[pos] === 0xff && data[pos + 1] === 0xff) pos += 1;
    if (pos + 4 > data.length || data[pos] !== 0xff) return null;
    const marker = data[pos + 1];
    if (marker === 0xd9) return null;
    const len = data.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > data.length) return null;
    if (marker === 0xda) break;
    const segment = data.subarray(pos, pos + 2 + len);
    const payload = segment.subarray(4);
    pos += 2 + len;
    if (marker === 0xe1 && payload.toString('latin1', 0, 6) === EXIF_HEAD) {
      const ifd0 = readIfd0(payload.subarray(6));
      // kept only when there is no room in it for anything but the tag
      if (payload.length === 32 && ifd0 && ifd0.entries.size === 1 && ifd0.entries.has(0x0112) && ifd0.next === 0) {
        kept.push(segment);
        continue;
      }
      found.add('exif');
      if (ifd0?.entries.has(0x8825)) found.add('location');
      const o = ifd0?.entries.get(0x0112);
      if (o >= 2 && o <= 8) orientation = o;
    } else if (marker === 0xe1) found.add('xmp');
    else if (marker === 0xed) found.add('iptc');
    else if (marker === 0xfe) found.add('comment');
    else if (marker === 0xe0) {
      // APP0 stays only as the JFIF header: its own thumbnail and the JFXX one are small copies of the picture
      if (payload.length < 14 || payload.toString('latin1', 0, 5) !== 'JFIF\0') found.add('other');
      else if (payload.length === 14 && payload[12] === 0 && payload[13] === 0) kept.push(segment);
      else {
        found.add('other');
        kept.push(Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), payload.subarray(0, 12), Buffer.from([0, 0])]));
      }
    }
    // of the other application segments a picture needs the colour profile and the Adobe colour note
    else if (marker >= 0xe1 && marker <= 0xef && marker !== 0xee
      && !(marker === 0xe2 && payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0')) found.add('other');
    else kept.push(segment);
  }
  if (orientation !== undefined) kept.splice(kept[0]?.[1] === 0xe0 ? 1 : 0, 0, orientationSegment(orientation));
  // what follows the picture (a second image, a video of a live photo) carries hidden data of its own
  const end = jpegEnd(data, pos);
  if (end < data.length) found.add('extra');
  return { data: Buffer.concat([data.subarray(0, 2), ...kept, data.subarray(pos, end)]), removed: ordered(found, JPEG_ORDER) };
}

function cleanPng(data) {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIG)) return null;
  const kept = [data.subarray(0, 8)];
  const found = new Set();
  let pos = 8;
  for (;;) {
    if (pos + 12 > data.length) return null;
    const end = pos + 12 + data.readUInt32BE(pos);
    if (end > data.length) return null;
    const type = data.toString('latin1', pos + 4, pos + 8);
    if (PNG_KEEP.has(type)) kept.push(data.subarray(pos, end));
    else found.add(PNG_DROP[type] ?? 'other');
    pos = end;
    if (type === 'IEND') break;
  }
  return { data: Buffer.concat(kept), removed: ordered(found, PNG_ORDER) };
}

// the image without the data hidden in it (where and when it was shot, the camera, comments); null when the bytes are not that image
export function cleanPhoto(data, ext) {
  return ext === 'png' ? cleanPng(data) : cleanJpeg(data);
}

const run = promisify(execFile);

// HEIC -> JPEG with the tool that comes with macOS, in a temp folder that is removed afterwards
export async function convertHeic(file) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kufar-heic-'));
  try {
    const out = path.join(dir, 'photo.jpg');
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', path.resolve(file), '--out', out], { timeout: 30000 });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
