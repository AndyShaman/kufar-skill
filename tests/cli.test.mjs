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

// ---- step 3a: send, only the cases that end before the first request ----

const SEND_BAD_ARGS = [
  [['send'], 'no id'],
  [['send', 'not-a-uuid', '--text', 'Привет'], 'id is not a UUID'],
  [['send', UUID], 'no --text'],
  [['send', UUID, '--text', 'Привет', '--confirm', 'abc'], 'confirm too short'],
  [['send', UUID, '--text', 'Привет', '--confirm', '0123456789abc'], 'confirm too long'],
  [['send', UUID, '--text', 'Привет', '--confirm', '0123456789AB'], 'confirm in upper case'],
  [['send', UUID, '--text', 'Привет', '--confirm', '0123456789gh'], 'confirm with non-hex characters'],
];
for (const [args, why] of SEND_BAD_ARGS) {
  test(`kufar send: ${why} -> BAD_ARGS, exit code 1`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    assert.notEqual(r.json.error.details?.command, 'send', `send is an unknown command: ${r.stdout}`);
  });
}

test('kufar send without login -> AUTH_REQUIRED, exit code 1', async () => {
  const r = await run(['send', UUID, '--text', 'Привет']);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'AUTH_REQUIRED', r.stdout);
});

test('kufar send with a saved key and a text that holds the key -> TEXT_HAS_KEY, exit code 1, the key is not in the output', async () => {
  const { dir, token } = await idleDir({ idleDays: 0 });
  const r = runIn(dir, ['send', UUID, '--text', `вот мой ключ: ${token}`]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'TEXT_HAS_KEY', r.stdout);
  assert.ok(!r.stdout.includes(token), 'the key is in the output');
  assert.ok(!r.stdout.includes('вот мой ключ'), 'the text is in the output');
});

test('kufar send with a saved key and the key split by spaces in the text -> TEXT_HAS_KEY, the key is not in the output', async () => {
  const { dir, token } = await idleDir({ idleDays: 0 });
  const r = runIn(dir, ['send', UUID, '--text', token.match(/.{1,6}/g).join(' ')]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'TEXT_HAS_KEY', r.stdout);
  assert.ok(!r.stdout.includes(token));
});

// ---- step 3c: form, only the cases that end before the first request ----

const FORM_BAD_ARGS = [
  [['form'], 'no --cat'],
  [['form', '--cat', 'abc'], '--cat is not digits'],
  [['form', '--cat', '2040', '--set', 'novalue'], '--set without ='],
  [['form', '--cat', '2040', '--set', '=6'], '--set with an empty name'],
  [['form', '--cat', '2040', '--set', 'category=2040'], '--set category'],
  [['form', '--cat', '2040', '--set', 'company_ad=1'], '--set company_ad'],
  [['form', '--cat', '2040', '--find', ''], 'empty --find'],
];
for (const [args, why] of FORM_BAD_ARGS) {
  test(`kufar form: ${why} -> BAD_ARGS, exit code 1`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    assert.notEqual(r.json.error.details?.command, 'form', `form is an unknown command: ${r.stdout}`);
  });
}

test('unknown command message names form', async () => {
  const r = await run(['bogus']);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.match(r.json.error.message, /\bform\b/);
});

// ---- step 3d: post, only the cases that end before the first request ----

