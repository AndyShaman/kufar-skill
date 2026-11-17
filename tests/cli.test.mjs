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

// ---- step 2: login and read-only account commands ----

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { makeToken, liveToken, assertCookieRequestsSafe } from './helpers.mjs';

// same as run(), but in a given state dir and with optional text on stdin
function runIn(stateDir, args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000, input, env: { ...process.env, KUFAR_STATE_DIR: stateDir },
  });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  return { status: r.status, json, stdout: r.stdout };
}

const UUID = '11111111-2222-4333-8444-555555555555';

test('whoami on empty state', async () => {
  const r = await run(['whoami']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { logged_in: false });
});

test('logout on empty state', async () => {
  const r = await run(['logout']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { logged_in: false });
});

for (const args of [['my'], ['inbox'], ['inbox', '--unread'], ['my', '--status', 'inactive']]) {
  test(`kufar ${args.join(' ')} without login -> AUTH_REQUIRED`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.equal(r.json.error.code, 'AUTH_REQUIRED');
  });
}

test('kufar chat not-a-uuid -> BAD_ARGS', async () => {
  const r = await run(['chat', 'not-a-uuid']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
});

test('kufar chat without id -> BAD_ARGS', async () => {
  const r = await run(['chat']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
});

test('kufar my --status bogus -> BAD_ARGS', async () => {
  const r = await run(['my', '--status', 'bogus']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
});

test('kufar inbox --limit 0 -> BAD_ARGS', async () => {
  const r = await run(['inbox', '--limit', '0']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
});

test('unknown command message lists the new commands', async () => {
  const r = await run(['bogus']);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  for (const cmd of ['login', 'logout', 'whoami', 'my', 'inbox', 'chat']) {
    assert.match(r.json.error.message, new RegExp(`\\b${cmd}\\b`), cmd);
  }
  assert.doesNotMatch(JSON.stringify(r.json), /login-worker/, 'the hidden command is not listed');
});

const loginBadArgs = [
  [['login', '--token-stdin', '--wait', '60'], '--token-stdin together with --wait'],
  [['login', '--wait', '5'], '--wait below 30'],
  [['login', '--wait', '901'], '--wait above 900'],
  [['login', '--wait', 'abc'], '--wait not a number'],
  [['login', '--wait', '60.5'], '--wait not an integer'],
  [['login', '--from-browser'], '--from-browser no longer exists'],
  [['login', '--port', '9222'], '--port no longer exists'],
  [['login', 'some-positional'], 'positional argument'],
  [['login', '--bogus'], 'unknown option'],
  [['login', '--token-stdin', 'some-positional'], 'positional after --token-stdin'],
  [['login', '--phone', '123'], '--phone that is not a number'],
  [['login', '--phone', 'abc'], '--phone with letters'],
  [['login', '--phone', '+375 (29) 1234567 8'], '--phone with too many digits'],
  [['login', '--code', 'abc'], '--code with letters'],
  [['login', '--code', '123'], '--code too short'],
  [['login', '--code', '123456789'], '--code too long'],
  [['login', '--phone'], '--phone without a value'],
  [['login', '--code'], '--code without a value'],
  [['login', '--wait'], '--wait without a value'],
  [['login', '--phone', '375291234567', '--code', '1234'], '--phone together with --code'],
  [['login', '--code', '1234', '--token-stdin'], '--code together with --token-stdin'],
  [['login', '--phone', '375291234567', '--wait', '60'], '--phone together with --wait'],
  [['login', '--phone', '375291234567', '--token-stdin'], '--phone together with --token-stdin'],
  [['login', '--code', '1234', '--wait', '60'], '--code together with --wait'],
  [['login', '--token-stdin=yes'], 'a value on a flag option'],
];
for (const [args, name] of loginBadArgs) {
  test(`kufar login: ${name} -> BAD_ARGS`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.equal(r.json.error.code, 'BAD_ARGS');
  });
}

// DISPLAY is set in the next two tests so they do not depend on the machine having a screen (linux checks it first)

test('kufar login with KUFAR_BROWSER pointing nowhere -> BROWSER_NOT_FOUND', async () => {
  const dir = await tmpDir();
  const r = spawnSync(process.execPath, [CLI, 'login'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, KUFAR_STATE_DIR: dir, DISPLAY: ':99', KUFAR_BROWSER: '/nonexistent/kufar-test-browser' },
  });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).error.code, 'BROWSER_NOT_FOUND');
  assert.deepEqual(await fs.readdir(dir), [], 'nothing is created in the state dir');
});

