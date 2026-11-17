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

const FORMAL = ['заинтересовал', 'подскажите, пожалуйста', 'буду признател', 'буду благодар', 'заранее благодар', 'заранее спасибо',
  'с уважением', 'хотел бы уточнить', 'хотела бы уточнить', 'надеюсь на', 'доброго времени суток'];
const STYLE = [
  ['long_dash', (t) => /[—–]/.test(t)],
  ['long', (t) => t.length > 300],
  ['exclaim', (t) => t.split('!').length > 2],
  ['emoji', (t) => /\p{Extended_Pictographic}/u.test(t)],
  ['list', (t) => /^[ \t]*(?:[-•*]|\d+[.)])/m.test(t)],
  ['formal', (t) => FORMAL.some((p) => t.toLowerCase().includes(p))],
];

// a hint for the agent, not a filter: the text is sent as it is
export function styleFlags(text) {
  return STYLE.filter(([, test]) => test(text)).map(([name]) => name);
}

// the value of a field of the answer: a string or a number, anything else is null
const plain = (v) => (typeof v === 'string' || typeof v === 'number' ? v : null);

// the address holds the key, so no error carries it or the text of the original error
export async function sendMessage({ token, conversationId, adId, text, WebSocketImpl = globalThis.WebSocket, uuid = randomUUID, timeoutMs = 20000 }) {
  if ((conversationId === undefined) === (adId === undefined)) throw bad('Нужен ровно один из номера диалога и номера объявления');
  if (adId !== undefined && !/^\d+$/.test(adId)) throw bad('Нужен номер объявления из цифр');
  return new Promise((resolve, reject) => {
    const url = `${WS_URL}?token=${encodeURIComponent(token)}&X-App-Name=Web%20Kufar&X-Device-ID=${uuid()}`;
    const frame = adId === undefined
      ? {
        payload: { conversation_id: conversationId, client_message_id: uuid(), text, type: 'text' },
        req_type: 'send_message',
        request_id: uuid(),
      }
      : {
        payload: { ad_id: Number(adId), client_conversation_id: uuid(), message: { client_message_id: uuid(), text, type: 'text' } },
        req_type: 'create_conversation',
        request_id: uuid(),
      };
    const ws = new WebSocketImpl(url);
    let sent = false;
    let done = false;
    const unconfirmed = () => new KufarError('SEND_UNCONFIRMED',
      `Куфар не подтвердил отправку. Сообщение могло уйти: проверьте ${adId === undefined ? 'chat' : 'inbox'}, прежде чем отправлять снова`);

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
      if (m?.req_type !== frame.req_type || m.request_id !== frame.request_id) return;
      if (m.status === 'success' && adId !== undefined) {
        const r = m.response;
        finish(resolve, { conversation_id: plain(r?.conversation_id), message_id: plain(r?.message_id), at: plain(r?.message_ts) });
      } else if (m.status === 'success') {
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