const writeDraft = async (content) => {
  const f = path.join(await tmpDir(), 'draft.json');
  await fs.writeFile(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
};
const GOOD_DRAFT = { category: '2040', subject: 'Катушка зажигания', body: 'Новая, в упаковке', price: 59 };

test('kufar post without --draft -> BAD_ARGS, exit code 1', async () => {
  const r = await run(['post']);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  assert.notEqual(r.json.error.details?.command, 'post', `post is an unknown command: ${r.stdout}`);
});

for (const [confirm, why] of [['abc', 'too short'], ['0123456789abc', 'too long'], ['0123456789AB', 'in upper case'], ['0123456789gh', 'with non-hex characters']]) {
  test(`kufar post: --confirm ${why} -> BAD_ARGS, exit code 1`, async () => {
    const draft = await writeDraft(GOOD_DRAFT);
    const r = await run(['post', '--draft', draft, '--confirm', confirm]);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    assert.notEqual(r.json.error.details?.command, 'post', `post is an unknown command: ${r.stdout}`);
  });
}

test('kufar post: a draft file that does not exist -> BAD_ARGS', async () => {
  const r = await run(['post', '--draft', path.join(await tmpDir(), 'nope.json')]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  assert.notEqual(r.json.error.details?.command, 'post', `post is an unknown command: ${r.stdout}`);
});

test('kufar post: a draft that is not JSON -> BAD_ARGS, the file text is not in the output', async () => {
  const r = await run(['post', '--draft', await writeDraft('not json FILE-MARK')]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  assert.notEqual(r.json.error.details?.command, 'post', `post is an unknown command: ${r.stdout}`);
  assert.ok(!r.stdout.includes('FILE-MARK'));
});

test('kufar post: a draft that is a JSON array -> BAD_ARGS', async () => {
  const r = await run(['post', '--draft', await writeDraft('[1, 2]')]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  assert.notEqual(r.json.error.details?.command, 'post', `post is an unknown command: ${r.stdout}`);
});

test('kufar post: a draft without category -> DRAFT_INVALID', async () => {
  const { category, ...rest } = GOOD_DRAFT;
  const r = await run(['post', '--draft', await writeDraft(rest)]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'DRAFT_INVALID', r.stdout);
});

test('kufar post: category "abc" -> DRAFT_INVALID', async () => {
  const r = await run(['post', '--draft', await writeDraft({ ...GOOD_DRAFT, category: 'abc' })]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'DRAFT_INVALID', r.stdout);
});

test('kufar post: a valid-looking draft without a saved key -> AUTH_REQUIRED', async () => {
  const r = await run(['post', '--draft', await writeDraft(GOOD_DRAFT)]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'AUTH_REQUIRED', r.stdout);
});

test('unknown command message names post', async () => {
  const r = await run(['bogus']);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.match(r.json.error.message, /\bpost\b/);
});

// ---- step 3e: edit, only the cases that end before the first request ----

const EDIT_ID = '1000000001';
const GOOD_CHANGES = { subject: 'Новое название' };
const notUnknown = (r) => assert.notEqual(r.json.error.details?.command, 'edit', `edit is an unknown command: ${r.stdout}`);

for (const [args, why] of [
  [['edit'], 'no id'],
  [['edit', 'abc'], 'a non-digit id and no --changes'],
  [['edit', EDIT_ID], 'no --changes'],
]) {
  test(`kufar edit: ${why} -> BAD_ARGS, exit code 1`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    notUnknown(r);
  });
}

test('kufar edit: a non-digit id -> BAD_ARGS', async () => {
  for (const id of ['abc', '12a', '1.5']) {
    const r = await run(['edit', id, '--changes', await writeDraft(GOOD_CHANGES)]);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    notUnknown(r);
  }
});

for (const [confirm, why] of [['abc', 'too short'], ['0123456789abc', 'too long'], ['0123456789AB', 'in upper case'], ['0123456789gh', 'with non-hex characters']]) {
  test(`kufar edit: --confirm ${why} -> BAD_ARGS, exit code 1`, async () => {
    const r = await run(['edit', EDIT_ID, '--changes', await writeDraft(GOOD_CHANGES), '--confirm', confirm]);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    notUnknown(r);
  });
}

test('kufar edit: a changes file that does not exist -> BAD_ARGS', async () => {
  const r = await run(['edit', EDIT_ID, '--changes', path.join(await tmpDir(), 'nope.json')]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  notUnknown(r);
});

test('kufar edit: a changes file that is not JSON -> BAD_ARGS, the file text is not in the output', async () => {
  const r = await run(['edit', EDIT_ID, '--changes', await writeDraft('not json FILE-MARK')]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  notUnknown(r);
  assert.ok(!r.stdout.includes('FILE-MARK'));
});

for (const [content, why] of [['[1, 2]', 'a JSON array'], ['"FILE-MARK"', 'a JSON string'], ['null', 'null'], ['{}', 'an empty object']]) {
  test(`kufar edit: a changes file that is ${why} -> BAD_ARGS`, async () => {
    const r = await run(['edit', EDIT_ID, '--changes', await writeDraft(content)]);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    notUnknown(r);
    assert.ok(!r.stdout.includes('FILE-MARK'));
  });
}

test('kufar edit: a valid-looking call without a saved key -> AUTH_REQUIRED, like post', async () => {
  const r = await run(['edit', EDIT_ID, '--changes', await writeDraft(GOOD_CHANGES)]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'AUTH_REQUIRED', r.stdout);
  const post = await run(['post', '--draft', await writeDraft(GOOD_DRAFT)]);
  assert.equal(r.json.error.message, post.json.error.message);
});

test('kufar edit: with a saved key a BAD_ARGS answer does not show the key', async () => {
  const dir = await tmpDir();
  const token = liveToken();
  runIn(dir, ['login', '--token-stdin'], `${token}\n`);
  const r = runIn(dir, ['edit', EDIT_ID, '--changes', await writeDraft('{}')]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  assert.ok(!r.stdout.includes(token));
});

test('unknown command message names edit', async () => {
  const r = await run(['bogus']);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.match(r.json.error.message, /\bedit\b/);
});

// ---- step 3f: manage, only the cases that end before the first request ----

const MANAGE_ID = '1000000001';
const manageNotUnknown = (r) => assert.notEqual(r.json.error.details?.command, 'manage', `manage is an unknown command: ${r.stdout}`);

for (const [args, why] of [
  [['manage'], 'no action'],
  [['manage', 'bogus', MANAGE_ID], 'an unknown action'],
  [['manage', 'off'], 'no id'],
  [['manage', 'delete', 'abc'], 'a non-digit id'],
  [['manage', 'prolong', '12a'], 'an id with a letter'],
  [['manage', 'off', MANAGE_ID], 'off without --reason'],
  [['manage', 'off', MANAGE_ID, '--reason', 'bored'], 'off with an unknown --reason'],
  [['manage', 'off', MANAGE_ID, '--reason', 'sold_on_site'], 'sold_on_site without --duration'],
  [['manage', 'off', MANAGE_ID, '--reason', 'other'], 'other without --comment'],
  [['manage', 'activate', MANAGE_ID, '--reason', 'give_up'], 'activate with --reason'],
  [['manage', 'delete', MANAGE_ID, '--comment', 'text'], 'delete with --comment'],
]) {
  test(`kufar ${args.join(' ')}: ${why} -> BAD_ARGS, exit code 1`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    manageNotUnknown(r);
  });
}

for (const [confirm, why] of [['abc', 'too short'], ['0123456789abc', 'too long'], ['0123456789AB', 'in upper case'], ['0123456789gh', 'with non-hex characters']]) {
  test(`kufar manage: --confirm ${why} -> BAD_ARGS, exit code 1`, async () => {
    const r = await run(['manage', 'prolong', MANAGE_ID, '--confirm', confirm]);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    manageNotUnknown(r);
  });
}

test('kufar manage: a valid call without a saved key -> AUTH_REQUIRED, like post', async () => {
  const r = await run(['manage', 'off', MANAGE_ID, '--reason', 'give_up']);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'AUTH_REQUIRED', r.stdout);
  const post = await run(['post', '--draft', await writeDraft(GOOD_DRAFT)]);
  assert.equal(r.json.error.message, post.json.error.message);
});

test('kufar manage: with a saved key a BAD_ARGS answer does not show the key', async () => {
  const dir = await tmpDir();
  const token = liveToken();
  runIn(dir, ['login', '--token-stdin'], `${token}\n`);
  const r = runIn(dir, ['manage', 'off', MANAGE_ID, '--reason', 'bored']);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
  assert.ok(!r.stdout.includes(token));
});

test('kufar manage: a comment that holds the saved key -> TEXT_HAS_KEY, the key is not in the output', async () => {
  const dir = await tmpDir();
  const token = liveToken();
  runIn(dir, ['login', '--token-stdin'], `${token}\n`);
  const r = runIn(dir, ['manage', 'off', MANAGE_ID, '--reason', 'other', '--comment', `see ${token} here`]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'TEXT_HAS_KEY', r.stdout);
  assert.ok(!r.stdout.includes(token));
});

test('unknown command message names manage', async () => {
  const r = await run(['bogus']);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.match(r.json.error.message, /\bmanage\b/);
});

// ---- step 3g: send --ad, only the cases that end before the first request ----

const AD_SEND_BAD_ARGS = [
  [['send', UUID, '--ad', '1000000001', '--text', 'Привет'], 'both a dialog id and --ad'],
  [['send', '--text', 'Привет'], 'neither a dialog id nor --ad'],
  [['send', '--ad', 'abc', '--text', 'Привет'], '--ad is not digits'],
  [['send', '--ad', '10000x', '--text', 'Привет'], '--ad with a letter'],
  [['send', '--ad', '1000000001'], '--ad without --text'],
];
for (const [args, why] of AD_SEND_BAD_ARGS) {
  test(`kufar send: ${why} -> BAD_ARGS, exit code 1, also with a saved key, the key is not in the output`, async () => {
    const r = await run(args);
    assert.equal(r.status, 1);
    assert.equal(r.json?.error?.code, 'BAD_ARGS', r.stdout);
    const { dir, token } = await idleDir({ idleDays: 0 });
    const k = runIn(dir, args);
    assert.equal(k.status, 1);
    assert.equal(k.json?.error?.code, 'BAD_ARGS', k.stdout);
    assert.ok(!k.stdout.includes(token), 'the key is in the output');
  });
}

test('kufar send --ad without login -> AUTH_REQUIRED, exit code 1, the same as send with a dialog id', async () => {
  const r = await run(['send', '--ad', '1000000001', '--text', 'Привет']);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'AUTH_REQUIRED', r.stdout);
  const d = await run(['send', UUID, '--text', 'Привет']);
  assert.equal(r.json.error.message, d.json.error.message);
});

test('kufar send --ad with a saved key and a text that holds the key -> TEXT_HAS_KEY, the key and the text are not in the output', async () => {
  const { dir, token } = await idleDir({ idleDays: 0 });
  const r = runIn(dir, ['send', '--ad', '1000000001', '--text', `вот мой ключ: ${token}`]);
  assert.equal(r.status, 1);
  assert.equal(r.json?.error?.code, 'TEXT_HAS_KEY', r.stdout);
  assert.ok(!r.stdout.includes(token), 'the key is in the output');
  assert.ok(!r.stdout.includes('вот мой ключ'), 'the text is in the output');
});

// ---- the installed skill: only SKILL.md, scripts, references and assets are copied ----

test('the utility runs from a folder that holds scripts only, without package.json', async (t) => {
  const { mkdtemp, cp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'kufar-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../scripts', import.meta.url), join(dir, 'scripts'), { recursive: true });
  // its own state folder: a test never touches the real one
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'kufar.mjs'), 'nosuchcommand'], {
    encoding: 'utf8', env: { ...process.env, KUFAR_STATE_DIR: join(dir, 'state') },
  });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).error.code, 'BAD_ARGS');
});