test('kufar login with a relative KUFAR_BROWSER -> BAD_ARGS', async () => {
  const dir = await tmpDir();
  const r = spawnSync(process.execPath, [CLI, 'login'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, KUFAR_STATE_DIR: dir, DISPLAY: ':99', KUFAR_BROWSER: 'kufar-test-browser' },
  });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).error.code, 'BAD_ARGS');
});

test('kufar login parse errors give one fixed hint, no details, and do not repeat the arguments', async () => {
  const marks = ['ARG-MARK-ONE', 'ARG-MARK-TWO'];
  const cases = [
    ['login', marks[0]],
    ['login', '--bogus', marks[0]],
    ['login', '--token-stdin', marks[0], marks[1]],
    ['login', `--${marks[0]}`],
    ['login', '--token-stdin=ARG-MARK-ONE'],
    ['login', '--phone', marks[0]],
    ['login', '--code', marks[1]],
    ['login', '--wait', marks[0]],
    ['login', '--phone', '375291234567', '--code', marks[1]],
    ['login', '--phone', '123', '--code', marks[1]],
    ['login', '--wait', '5'],
    ['login', '--phone', '375291234567', '--wait', '60'],
  ];
  const messages = new Set();
  for (const args of cases) {
    const r = await run(args);
    assert.equal(r.json.error.code, 'BAD_ARGS');
    assert.equal(r.json.error.details, undefined);
    assert.ok(!r.stdout.includes('ARG-MARK'), r.stdout);
    messages.add(r.json.error.message);
  }
  assert.equal(messages.size, 1, 'the hint message is the same for every parse error');
});

test('login --token-stdin, then whoami in one state dir (logout is not called: it would use the network)', async () => {
  const dir = await tmpDir();
  const token = liveToken();

  const login = runIn(dir, ['login', '--token-stdin'], `${token}\n`);
  assert.equal(login.status, 0);
  assert.equal(login.json.logged_in, true);
  assert.ok(typeof login.json.expires_at === 'string');
  assert.ok(login.json.days_left >= 29 && login.json.days_left <= 30);
  assert.ok(!login.stdout.includes(token));

  const who = runIn(dir, ['whoami']);
  assert.equal(who.status, 0);
  assert.equal(who.json.logged_in, true);
  assert.ok(!who.stdout.includes(token));

  const st = await fs.stat(`${dir}/auth.json`);
  assert.equal(st.mode & 0o777, 0o600);
  for (const f of await fs.readdir(dir)) {
    if (f === 'auth.json') continue;
    assert.ok(!(await fs.readFile(`${dir}/${f}`, 'utf8')).includes(token), `${f} contains the token`);
  }
  assert.equal(who.json.auth_file, path.join(dir, 'auth.json'));
});

test('login --token-stdin with the content of auth.json on stdin -> logged_in, the key stays off the screen', async () => {
  const dir = await tmpDir();
  const token = liveToken();
  const content = JSON.stringify({ token, exp: Date.now() + 86400_000, saved_at: Date.now() });
  const r = runIn(dir, ['login', '--token-stdin'], content);
  assert.equal(r.status, 0);
  assert.equal(r.json.logged_in, true);
  assert.ok(!r.stdout.includes(token));
  const who = runIn(dir, ['whoami']);
  assert.equal(who.json.logged_in, true);
  assert.ok(!who.stdout.includes(token));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'auth.json'), 'utf8')).token, token);
});

test('login --token-stdin with a broken auth.json on stdin -> BAD_TOKEN and nothing echoed', async () => {
  const dir = await tmpDir();
  for (const input of ['{"token":"FILE-MARK-XYZ"}', '{}', '{"token":5}', '{"token":"FILE-MARK-XYZ"']) {
    const r = runIn(dir, ['login', '--token-stdin'], input);
    assert.equal(r.status, 1);
    assert.equal(r.json.error.code, 'BAD_TOKEN');
    assert.ok(!r.stdout.includes('FILE-MARK'));
  }
  assert.deepEqual(runIn(dir, ['whoami']).json, { logged_in: false });
});

