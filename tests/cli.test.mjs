import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'kufar.mjs');

async function run(args) {
  const stateDir = await tmpDir();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env, KUFAR_STATE_DIR: stateDir },
  });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  return { status: r.status, json, stdout: r.stdout };
}

const errorCases = [
  [[], 'BAD_ARGS'],
  [['bogus'], 'BAD_ARGS'],
  [['search', '--bogus'], 'BAD_ARGS'],
  [['search'], 'BAD_ARGS'],
  [['search', '--cat', '17010', '--param', 'phm'], 'BAD_ARGS'],
  [['search', '--cat', '17010', '--limit', 'abc'], 'BAD_ARGS'],
  [['item', 'not-a-ref'], 'BAD_AD_REF'],
  [['price'], 'BAD_ARGS'],
  [['price', '--cat', '17010'], 'BAD_ARGS'],
  [['watch', 'check', 'nope'], 'UNKNOWN_WATCH'],
  [['track', 'remove', '123'], 'NOT_TRACKED'],
];

for (const [args, code] of errorCases) {
  test(`kufar ${args.join(' ') || '(no args)'} -> ${code}`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.ok(r.json, `stdout is not one JSON object: ${r.stdout}`);
    assert.equal(r.json.error.code, code);
  });
}

test('watch list on empty state', async () => {
  const r = await run(['watch', 'list']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { watches: [] });
});

test('track list on empty state', async () => {
  const r = await run(['track', 'list']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { tracked: [] });
});