test('the version in the code is the version of package.json and of SKILL.md', async () => {
  const { readFile } = await import('node:fs/promises');
  const { VERSION } = await import('../scripts/lib/transport.mjs');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.equal(VERSION, pkg.version);
  assert.match(skill, new RegExp(`version: "${VERSION.replaceAll('.', '\\.')}"`));
});

// ---- audit: login keeps the specific BAD_ARGS message ----

test('kufar login --phone/--code with a bad value: BAD_ARGS carries the message of requestCode/confirmCode', async () => {
  const { requestCode, confirmCode } = await import('../scripts/lib/codelogin.mjs');
  const messageOf = async (p) => {
    try { await p; } catch (e) { return e.message; }
    return assert.fail('no error');
  };
  const dir = await tmpDir();
  const phoneMsg = await messageOf(requestCode({ stateDir: dir, phone: 'abc' }));
  const codeMsg = await messageOf(confirmCode({ stateDir: dir, code: 'abc' }));
  for (const [args, msg] of [[['login', '--phone', 'abc'], phoneMsg], [['login', '--code', 'abc'], codeMsg]]) {
    const r = await run(args);
    assert.equal(r.json.error.code, 'BAD_ARGS');
    assert.ok(r.json.error.message.includes(msg), `${r.json.error.message} lacks ${msg}`);
  }
});