test('whoami: a logged-in state shows the absolute auth_file path and no login field', async () => {
  const dir = await tmpDir();
  runIn(dir, ['login', '--token-stdin'], liveToken());
  await fs.writeFile(path.join(dir, 'login-window.json'), JSON.stringify({ state: 'failed', code: 'LOGIN_TIMEOUT', at: Date.now() }));
  const who = runIn(dir, ['whoami']);
  assert.equal(who.json.logged_in, true);
  assert.ok(path.isAbsolute(who.json.auth_file));
  assert.equal(who.json.auth_file, path.join(dir, 'auth.json'));
  assert.equal(who.json.login, undefined);
});

test('logout on an expired key: no network, the file is removed', async () => {
  const dir = await tmpDir();
  const expired = makeToken(Math.floor(Date.now() / 1000) - 86400);
  await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ token: expired, exp: Date.now() + 86400_000, saved_at: 1 }));
  const r = runIn(dir, ['logout']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { logged_in: false });
  assert.ok(!r.stdout.includes(expired));
  assert.deepEqual(await fs.readdir(dir), []);
});

test('logout removes login-pending.json and login profiles, with no key saved (no network)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'login-pending.json'), JSON.stringify({ code_token: 'ct', phone: '375291234567', requested_at: 1, retry_after: 60 }));
  await fs.mkdir(path.join(dir, 'login-profile-0123456789ab', 'Default'), { recursive: true });
  const r = runIn(dir, ['logout']);
  assert.deepEqual(r.json, { logged_in: false });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('login --code 1234 with no code requested -> NO_PENDING_LOGIN (no network)', async () => {
  const r = await run(['login', '--code', '1234']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'NO_PENDING_LOGIN');
});

test('login --code keeps leading zeros: 0123 is a valid code, so no BAD_ARGS', async () => {
  for (const code of ['0123', '00000000']) {
    const r = await run(['login', '--code', code]);
    assert.equal(r.json.error.code, 'NO_PENDING_LOGIN', code);
  }
});

test('login --token-stdin success removes login-window.json (an earlier window failure is not shown any more)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'login-window.json'), JSON.stringify({ state: 'failed', code: 'LOGIN_TIMEOUT', at: Date.now() }));
  const r = runIn(dir, ['login', '--token-stdin'], liveToken());
  assert.equal(r.json.logged_in, true);
  assert.equal(fsSync.existsSync(path.join(dir, 'login-window.json')), false);
});

test('login --token-stdin that fails keeps the window state as it was', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'login-window.json'), JSON.stringify({ state: 'failed', code: 'LOGIN_TIMEOUT', at: Date.now() }));
  runIn(dir, ['login', '--token-stdin'], 'garbage');
  assert.deepEqual(runIn(dir, ['whoami']).json, { logged_in: false, login: { state: 'failed', code: 'LOGIN_TIMEOUT' } });
});

// ---- rule 4 for every command: a long argument is hidden, a short one is shown ----

const HIDDEN = '<скрыто>';
const longToken = liveToken();
const rule4Cases = [
  [['whoami', longToken], 'whoami <key>'],
  [['my', longToken], 'my <key>'],
  [['inbox', longToken], 'inbox <key>'],
  [[longToken], '<key> instead of a command'],
  [['watch', longToken], 'watch <key>'],
  [['track', longToken], 'track <key>'],
  [['logout', longToken], 'logout <key>'],
  [['categories', longToken], 'categories <key>'],
  [['search', longToken], 'search <key>'],
  [['watch', 'list', longToken], 'watch list <key>'],
  [['item', longToken], 'item <key>'],
  [['watch', 'remove', longToken], 'watch remove <key>'],
  [['track', 'add', longToken], 'track add <key>'],
  [['chat', longToken], 'chat <key>'],
];
for (const [args, name] of rule4Cases) {
  test(`rule 4: ${name} -> an error that does not repeat the key`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.ok(r.json.error, r.stdout);
    assert.ok(!r.stdout.includes(longToken), 'the key is in stdout');
    assert.ok(!r.stdout.includes(longToken.slice(0, 41)), 'a part of the key is in stdout');
  });
}

