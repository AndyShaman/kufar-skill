import { createHash, randomUUID } from 'node:crypto';
import { KufarError } from './errors.mjs';

export const MAX_TEXT = 4096;
const WS_URL = 'wss://messaging-ws.kufar.by/v1/ws/';
const KEY_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

// the messages never repeat the text: it may hold the key
const bad = (message) => new KufarError('BAD_ARGS', message);

function hasToken(text, token) {
  if (typeof token !== 'string' || !token) return false;
  const s = text.replace(/\s/g, '');
  const [, p2, p3] = token.split('.');
  return s.includes(token) || [p2, p3].some((p) => p?.length >= 20 && s.includes(p));
}

// a signal, not a guarantee: a key re-encoded or split finer is not seen
export function hasKey(text, token) {
  return KEY_SHAPE.test(text) || hasToken(text, token);
}

export function checkText(text, token) {
  if (typeof text !== 'string') throw bad('Нужен текст сообщения: --text "<текст>"');
  const t = text.trim();
  if (!t) throw bad('Текст сообщения пустой');
  if (t.length > MAX_TEXT) throw bad(`Текст сообщения длиннее ${MAX_TEXT} знаков`);
  if (hasKey(t, token)) {
    throw new KufarError('TEXT_HAS_KEY', 'В тексте есть ключ входа. Такое сообщение утилита не отправляет');
  }
  return t;
}

export function confirmCode(conversationId, text) {
  return createHash('sha256').update(`${conversationId.toLowerCase()}\n${text}`).digest('hex').slice(0, 12);
}

// the address holds the key, so no error carries it or the text of the original error
export async function sendMessage({ token, conversationId, text, WebSocketImpl = globalThis.WebSocket, uuid = randomUUID, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const url = `${WS_URL}?token=${encodeURIComponent(token)}&X-App-Name=Web%20Kufar&X-Device-ID=${uuid()}`;
    const frame = {
      payload: { conversation_id: conversationId, client_message_id: uuid(), text, type: 'text' },
      req_type: 'send_message',
      request_id: uuid(),
    };
    const ws = new WebSocketImpl(url);
    let sent = false;
    let done = false;
    const unconfirmed = () => new KufarError('SEND_UNCONFIRMED',
      'Куфар не подтвердил отправку. Сообщение могло уйти: проверьте chat, прежде чем отправлять снова');

    const finish = (settle, value) => {
      if (done) return;
      done = true;
      settle(value);
      clearTimeout(timer);
      // the built-in WebSocket closed before open fires error and close itself: done already ignores them
      ws.close();
    };
    const fail = () => finish(reject, sent ? unconfirmed() : new KufarError('NETWORK', 'Сетевая ошибка'));

    const timer = setTimeout(() => finish(reject, sent
      ? unconfirmed()
      : new KufarError('TIMEOUT', 'Куфар не ответил вовремя', { timeout_ms: timeoutMs })), timeoutMs);

    ws.onopen = () => {
      if (done) return;
      ws.send(JSON.stringify(frame));
      sent = true;
    };
    ws.onmessage = (event) => {
      let m;
      try {
        m = JSON.parse(event.data);
      } catch {
        return;
      }
      if (m?.req_type !== 'send_message' || m.request_id !== frame.request_id) return;
      if (m.status === 'success') {
        finish(resolve, { message_id: m.response?.message_id ?? null, at: m.response?.message_ts ?? null });
      } else if (m.status === 'error') {
        const code = m.response?.code;
        finish(reject, new KufarError('SEND_FAILED', 'Куфар не принял сообщение',
          typeof code === 'string' && code.length <= 40 ? { code } : undefined));
      }
    };
    ws.onerror = fail;
    ws.onclose = fail;
  });
}