// ---- audit: post/edit previews through the CLI with a fake fetch ----
// The CLI has no way to point at another host, so a preload module (written into a temp folder) replaces
// globalThis.fetch; the category tree and the form come from the cache files seeded in the state folder.

const FAKE_FETCH_SRC = `
import fs from 'node:fs';
const log = process.env.FAKE_LOG;
const items = JSON.parse(process.env.FAKE_ITEMS || '{}');
const saved = JSON.parse(process.env.FAKE_SAVED || 'null');
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const status = u.searchParams.get('status');
  fs.appendFileSync(log, JSON.stringify({ path: u.pathname, status }) + '\\n');
  if (u.pathname === '/my-items-v2/v2/items') return json({ ads: items[status] ?? [] });
  if (u.pathname.startsWith('/insertion/v1/processing/load/')) return json({ result: saved });
  return new Response('{}', { status: 404 });
};
`;

const refOf = (name, ui, over = {}) => ({
  name, required: false, type: 'string', multi: false, ui_component: { type: ui }, actions: [],
  labels: { name: { ru: `L-${name}` } }, values: [], ...over,
});
const FORM_REFS = {
  1: refOf('subject', 'input', { required: true }),
  2: refOf('body', 'textarea', { required: true }),
  3: refOf('delivery_enabled', 'checkbox'),
  4: refOf('phone_hidden', 'checkbox'),
};
const TREE = { categories: [{ id: 1000, name_ru: 'Родитель', subcategories: [{ id: 2040, name_ru: 'Запчасти' }] }] };
const MY_CONTACT = { name: 'Тестовый Продавец', phone: '375290000000', email: 'a@example.com' };

