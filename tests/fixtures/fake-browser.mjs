#!/usr/bin/env node
// Stand-in for a Chromium browser started with --remote-debugging-pipe, for the end-to-end login tests.
// Reads \0-separated JSON messages on fd 3 and answers on fd 4.
// FAKE_BROWSER_MODE: 'login' (k_jwt from the second cookie request) or 'never' (k_jwt never appears)
// FAKE_BROWSER_TOKEN: the test key, given as a k_jwt cookie in 'login' mode
// FAKE_BROWSER_LOG: file that gets one JSON line for the start ({pid, argv}) and one per received message
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_BROWSER_MODE ?? 'never';
const token = process.env.FAKE_BROWSER_TOKEN ?? '';
const log = process.env.FAKE_BROWSER_LOG;
const note = (obj) => { if (log) fs.appendFileSync(log, `${JSON.stringify(obj)}\n`); };

note({ pid: process.pid, argv: process.argv.slice(2) });

// like a real browser: the profile gets files, and the key sits in the cookie store
const profileArg = process.argv.slice(2).find((a) => a.startsWith('--user-data-dir='));
if (profileArg) {
  const dir = path.join(profileArg.slice('--user-data-dir='.length), 'Default');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cookies'), `k_jwt=${mode === 'login' ? token : ''}`);
}

let cookieRequests = 0;
const reply = (id, result) => fs.writeSync(4, `${JSON.stringify({ id, result })}\0`);
const fail = (id, message) => fs.writeSync(4, `${JSON.stringify({ id, error: { code: -32601, message } })}\0`);

function handle(msg) {
  note({ message: msg });
  switch (msg.method) {
    case 'Target.getTargets': return reply(msg.id, { targetInfos: [{ targetId: 'T1', type: 'page' }] });
    case 'Target.attachToTarget': return reply(msg.id, { sessionId: 'S1' });
    case 'Network.getCookies': {
      if (!Array.isArray(msg.params?.urls) || !msg.params.urls.length) return fail(msg.id, 'urls required');
      cookieRequests += 1;
      const cookies = mode === 'login' && cookieRequests >= 2
        ? [{ name: 'k_jwt', value: token, domain: '.kufar.by', path: '/' }] : [];
      return reply(msg.id, { cookies });
    }
    case 'Target.detachFromTarget': return reply(msg.id, {});
    case 'Browser.close':
      reply(msg.id, {});
      return process.exit(0);
    default: return fail(msg.id, 'unknown method');
  }
}

let buf = '';
const input = fs.createReadStream(null, { fd: 3, autoClose: false });
input.setEncoding('utf8');
input.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\0')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try { handle(JSON.parse(line)); } catch { /* ignore garbage */ }
  }
});
input.on('end', () => process.exit(0));
input.on('error', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
