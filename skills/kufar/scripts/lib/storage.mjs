import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { KufarError } from './errors.mjs';

export function resolveStateDir(env = process.env) {
  if (env.KUFAR_STATE_DIR) {
    if (!path.isAbsolute(env.KUFAR_STATE_DIR)) {
      throw new KufarError('BAD_ARGS', 'KUFAR_STATE_DIR должен быть абсолютным путём', { value: env.KUFAR_STATE_DIR });
    }
    return env.KUFAR_STATE_DIR;
  }
  const base = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state');
  return path.join(base, 'kufar-skill');
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function cached(file, ttlMs, loader, now = Date.now) {
  const entry = await readJson(file, null);
  if (typeof entry?.saved_at === 'number' && now() - entry.saved_at < ttlMs) return entry.data;
  const data = await loader();
  await writeJsonAtomic(file, { saved_at: now(), data });
  return data;
}