// runs a CLI command in a fresh state folder with a saved key, the cached tree and form, and the fake fetch
async function runFake(args, { items = {}, saved = null, draft } = {}) {
  const dir = await tmpDir();
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(path.join(stateDir, 'cache'), { recursive: true });
  const cache = (file, data) => fs.writeFile(path.join(stateDir, 'cache', file), JSON.stringify({ saved_at: Date.now(), data }));
  await cache('category-tree.json', TREE);
  await cache('form-2040.json', {
    ad_metadata: { parameters: { refs: FORM_REFS, rules: [{ rule: {}, refs: Object.keys(FORM_REFS) }] }, parameters_order: { refs: { main: Object.keys(FORM_REFS) } } },
  });
  const login = runIn(stateDir, ['login', '--token-stdin'], liveToken());
  assert.equal(login.status, 0, login.stdout);
  const preload = path.join(dir, 'fake-fetch.mjs');
  await fs.writeFile(preload, FAKE_FETCH_SRC);
  const logFile = path.join(dir, 'requests.log');
  await fs.writeFile(logFile, '');
  const file = path.join(dir, 'input.json');
  await fs.writeFile(file, JSON.stringify(draft));
  const r = spawnSync(process.execPath, ['--import', preload, CLI, ...args(file)], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, KUFAR_STATE_DIR: stateDir, FAKE_LOG: logFile, FAKE_ITEMS: JSON.stringify(items), FAKE_SAVED: JSON.stringify(saved) },
  });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  const requests = (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, json, stdout: r.stdout, requests, contactStatuses: requests.filter((q) => q.path === '/my-items-v2/v2/items').map((q) => q.status) };
}

