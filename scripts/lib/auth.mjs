import fs from 'node:fs/promises';
import path from 'node:path';
import { KufarError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';
import { VERSION } from './transport.mjs';

const DAY = 24 * 60 * 60 * 1000;
// revokes this one key; /v1/auth/signout/all (every device of the person) is never used
const SIGNOUT = 'https://cre-auth.kufar.by/v1/auth/signout';
const PART = /^[A-Za-z0-9_-]+$/;

const authFile = (stateDir) => path.join(stateDir, 'auth.json');
// the message never repeats the input: it may be the key itself
const badToken = () => new KufarError('BAD_TOKEN', 'Это не похоже на ключ входа Куфара');

export function parseToken(raw) {
  let s = String(raw).trim();
  // the content of auth.json: moves the key to another machine without showing it
  if (s.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(s);
    } catch {
      throw badToken();
    }
    if (typeof data?.token !== 'string') throw badToken();
    s = data.token;
  }
  if (s.startsWith('k_jwt=')) s = s.slice('k_jwt='.length);
  if (s.endsWith(';')) s = s.slice(0, -1);
  const parts = s.split('.');
  if (parts.length !== 3 || !parts.every((p) => PART.test(p))) throw badToken();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw badToken();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Number.isFinite(payload.exp)) throw badToken();
  return { token: s, exp: payload.exp * 1000 };
}

// the saved key, checked again: only a string that passes parseToken reaches a header
async function storedToken(stateDir) {
  const data = await readJson(authFile(stateDir), null);
  if (typeof data?.token !== 'string') return null;
  try {
    return parseToken(data.token);
  } catch {
    return null;
  }
}

export async function saveToken(stateDir, raw, now = Date.now) {
  const { token, exp } = parseToken(raw);
  if (exp <= now()) throw new KufarError('AUTH_EXPIRED', 'Ключ входа просрочен. Выполните login');
  await writeJsonAtomic(authFile(stateDir), { token, exp, saved_at: now() });
  return authStatus(stateDir, now);
}

export async function loadToken(stateDir, now = Date.now) {
  const stored = await storedToken(stateDir);
  if (!stored) throw new KufarError('AUTH_REQUIRED', 'Вход не выполнен. Выполните login');
  if (stored.exp <= now()) throw new KufarError('AUTH_EXPIRED', 'Ключ входа просрочен. Выполните login');
  return stored.token;
}

export async function authStatus(stateDir, now = Date.now) {
  const stored = await storedToken(stateDir);
  if (!stored) return { logged_in: false };
  const expires_at = new Date(stored.exp).toISOString();
  if (stored.exp <= now()) return { logged_in: false, expired: true, expires_at };
  return { logged_in: true, expires_at, days_left: Math.floor((stored.exp - now()) / DAY) };
}

export async function logout(stateDir, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  await fs.rm(path.join(stateDir, 'login-pending.json'), { force: true });
  const stored = await storedToken(stateDir);
  let revoked = false;
  if (stored && stored.exp > Date.now()) {
    const failed = (details) => new KufarError('REVOKE_FAILED', 'Не удалось отозвать ключ на Куфаре. Повторите logout позже', details);
    let res;
    try {
      res = await fetchImpl(SIGNOUT, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': `kufar-skill/${VERSION}`, 'Accept-Language': 'ru', 'Content-Type': 'application/json',
          Authorization: `Bearer ${stored.token}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failed();
    }
    // 401: Kufar no longer accepts the key, which is what logout wants
    if (!((res.status >= 200 && res.status < 300) || res.status === 401)) throw failed({ status: res.status });
    revoked = true;
  }
  await fs.rm(authFile(stateDir), { force: true });
  return revoked ? { logged_in: false, revoked: true } : { logged_in: false };
}
