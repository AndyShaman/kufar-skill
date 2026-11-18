import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KufarError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';
import { parseToken, saveToken } from './auth.mjs';

const CLI = fileURLToPath(new URL('../kufar.mjs', import.meta.url));
const LOGIN_URL = 'https://www.kufar.by/login/';
// the only cookie request ever sent: cookies of these two addresses, nothing else of the browser
const KUFAR_URLS = ['https://www.kufar.by/', 'https://api.kufar.by/'];
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
const BY_CODE = 'Войдите по коду: login --phone НОМЕР';

const unavailable = () => new KufarError('BROWSER_UNAVAILABLE', `Браузер не запустился или перестал отвечать. ${BY_CODE}`);
const cancelled = () => new KufarError('LOGIN_CANCELLED', 'Окно входа закрыли до входа. Запустите login снова');
const noDisplay = () => new KufarError('NO_DISPLAY', `Нет экрана для окна входа. ${BY_CODE}`);
const notFound = () => new KufarError('BROWSER_NOT_FOUND', `Не найден Chrome, Edge, Chromium или Brave. ${BY_CODE}`);
const windowFile = (stateDir) => path.join(stateDir, 'login-window.json');
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (platform === 'linux') {
    // a snap browser cannot use a profile in a hidden folder
    const dirs = (env.PATH ?? '').split(':').filter((d) => d && !d.startsWith('/snap/'));
    return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
      .flatMap((name) => dirs.map((d) => `${d}/${name}`));
  }
  if (platform === 'win32') {
    const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']
      .flatMap((rel) => bases.map((b) => path.win32.join(b, rel)));
  }
  return [];
}

export async function findBrowser({ platform = process.platform, env = process.env,
  exists = (p) => fs.access(p).then(() => true, () => false) } = {}) {
  const own = env.KUFAR_BROWSER;
  if (own) {
    if (!path.isAbsolute(own)) throw new KufarError('BAD_ARGS', 'KUFAR_BROWSER должен быть абсолютным путём');
    if (!(await exists(own))) throw notFound();
    return own;
  }
  for (const p of browserCandidates({ platform, env })) if (await exists(p)) return p;
  throw notFound();
}

export function displayAvailable({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  // a window started over SSH is not seen by the person
  if (platform === 'darwin' || platform === 'win32') return !env.SSH_CONNECTION && !env.SSH_TTY;
  return true;
}

// --remote-debugging-pipe: JSON messages, each followed by \0
export function createPipeConnection(writable, readable, { timeoutMs = 10000 } = {}) {
  let lastId = 0;
  let closed = false;
  let buf = Buffer.alloc(0);
  const pending = new Map();

  const shut = () => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(unavailable());
    }
    pending.clear();
  };

  readable.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const text = buf.subarray(0, i).toString('utf8');
      buf = buf.subarray(i + 1);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      const p = pending.get(msg?.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      // the browser's error text is not passed on
      if (msg.error) p.reject(unavailable());
      else p.resolve(msg.result);
    }
  });
  readable.on('end', shut);
  readable.on('close', shut);
  readable.on('error', shut);
  writable.on('error', shut);

  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(unavailable());
      lastId += 1;
      const id = lastId;
      const msg = { id, method, params };
      if (sessionId !== undefined) msg.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(unavailable());
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        writable.write(`${JSON.stringify(msg)}\0`);
      });
    },
    close: shut,
    get closed() { return closed; },
  };
}

const kufarDomain = (d) => typeof d === 'string' && (d === 'kufar.by' || d.endsWith('.kufar.by'));
const validToken = (v) => {
  try {
    parseToken(v);
    return true;
  } catch {
    return false;
  }
};