test('rule 4: the hidden marker takes the place of a long argument in the message and in details', async () => {
  const a = await run(['whoami', longToken]);
  assert.ok(a.json.error.message.includes(HIDDEN), a.stdout);
  const b = await run([longToken]);
  assert.equal(b.json.error.details.command, HIDDEN);
  const c = await run(['watch', longToken]);
  assert.equal(c.json.error.details.sub, HIDDEN);
  const d = await run(['track', longToken]);
  assert.equal(d.json.error.details.sub, HIDDEN);
});

test('rule 4: 40 characters are shown, 41 are hidden', async () => {
  const forty = 'a'.repeat(40);
  const shown = await run(['whoami', forty]);
  assert.ok(shown.json.error.message.includes(forty));
  assert.ok(!shown.stdout.includes(HIDDEN));
  const hidden = await run(['whoami', `${forty}b`]);
  assert.ok(!hidden.stdout.includes(forty));
  assert.ok(hidden.json.error.message.includes(HIDDEN));
});

test('rule 4: short arguments are shown as before', async () => {
  const a = await run(['whoami', 'extra']);
  assert.ok(a.json.error.message.includes('extra'));
  const b = await run(['bogus']);
  assert.equal(b.json.error.details.command, 'bogus');
  const c = await run(['watch', 'bogus']);
  assert.equal(c.json.error.details.sub, 'bogus');
});

// ---- the login window, end to end: real CLI, real detached worker, a fake browser program ----

const FAKE_BROWSER = path.join(ROOT, 'tests', 'fixtures', 'fake-browser.mjs');
const E2E = { skip: process.platform === 'win32' ? 'no detached login window on win32' : false, timeout: 90_000 };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function waitFor(fn, { timeoutMs, stepMs = 100 }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return false;
    await sleepMs(stepMs);
  }
}

