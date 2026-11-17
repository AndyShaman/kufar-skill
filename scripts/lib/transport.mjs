import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KufarError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';

const HOST = 'https://api.kufar.by';
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const ALLOWED = [
  /^\/search-api\/v2\/search\/rendered-paginated$/,
  /^\/search-api\/v2\/search\/count$/,
  /^\/search-api\/v2\/item\/\d+\/rendered$/,
  /^\/category-tree\/v1\/category_tree$/,
  /^\/taxonomy-proxy\/v1\/dispatch$/,
];

export function createTransport({ stateDir, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random,
  minIntervalMs = 500, jitterMs = 400, timeoutMs = 20000 } = {}) {
  const networkFile = path.join(stateDir, 'network.json');

  // the slot is claimed in the shared file before sleeping, so a parallel process queues after it
  async function pace() {
    const prev = await readJson(networkFile, null);
    const start = typeof prev?.last === 'number'
      ? Math.max(now(), prev.last + minIntervalMs + Math.floor(random() * jitterMs))
      : now();
    await writeJsonAtomic(networkFile, { last: start });
    const wait = start - now();
    if (wait > 0) await sleep(wait);
  }

  async function fetchOnce(url) {
    await pace();
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json', 'Accept-Language': 'ru', 'User-Agent': `kufar-skill/${VERSION}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { res, body: await res.text() };
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new KufarError('TIMEOUT', 'Куфар не ответил вовремя', { timeout_ms: timeoutMs });
      }
      throw new KufarError('NETWORK', `Сетевая ошибка: ${e.message}`);
    }
  }

  async function getJson(p, query = {}) {
    if (!ALLOWED.some((re) => re.test(p))) {
      throw new KufarError('PATH_NOT_ALLOWED', 'Этот адрес API не разрешён', { path: p });
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.append(k, String(v));
    const url = `${HOST}${p}${qs.size ? `?${qs}` : ''}`;

    let { res, body } = await fetchOnce(url);
    if (res.status === 429 || res.status === 503) {
      const header = res.headers.get('retry-after');
      const sec = header !== null && Number.isFinite(Number(header)) && Number(header) >= 0 ? Number(header) : 5;
      await sleep(Math.min(sec, 30) * 1000);
      ({ res, body } = await fetchOnce(url));
      if (res.status === 429 || res.status === 503) {
        throw new KufarError('RATE_LIMITED', 'Куфар ограничил частоту запросов, повторите позже', { status: res.status });
      }
    }
    const { status } = res;
    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(body);
      } catch {
        throw new KufarError('BAD_RESPONSE', 'Куфар вернул не JSON', { status });
      }
    }
    if (status === 404) throw new KufarError('NOT_FOUND', 'Не найдено', { status });
    if (status === 403) {
      if (body.includes('Доступ ограничен')) {
        throw new KufarError('GEO_BLOCKED', 'Куфар ограничил доступ из этой страны или сети', { status });
      }
      throw new KufarError('FORBIDDEN', 'Куфар отказал в доступе', { status });
    }
    throw new KufarError('HTTP_ERROR', `Куфар ответил с кодом ${status}`, { status });
  }

  return { getJson };
}
