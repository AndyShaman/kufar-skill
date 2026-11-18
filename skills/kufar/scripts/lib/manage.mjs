import { KufarError } from './errors.mjs';
import { call, sha256 } from './post.mjs';

const ITEMS_URL = 'https://api.kufar.by/my-items-v2/v1/items/';
const ACTIONS = ['off', 'activate', 'prolong', 'delete'];
const REASONS = ['sold_on_site', 'sold_other_means', 'give_up', 'hands_up', 'other'];
const DURATIONS = ['one_day', 'one_week', 'one_month', 'over_one_month'];
const MAX_COMMENT = 300;

const bad = (message) => new KufarError('BAD_ARGS', message);

export function manageRequest({ action, reason, duration, comment }) {
  if (!ACTIONS.includes(action)) throw bad(`Действие: ${ACTIONS.join(', ')}`);
  if (action !== 'off') {
    if (reason !== undefined || duration !== undefined || comment !== undefined) {
      throw bad(`${action}: без --reason, --duration и --comment`);
    }
    return { action, body: null };
  }
  if (!REASONS.includes(reason)) throw bad(`--reason: ${REASONS.join(', ')}`);
  if (reason === 'sold_on_site' ? !DURATIONS.includes(duration) : duration !== undefined) {
    throw bad(`--duration нужен только с --reason sold_on_site: ${DURATIONS.join(', ')}`);
  }
  let text = '';
  if (reason === 'other') {
    text = typeof comment === 'string' ? comment.trim() : '';
    if (!text || text.length > MAX_COMMENT) throw bad(`--comment: текст от 1 до ${MAX_COMMENT} знаков`);
  } else if (comment !== undefined) {
    throw bad('--comment нужен только с --reason other');
  }
  return { action: 'deactivate', body: { reason, duration: duration ?? '', comment: text } };
}

export function manageCode(id, request) {
  return sha256(JSON.stringify([id, request.action, request.body])).slice(0, 12);
}

const unconfirmed = () => new KufarError('MANAGE_UNCONFIRMED',
  'Куфар не подтвердил действие. Проверьте состояние объявления командой my, прежде чем повторять');

// only the reason text of a refusal is passed on: the links and buttons of the answer are not
function refusalReason(data) {
  const text = [data?.details?.translations?.ru, data?.message].find((x) => typeof x === 'string' && x);
  return text === undefined ? null : text.slice(0, 300);
}

export async function manageAd({ token, id, request, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  let r;
  try {
    r = await call(fetchImpl, `${ITEMS_URL}${id}/${request.action}`, {
      method: 'PUT',
      token,
      ...(request.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) } : {}),
      timeoutMs,
    });
  } catch {
    throw unconfirmed();
  }
  const { status, data } = r;
  if (status >= 200 && status < 300) return true;
  if (status === 401) throw new KufarError('AUTH_EXPIRED', 'Ключ входа просрочен или Куфар его не принял. Выполните login', { status });
  if (status >= 400 && status < 500) {
    throw new KufarError('MANAGE_FAILED', 'Куфар отказал в этом действии', { status, reason: refusalReason(data) });
  }
  throw unconfirmed();
}