// own state dir, own log dir; every process started from here is stopped and every directory removed after the test
async function sandbox(t, { mode, extraEnv = {} } = {}) {
  const stateDir = await tmpDir();
  const logDir = await tmpDir();
  const logFile = path.join(logDir, 'fake-browser.jsonl');
  const token = liveToken();
  const env = { ...process.env, KUFAR_STATE_DIR: stateDir, KUFAR_BROWSER: FAKE_BROWSER, FAKE_BROWSER_MODE: mode, FAKE_BROWSER_TOKEN: token, FAKE_BROWSER_LOG: logFile };
  delete env.SSH_CONNECTION; delete env.SSH_TTY;
  if (process.platform === 'linux') { env.DISPLAY = ':99'; delete env.WAYLAND_DISPLAY; }
  Object.assign(env, extraEnv);
  const pids = new Set();
  const sb = {
    stateDir, logFile, token, pids,
    cli(args, input) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 20000, input, env });
      let json;
      try { json = JSON.parse(r.stdout); } catch { json = undefined; }
      assert.ok(!r.stdout.includes(token), `the key is in the output of: ${args.join(' ')}`);
      assert.ok(!(r.stderr ?? '').includes(token), `the key is on stderr of: ${args.join(' ')}`);
      return { status: r.status, json, stdout: r.stdout };
    },
    records() {
      try {
        return fsSync.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch { return []; }
    },
    browserStarts() { return sb.records().filter((r) => r.pid); },
    messages() { return sb.records().filter((r) => r.message).map((r) => r.message); },
    // worker and browser pids, as far as they are known now
    collect() {
      for (const r of sb.browserStarts()) pids.add(r.pid);
      try { pids.add(JSON.parse(fsSync.readFileSync(path.join(stateDir, 'login-window.json'), 'utf8')).pid); } catch { /* none */ }
    },
    profiles: () => (fsSync.existsSync(stateDir) ? fsSync.readdirSync(stateDir).filter((n) => n.startsWith('login-profile')) : []),
  };
  t.after(async () => {
    sb.collect();
    for (const pid of pids) { if (Number.isInteger(pid) && pid > 1 && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    await waitFor(() => [...pids].every((pid) => !isAlive(pid)), { timeoutMs: 3000 });
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(logDir, { recursive: true, force: true });
  });
  return sb;
}

test('login window: login returns at once, the worker waits for the human, whoami shows the result', E2E, async (t) => {
  const sb = await sandbox(t, { mode: 'login' });
  const started = Date.now();
  const r = sb.cli(['login', '--wait', '30']);
  assert.ok(Date.now() - started < 5000, `login took ${Date.now() - started} ms`);
  assert.equal(r.status, 0);
  assert.equal(r.json.login, 'window_opened');
  assert.equal(r.json.seconds_left, 30);
  sb.collect();
  assert.equal(sb.pids.size, 1, 'the worker pid is in login-window.json');

  const who = await waitFor(() => { const w = sb.cli(['whoami']); return w.json?.logged_in === true ? w : null; }, { timeoutMs: 15000, stepMs: 250 });
  assert.ok(who, 'whoami did not report a login within 15 seconds');
  assert.equal(who.json.auth_file, path.join(sb.stateDir, 'auth.json'));
  assert.equal(JSON.parse(await fs.readFile(who.json.auth_file, 'utf8')).token, sb.token);
  sb.collect();

  // after the login: no profile, no window state, worker and browser gone
  const clean = await waitFor(() => sb.profiles().length === 0 && !fsSync.existsSync(path.join(sb.stateDir, 'login-window.json')), { timeoutMs: 10000 });
  assert.ok(clean, `left in the state dir: ${fsSync.readdirSync(sb.stateDir)}`);
  const gone = await waitFor(() => [...sb.pids].every((pid) => !isAlive(pid)), { timeoutMs: 10000 });
  assert.ok(gone, 'a worker or browser process is still running');
  assert.deepEqual(fsSync.readdirSync(sb.stateDir).sort(), ['auth.json']);
  assert.equal(sb.cli(['whoami']).json.logged_in, true);

  // how the browser was started and what it was asked
  const starts = sb.browserStarts();
  assert.equal(starts.length, 1);
  const { argv } = starts[0];
  assert.ok(argv.includes('--remote-debugging-pipe'));
  assert.ok(!argv.some((a) => a.startsWith('--remote-debugging-port') || a.startsWith('--headless')));
  assert.ok(argv.includes('https://www.kufar.by/login/'));
  const profileArg = argv.find((a) => a.startsWith('--user-data-dir='));
  assert.match(path.basename(profileArg.slice('--user-data-dir='.length)), /^login-profile-[0-9a-f]{12}$/);
  assert.equal(path.dirname(profileArg.slice('--user-data-dir='.length)), sb.stateDir);
  assertCookieRequestsSafe(sb.messages());
  assert.ok(sb.messages().some((m) => m.method === 'Network.getCookies'));
});

test('login window: a second login while the first waits -> waiting; logout stops the worker and the browser', E2E, async (t) => {
  const sb = await sandbox(t, { mode: 'never' });
  const first = sb.cli(['login', '--wait', '60']);
  assert.equal(first.json.login, 'window_opened');
  sb.collect();
  assert.ok(await waitFor(() => sb.browserStarts().length === 1, { timeoutMs: 10000 }), 'the browser did not start');
  sb.collect();
  assert.equal(sb.pids.size, 2, 'worker and browser');
  assert.equal(sb.profiles().length, 1);

  const second = sb.cli(['login']);
  assert.equal(second.status, 0);
  assert.equal(second.json.login, 'waiting');
  assert.ok(second.json.seconds_left > 0 && second.json.seconds_left <= 60);
  await sleepMs(300);
  assert.equal(sb.browserStarts().length, 1, 'no second window');

  const who = sb.cli(['whoami']);
  assert.equal(who.json.logged_in, false);
  assert.equal(who.json.login.state, 'waiting');
  assert.equal(who.json.auth_file, undefined);

  const out = sb.cli(['logout']);
  assert.equal(out.status, 0);
  assert.deepEqual(out.json, { logged_in: false });

  const gone = await waitFor(() => sb.profiles().length === 0 && [...sb.pids].every((pid) => !isAlive(pid)), { timeoutMs: 10000 });
  assert.ok(gone, `profiles: ${sb.profiles()}, alive: ${[...sb.pids].filter(isAlive)}`);
  assert.equal(fsSync.existsSync(path.join(sb.stateDir, 'auth.json')), false);
  const after = sb.cli(['whoami']);
  assert.deepEqual(after.json, { logged_in: false }, 'a stopped login must not be shown as a failure');
  assertCookieRequestsSafe(sb.messages());
});

test('login window: a window state of a failed login is shown by whoami', E2E, async (t) => {
  const sb = await sandbox(t, { mode: 'never' });
  await fs.writeFile(path.join(sb.stateDir, 'login-window.json'), JSON.stringify({ state: 'failed', code: 'LOGIN_TIMEOUT', at: Date.now() }));
  const who = sb.cli(['whoami']);
  assert.equal(who.status, 0);
  assert.equal(who.json.logged_in, false);
  assert.equal(who.json.login.state, 'failed');
  assert.equal(who.json.login.code, 'LOGIN_TIMEOUT');
});

test('login window: a waiting state whose worker is gone is shown as failed', E2E, async (t) => {
  const sb = await sandbox(t, { mode: 'never' });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(dead.stdout);
  await fs.writeFile(path.join(sb.stateDir, 'login-window.json'), JSON.stringify({ state: 'waiting', pid, started_at: Date.now(), deadline: Date.now() + 60_000 }));
  const who = sb.cli(['whoami']);
  assert.equal(who.json.logged_in, false);
  assert.equal(who.json.login.state, 'failed');
  assert.equal(who.json.login.code, 'BROWSER_UNAVAILABLE');
});

test('login window: no screen -> NO_DISPLAY, no worker, nothing created', E2E, async (t) => {
  const extraEnv = process.platform === 'linux'
    ? { DISPLAY: '', WAYLAND_DISPLAY: '' }
    : { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' };
  const sb = await sandbox(t, { mode: 'login', extraEnv });
  const r = sb.cli(['login']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'NO_DISPLAY');
  assert.deepEqual(fsSync.readdirSync(sb.stateDir), []);
  assert.equal(sb.browserStarts().length, 0);
});

test('login window: the hidden login-worker prints nothing and exits 0 even when it fails', E2E, async (t) => {
  const sb = await sandbox(t, { mode: 'login', extraEnv: { KUFAR_BROWSER: '/nonexistent/kufar-test-browser' } });
  const r = spawnSync(process.execPath, [CLI, 'login-worker', '--wait', '30'], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, KUFAR_STATE_DIR: sb.stateDir, KUFAR_BROWSER: '/nonexistent/kufar-test-browser', ...(process.platform === 'linux' ? { DISPLAY: ':99' } : {}) },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.deepEqual(sb.cli(['whoami']).json.login, { state: 'failed', code: 'BROWSER_NOT_FOUND' });
});

test('login --token-stdin accepts a k_jwt= value with a trailing ;', async () => {
  const dir = await tmpDir();
  const token = liveToken();
  const r = runIn(dir, ['login', '--token-stdin'], `k_jwt=${token};\n`);
  assert.equal(r.status, 0);
  assert.equal(r.json.logged_in, true);
  assert.ok(!r.stdout.includes(token));
});

test('login --token-stdin with garbage -> BAD_TOKEN and the text is not echoed', async () => {
  const dir = await tmpDir();
  const r = runIn(dir, ['login', '--token-stdin'], 'GARBAGE-MARK-XYZ\n');
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_TOKEN');
  assert.ok(!r.stdout.includes('GARBAGE-MARK'));
  assert.deepEqual(runIn(dir, ['whoami']).json, { logged_in: false });
});

test('login --token-stdin with empty stdin -> BAD_TOKEN', async () => {
  const r = runIn(await tmpDir(), ['login', '--token-stdin'], '');
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_TOKEN');
});

test('login --token-stdin with more than 16 KB -> BAD_TOKEN, nothing echoed, nothing saved', async () => {
  const dir = await tmpDir();
  const r = runIn(dir, ['login', '--token-stdin'], `BIG-MARK-${'A'.repeat(20000)}`);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_TOKEN');
  assert.ok(!r.stdout.includes('BIG-MARK'));
  assert.deepEqual(runIn(dir, ['whoami']).json, { logged_in: false });
});

test('login --token-stdin with an expired token -> AUTH_EXPIRED, nothing saved', async () => {
  const dir = await tmpDir();
  const token = makeToken(Math.floor(Date.now() / 1000) - 86400);
  const r = runIn(dir, ['login', '--token-stdin'], token);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'AUTH_EXPIRED');
  assert.ok(!r.stdout.includes(token));
  assert.deepEqual(runIn(dir, ['whoami']).json, { logged_in: false });
});

test('login with the token as an argument -> BAD_ARGS and the token is not in stdout', async () => {
  const dir = await tmpDir();
  const token = liveToken();
  const r = runIn(dir, ['login', token]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.ok(!r.stdout.includes(token));
  assert.deepEqual(runIn(dir, ['whoami']).json, { logged_in: false });
});

test('login --wait with the token as its value -> BAD_ARGS and the token is not in stdout', async () => {
  const token = liveToken();
  const r = runIn(await tmpDir(), ['login', '--wait', token]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.ok(!r.stdout.includes(token));
});

test('login --token-stdin with the token as an argument too -> BAD_ARGS and the token is not in stdout', async () => {
  const token = liveToken();
  const r = runIn(await tmpDir(), ['login', '--token-stdin', token], token);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.ok(!r.stdout.includes(token));
});

// ---- idle key and blocked state dir (no network) ----

const DAY_MS = 86_400_000;
const nonExistent = (file) => !fsSync.existsSync(file);

// state dir with a live key last used `idleDays` ago, on the real clock
async function idleDir({ idleDays = 31, expired = false, withUse = true } = {}) {
  const dir = await tmpDir();
  const token = expired ? makeToken(Math.floor(Date.now() / 1000) - 86400) : liveToken();
  await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ token, exp: Date.now() + 30 * DAY_MS, saved_at: Date.now() - idleDays * DAY_MS }));
  if (withUse) await fs.writeFile(path.join(dir, 'auth-use.json'), JSON.stringify({ used_at: Date.now() - idleDays * DAY_MS }));
  return { dir, token };
}

