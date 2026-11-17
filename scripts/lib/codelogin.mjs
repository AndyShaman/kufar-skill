import fs from 'node:fs/promises';
import path from 'node:path';
import { KufarError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';
import { VERSION } from './transport.mjs';
import { saveToken } from './auth.mjs';

const HOST = 'https://cre-auth.kufar.by';
const HEADERS = { 'User-Agent': `kufar-skill/${VERSION}`, 'Accept-Language': 'ru', 'Content-Type': 'application/json' };
const KUFAR_CODE = /^[A-Z]{2,5}[0-9]{2,6}$/;
const PHONE = /^375\d{9}$/;

const pendingFile = (stateDir) => path.join(stateDir, 'login-pending.json');

export function normalizePhone(raw) {
  const s = typeof raw === 'string' ? raw.replace(/[\s+()-]/g, '') : '';
  const digits = /^80\d{9}$/.test(s) ? `375${s.slice(2)}` : s;
  if (!PHONE.test(digits)) throw new KufarError('BAD_ARGS', 'Нужен белорусский номер телефона: +375 XX XXX XX XX');
  return digits;
}

// one request to the login host; the exception text is never passed on
async function call(fetchImpl, url, { method = 'GET', body, timeoutMs }) {
  let res;
  let text;
  try {
    res = await fetchImpl(url, { method, headers: HEADERS, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch {
    throw new KufarError('NETWORK', 'Сетевая ошибка');
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, data };
}

// only the status and a Kufar error code of a known shape leave the answer
function loginFailed(message, status, data) {
  const details = { status };
  if (typeof data?.code === 'string' && KUFAR_CODE.test(data.code)) details.kufar_code = data.code;
  return new KufarError('LOGIN_FAILED', message, details);
}

async function readPending(stateDir) {
  const p = await readJson(pendingFile(stateDir), null);
  return typeof p?.code_token === 'string' && typeof p.phone === 'string' && PHONE.test(p.phone) ? p : null;
}

export async function requestCode({ stateDir, phone, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 }) {
  const digits = normalizePhone(phone);
  // a second request would cancel the code the person is reading right now
  const prev = await readPending(stateDir);
  if (prev && Number.isFinite(prev.requested_at) && Number.isFinite(prev.retry_after)) {
    const left = prev.requested_at + prev.retry_after * 1000 - now();
    if (left > 0) {
      throw new KufarError('CODE_ALREADY_SENT', 'Код уже отправлен: введите код из последнего сообщения или запросите новый позже',
        { seconds_left: Math.ceil(left / 1000) });
    }
  }

  const captcha = await call(fetchImpl, `${HOST}/v2/auth/signin/recaptcha_required`, { timeoutMs });
  if (captcha.status !== 200 || captcha.data === null) {
    throw new KufarError('LOGIN_FAILED', 'Куфар отклонил запрос кода входа', { status: captcha.status });
  }
  if (captcha.data.is_required !== false) {
    throw new KufarError('CAPTCHA_REQUIRED',
      'Куфар требует капчу для входа с этого адреса. Войдите на компьютере с экраном и перенесите ключ, см. references/account.md');
  }

  const { status, data } = await call(fetchImpl, `${HOST}/v3/auth/phone/code?phone=${digits}&viber=true`, { timeoutMs });
  const codeToken = data?.code_token;
  if (status !== 200 || typeof codeToken !== 'string' || !codeToken || codeToken.length > 200) {
    throw loginFailed('Куфар отклонил запрос кода входа', status, data);
  }
  const retryAfter = Number.isInteger(data.ttl) && data.ttl >= 1 && data.ttl <= 3600 ? data.ttl : 60;
  await writeJsonAtomic(pendingFile(stateDir), { code_token: codeToken, phone: digits, requested_at: now(), retry_after: retryAfter });
  return { code_sent: true, phone_tail: digits.slice(-2), retry_after: retryAfter };
}

export async function confirmCode({ stateDir, code, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 }) {
  if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) throw new KufarError('BAD_ARGS', 'Код входа: от 4 до 8 цифр');
  const pending = await readPending(stateDir);
  if (!pending) throw new KufarError('NO_PENDING_LOGIN', 'Код не запрашивался. Сначала выполните login --phone НОМЕР');
  const p = pending.phone;
  // the phone as the site sends it: +375 (AA) BBB CC DD
  const phone = `+375 (${p.slice(3, 5)}) ${p.slice(5, 8)} ${p.slice(8, 10)} ${p.slice(10)}`;
  const { status, data } = await call(fetchImpl, `${HOST}/v3/auth/phone/code`, {
    method: 'POST',
    body: JSON.stringify({ channel: 'viber_sms', code, code_token: pending.code_token, phone }),
    timeoutMs,
  });
  if (status !== 200 || typeof data?.jwt !== 'string') {
    throw loginFailed('Куфар не принял код. Проверьте код из последнего сообщения', status, data);
  }
  const result = await saveToken(stateDir, data.jwt, now);
  await fs.rm(pendingFile(stateDir), { force: true });
  return result;
}
