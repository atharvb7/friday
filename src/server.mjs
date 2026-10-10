import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { createContext } from './context.mjs';
import { Router, mapError } from './http/router.mjs';
import { makeStaticServer } from './http/static.mjs';
import { systemRoutes } from './routes/system.mjs';
import { taskRoutes } from './routes/tasks.mjs';
import { memoryRoutes } from './routes/memory.mjs';
import { toolRoutes } from './routes/tools.mjs';
import { chatRoutes } from './routes/chat.mjs';
import { workRoutes } from './routes/work.mjs';
import { authRoutes } from './routes/auth.mjs';
import { platformRoutes } from './routes/platform.mjs';
import { assistantRoutes } from './routes/assistant.mjs';
import { nodeRoutes } from './routes/node.mjs';
import { voiceRoutes } from './routes/voice.mjs';
import { openEventStream } from './http/sse.mjs';
import { requiredScope, needsTotp } from './auth.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Local secrets file (gitignored, 0600). Real env vars win. FRIDAY_NO_DOTENV=1 keeps tests hermetic.
if (process.env.FRIDAY_NO_DOTENV !== '1') loadEnvFile(resolve(appRoot, '.env'));

const host = process.env.FRIDAY_HOST ?? '127.0.0.1';
// Loopback unless explicitly opened (containers); real exposure goes through Tailscale Serve/TLS.
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.FRIDAY_ALLOW_NONLOOPBACK !== '1') {
  console.error(`Refusing to bind ${host}: set FRIDAY_ALLOW_NONLOOPBACK=1 only behind a firewall/proxy.`);
  process.exit(2);
}
const port = Number(process.env.FRIDAY_PORT ?? 4317);
const ctx = createContext({ appRoot });
ctx.start();

const router = new Router();
for (const register of [systemRoutes, taskRoutes, memoryRoutes, toolRoutes, chatRoutes, workRoutes, authRoutes, platformRoutes, assistantRoutes, nodeRoutes, voiceRoutes]) register(router, ctx);
const serveStatic = makeStaticServer(resolve(appRoot, 'public'));

// Buckets: authenticated traffic is keyed by principal (behind `tailscale serve`
// every request arrives from 127.0.0.1, so IP is useless); failed auth is keyed
// by IP with a much lower ceiling to blunt token guessing.
const RATE_WINDOW_MS = 60_000;
const buckets = new Map();
function limited(key, max) {
  const now = Date.now();
  const e = buckets.get(key);
  if (!e || now - e.start >= RATE_WINDOW_MS) { buckets.set(key, { start: now, count: 1 }); return false; }
  e.count += 1;
  return e.count > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (now - v.start >= RATE_WINDOW_MS) buckets.delete(k); }, RATE_WINDOW_MS).unref();

function send(res, status, payload, extraHeaders = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(data);
}

const MAX_BODY = 64 * 1024;
function rawReader(req) {
  return async ({ max = 4 * 1024 * 1024 } = {}) => {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > max) throw new Error('body_too_large'); chunks.push(c); }
    return Buffer.concat(chunks);
  };
}
function bodyReader(req) {
  return async ({ optional = false, max = MAX_BODY } = {}) => {
    try {
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > max) throw new Error('body_too_large');
      }
      return JSON.parse(text || '{}');
    } catch (error) {
      if (optional && error.message !== 'body_too_large') return {};
      throw error;
    }
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (serveStatic(req, res, url.pathname)) return;
  const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const principal = ctx.auth.authenticate(bearer);
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!principal) {
    if (limited(`fail:${ip}`, 30)) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    return send(res, 401, { error: 'unauthorized' });
  }
  if (limited(`p:${principal.id}`, 240)) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  const scope = requiredScope(req.method, url.pathname);
  const guestChat = principal.scopes.includes('guest') && req.method === 'POST' && url.pathname === '/v1/chat'; // guests may ONLY chat (as guests)
  if (!principal.scopes.includes(scope) && !guestChat) return send(res, 403, { error: 'forbidden', needs: scope });
  // Devices (phone etc.) must back consequential actions with a fresh TOTP code.
  if (principal.kind === 'device' && req.method !== 'GET' && needsTotp(url.pathname) && ctx.auth.totpActive()
      && !ctx.auth.checkTotp(String(req.headers['x-friday-totp'] ?? ''))) {
    return send(res, 403, { error: 'totp_required' });
  }
  if (req.method === 'GET' && url.pathname === '/v1/events') return openEventStream(req, res, ctx.bus, { principal: principal.id });
  try {
    const out = await router.dispatch(req.method, url.pathname, { req, url, body: bodyReader(req), rawBody: rawReader(req), principal });
    if (!out) return send(res, 404, { error: 'not_found' });
    if (!Array.isArray(out) && typeof out.raw === 'function') return await out.raw(res);
    return send(res, out[0], out[1], out[2]);
  } catch (error) {
    const [status, payload] = mapError(error);
    return send(res, status, payload);
  }
});

server.listen(port, host, () => console.log(`Friday core listening on http://${host}:${port}`));
server.on('error', (error) => {
  console.error(`Friday core failed to listen: ${error.message}`);
  try { ctx.stop(); } catch {}
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => { ctx.stop(); process.exit(0); });
  setTimeout(() => { ctx.stop(); process.exit(0); }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
