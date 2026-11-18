import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveStateDir, readJson, writeJsonAtomic, cached } from '../skills/kufar/scripts/lib/storage.mjs';
import { tmpDir, throwsCode } from './helpers.mjs';

test('resolveStateDir uses absolute KUFAR_STATE_DIR', () => {
  assert.equal(resolveStateDir({ KUFAR_STATE_DIR: '/abs/state', HOME: '/h' }), '/abs/state');
});

test('resolveStateDir rejects relative KUFAR_STATE_DIR', () => {
  throwsCode(() => resolveStateDir({ KUFAR_STATE_DIR: 'rel/state' }), 'BAD_ARGS');
});

test('resolveStateDir uses XDG_STATE_HOME', () => {
  assert.equal(resolveStateDir({ XDG_STATE_HOME: '/x', HOME: '/h' }), path.join('/x', 'kufar-skill'));
});

test('resolveStateDir falls back to HOME/.local/state', () => {
  assert.equal(resolveStateDir({ HOME: '/h' }), path.join('/h', '.local', 'state', 'kufar-skill'));
});

test('readJson returns fallback for missing file', async () => {
  const dir = await tmpDir();
  assert.deepEqual(await readJson(path.join(dir, 'nope.json'), { a: 1 }), { a: 1 });
});

test('readJson returns fallback for broken JSON', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'bad.json');
  await fs.writeFile(f, '{oops');
  assert.deepEqual(await readJson(f, []), []);
});

test('writeJsonAtomic creates directory and round-trips', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'sub', 'deep', 'a.json');
  await writeJsonAtomic(f, { x: [1, 2], y: 'я' });
  assert.deepEqual(await readJson(f, null), { x: [1, 2], y: 'я' });
});

test('writeJsonAtomic sets file mode 0600', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'a.json');
  await writeJsonAtomic(f, {});
  assert.equal((await fs.stat(f)).mode & 0o777, 0o600);
});

test('cached returns fresh data without calling loader', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'c.json');
  await fs.writeFile(f, JSON.stringify({ saved_at: 1000, data: 'old' }));
  let calls = 0;
  const r = await cached(f, 1000, async () => { calls++; return 'new'; }, () => 1500);
  assert.equal(r, 'old');
  assert.equal(calls, 0);
});

test('cached reloads expired data and rewrites file', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'c.json');
  await fs.writeFile(f, JSON.stringify({ saved_at: 1000, data: 'old' }));
  let calls = 0;
  const r = await cached(f, 1000, async () => { calls++; return 'new'; }, () => 3000);
  assert.equal(r, 'new');
  assert.equal(calls, 1);
  assert.deepEqual(await readJson(f, null), { saved_at: 3000, data: 'new' });
});

test('cached calls loader when no file exists', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'c.json');
  const r = await cached(f, 1000, async () => 'fresh', () => 5);
  assert.equal(r, 'fresh');
  assert.deepEqual(await readJson(f, null), { saved_at: 5, data: 'fresh' });
});