export async function readKufarToken(conn) {
  const targets = await conn.send('Target.getTargets');
  const page = (targets?.targetInfos ?? []).find((t) => t.type === 'page');
  if (!page) return { page: false, token: null };
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  let cookies;
  try {
    cookies = (await conn.send('Network.getCookies', { urls: KUFAR_URLS }, sessionId))?.cookies;
  } finally {
    await conn.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
  const found = (cookies ?? []).find((c) => c.name === 'k_jwt' && kufarDomain(c.domain) && validToken(c.value));
  return { page: true, token: found ? found.value : null };
}

export async function waitForLogin(conn, { now = Date.now, sleep = defaultSleep, waitMs = 300000, pollMs = 1500, startMs = 30000,
  isClosed = () => false, signal } = {}) {
  const start = now();
  let answered = false;
  let sawPage = false;
  let missing = 0;
  // a browser gone before it answered was never seen by the person
  const ended = () => {
    if (signal?.aborted) return cancelled();
    if (isClosed()) return answered ? cancelled() : unavailable();
    return null;
  };
  for (;;) {
    let e = ended();
    if (e) throw e;
    let r;
    try {
      r = await readKufarToken(conn);
    } catch (err) {
      e = ended();
      if (e) throw e;
      // the browser is still starting
      if (!answered && now() - start < startMs) {
        await sleep(pollMs);
        continue;
      }
      throw err;
    }
    answered = true;
    if (r.token) return r.token;
    // on macOS the browser keeps running after its window is closed: the cancel shows as a page that is gone
    if (r.page) {
      sawPage = true;
      missing = 0;
    } else if (sawPage) {
      missing += 1;
      if (missing >= 2) throw cancelled();
    }
    if (now() - start >= waitMs) throw new KufarError('LOGIN_TIMEOUT', 'Вход не выполнен за отведённое время. Запустите login снова');
    await sleep(pollMs);
  }
}

export async function loginWindow({ stateDir, waitMs = 300000, pollMs = 1500, startMs = 30000, closeWaitMs = 5000, platform = process.platform,
  env = process.env, spawnImpl = spawn, findBrowserImpl = findBrowser, now = Date.now, sleep, signal } = {}) {
  if (!displayAvailable({ platform, env })) throw noDisplay();
  const bin = await findBrowserImpl({ platform, env });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  // an empty profile of its own: the person's browser and its cookies are never touched
  const profile = path.join(stateDir, `login-profile-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(profile, { mode: 0o700 });
  let child;
  let conn;
  let exited = false;
  try {
    try {
      child = spawnImpl(bin, [
        `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
        '--window-size=520,820', LOGIN_URL,
      ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    } catch {
      throw unavailable();
    }
    const gone = () => {
      exited = true;
      conn?.close();
    };
    child.on('exit', gone);
    child.on('error', gone);
    conn = createPipeConnection(child.stdio[3], child.stdio[4]);
    return await waitForLogin(conn, { now, sleep, waitMs, pollMs, startMs, isClosed: () => exited || conn.closed, signal });
  } finally {
    // cleanup never replaces the key or the original error; a profile left behind is removed by sweepLoginProfiles
    try {
      if (child && !exited) {
        conn?.send('Browser.close').catch(() => {});
        await waitExit(child, () => exited, closeWaitMs);
        if (!exited) {
          try { child.kill(); } catch { /* already gone */ }
          await waitExit(child, () => exited, closeWaitMs);
        }
      }
    } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
    await fs.rm(profile, RM).catch(() => {});
  }
}

// a real timer, not the injected sleep
function waitExit(child, hasExited, ms) {
  if (hasExited()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function sweepLoginProfiles(stateDir) {
  let entries;
  try {
    entries = await fs.readdir(stateDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('login-profile')) await fs.rm(path.join(stateDir, e.name), RM).catch(() => {});
  }
}

async function readWindow(stateDir) {
  const s = await readJson(windowFile(stateDir), null);
  if (s?.state === 'waiting' && Number.isInteger(s.pid) && s.pid > 0 && typeof s.deadline === 'number') return s;
  if (s?.state === 'failed' && typeof s.code === 'string') return s;
  return null;
}

function statusOf(s, now, isAlive) {
  if (!s) return null;
  if (s.state === 'failed') return { state: 'failed', code: s.code };
  const t = now();
  if (t <= s.deadline + 30000 && isAlive(s.pid)) return { state: 'waiting', seconds_left: Math.max(0, Math.ceil((s.deadline - t) / 1000)) };
  // the worker is gone without a word
  return { state: 'failed', code: 'BROWSER_UNAVAILABLE' };
}

export async function loginWindowStatus(stateDir, { now = Date.now, isAlive = defaultIsAlive } = {}) {
  return statusOf(await readWindow(stateDir), now, isAlive);
}

function spawnLoginWorker(waitMs) {
  const child = spawn(process.execPath, [CLI, 'login-worker', '--wait', String(waitMs / 1000)], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// returns at once: the window is held by a detached worker, the result is seen through whoami
export async function startLogin({ stateDir, waitMs = 300000, platform = process.platform, env = process.env, findBrowserImpl = findBrowser,
  spawnWorker = () => spawnLoginWorker(waitMs), now = Date.now, isAlive } = {}) {
  const st = await loginWindowStatus(stateDir, { now, isAlive });
  if (st?.state === 'waiting') return { login: 'waiting', seconds_left: st.seconds_left };
  if (!displayAvailable({ platform, env })) throw noDisplay();
  await findBrowserImpl({ platform, env });
  await sweepLoginProfiles(stateDir);
  const pid = spawnWorker();
  const t = now();
  await writeJsonAtomic(windowFile(stateDir), { state: 'waiting', pid, started_at: t, deadline: t + waitMs });
  return { login: 'window_opened', seconds_left: waitMs / 1000 };
}

export async function runLoginWorker({ stateDir, waitMs = 300000, now = Date.now, loginWindowImpl = loginWindow, signal, ...rest } = {}) {
  try {
    const token = await loginWindowImpl({ ...rest, stateDir, waitMs, signal });
    // stopped on purpose (logout): a key caught at that moment is dropped
    if (signal?.aborted) return;
    await saveToken(stateDir, token, now);
    await fs.rm(windowFile(stateDir), { force: true });
  } catch (e) {
    if (signal?.aborted) return;
    try {
      await writeJsonAtomic(windowFile(stateDir), { state: 'failed', code: e instanceof KufarError ? e.code : 'INTERNAL', at: now() });
    } catch { /* nothing to report to */ }
  }
}

export async function stopLoginWindow(stateDir, { now = Date.now, isAlive = defaultIsAlive, kill = process.kill } = {}) {
  const s = await readWindow(stateDir);
  if (statusOf(s, now, isAlive)?.state === 'waiting') {
    try { kill(s.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await fs.rm(windowFile(stateDir), { force: true });
}