test('track list with an idle key: the usual answer, auth.json and auth-use.json are removed', async () => {
  const { dir } = await idleDir();
  const r = runIn(dir, ['track', 'list']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { tracked: [] });
  assert.ok(nonExistent(path.join(dir, 'auth.json')));
  assert.ok(nonExistent(path.join(dir, 'auth-use.json')));
});

test('track list with a fresh key: auth.json stays', async () => {
  const { dir } = await idleDir({ idleDays: 1 });
  const r = runIn(dir, ['track', 'list']);
  assert.equal(r.status, 0);
  assert.ok(fsSync.existsSync(path.join(dir, 'auth.json')));
});

test('whoami with an idle key -> { logged_in: false, idle_removed: true }', async () => {
  const { dir, token } = await idleDir();
  const r = runIn(dir, ['whoami']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { logged_in: false, idle_removed: true });
  assert.ok(!r.stdout.includes(token));
});

test('my with an idle key -> AUTH_IDLE, exit 1, no key in the output', async () => {
  const { dir, token } = await idleDir();
  const r = runIn(dir, ['my']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'AUTH_IDLE');
  assert.ok(!r.stdout.includes(token));
});

test('chat not-a-uuid with an idle key -> BAD_ARGS', async () => {
  const { dir } = await idleDir();
  const r = runIn(dir, ['chat', 'not-a-uuid']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
});

test('whoami after login --token-stdin shows idle_days_left', async () => {
  const dir = await tmpDir();
  runIn(dir, ['login', '--token-stdin'], liveToken());
  const who = runIn(dir, ['whoami']);
  assert.equal(who.json.logged_in, true);
  assert.ok(who.json.idle_days_left >= 29 && who.json.idle_days_left <= 30, String(who.json.idle_days_left));
});

test('logout with an idle and expired key works as before: no network, files removed, logged_in false', async () => {
  const { dir } = await idleDir({ expired: true });
  const r = runIn(dir, ['logout']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { logged_in: false });
  assert.ok(nonExistent(path.join(dir, 'auth.json')));
  assert.ok(nonExistent(path.join(dir, 'auth-use.json')));
});

const CANT_CHMOD = process.getuid?.() === 0 || process.platform === 'win32';
for (const args of [['whoami'], ['track', 'list']]) {
  test(`kufar ${args.join(' ')} with a state dir of permissions 000 -> STATE_BLOCKED, no path in the output`, { skip: CANT_CHMOD && 'permissions are not enforced here' }, async () => {
    const dir = await tmpDir();
    await fs.chmod(dir, 0o000);
    try {
      const r = runIn(dir, args);
      assert.equal(r.status, 1);
      assert.equal(r.json?.error?.code, 'STATE_BLOCKED', r.stdout);
      assert.ok(!r.stdout.includes(dir), 'the state dir path is in the output');
    } finally {
      await fs.chmod(dir, 0o700);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