const POST_DRAFT = { category: '2040', subject: 'Катушка зажигания', body: 'Новая, в упаковке', price: 59, ...MY_CONTACT };

test('kufar post preview: a flag field set to "1" shows "да"', async () => {
  const r = await runFake((f) => ['post', '--draft', f], { draft: { ...POST_DRAFT, phone_hidden: '1' } });
  assert.equal(r.json?.posted, false, r.stdout);
  assert.equal(r.json.preview.fields.find((x) => x.name === 'phone_hidden').text, 'да');
});

test('kufar post preview: a flag field that is "0" in the ad does not show "да"', async () => {
  const r = await runFake((f) => ['post', '--draft', f], { draft: POST_DRAFT });
  assert.equal(r.json?.posted, false, r.stdout);
  const field = r.json.preview.fields.find((x) => x.name === 'delivery_enabled');
  assert.equal(field.value, '0');
  assert.equal(field.text, 'нет');
});

const NO_CONTACT_DRAFT = { category: '2040', subject: 'Катушка зажигания', body: 'Новая, в упаковке', price: 59 };

test('kufar post: no active listing, the contacts come from the next status that has one', async () => {
  const r = await runFake((f) => ['post', '--draft', f], {
    draft: NO_CONTACT_DRAFT, items: { active: [], inactive: [], deactivated: [MY_CONTACT] },
  });
  assert.equal(r.json?.posted, false, r.stdout);
  assert.deepEqual(r.contactStatuses, ['active', 'inactive', 'deactivated']);
});

test('kufar post: an active listing gives the contacts with one request', async () => {
  const r = await runFake((f) => ['post', '--draft', f], {
    draft: NO_CONTACT_DRAFT, items: { active: [MY_CONTACT], inactive: [MY_CONTACT] },
  });
  assert.equal(r.json?.posted, false, r.stdout);
  assert.deepEqual(r.contactStatuses, ['active']);
});

const SAVED_AD = {
  category: '2040', type: 'sell', company_ad: '0', language: 'ru', currency: 'BYR', price: '5900', remuneration_type: '1',
  delivery_enabled: '0', safedeal_enabled: '0', name: 'Тест', phone: '375290000000',
  subject: 'Катушка зажигания', body: 'Новая, в упаковке', list_id: '1000000001', images: [],
};

test('kufar edit: no active listing, the email comes from the next status that has one', async () => {
  const r = await runFake((f) => ['edit', '1000000001', '--changes', f], {
    draft: { subject: 'Новое название' }, saved: SAVED_AD, items: { active: [], inactive: [], refused: [MY_CONTACT] },
  });
  assert.equal(r.json?.edited, false, r.stdout);
  assert.deepEqual(r.contactStatuses, ['active', 'inactive', 'deactivated', 'pending_slot', 'refused']);
});

test('kufar edit: an active listing gives the email with one request', async () => {
  const r = await runFake((f) => ['edit', '1000000001', '--changes', f], {
    draft: { subject: 'Новое название' }, saved: SAVED_AD, items: { active: [MY_CONTACT], inactive: [MY_CONTACT] },
  });
  assert.equal(r.json?.edited, false, r.stdout);
  assert.deepEqual(r.contactStatuses, ['active']);
});
