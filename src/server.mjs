import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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
import { computerRoutes } from './routes/computer.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Local secrets file (gitignored, 0600). Real env vars win. FRIDAY_NO_DOTENV=1 keeps tests hermetic.
if (process.env.FRIDAY_NO_DOTENV !== '1') loadEnvFile(resolve(appRoot, '.env'));

const host = '127.0.0.1';
const port = Number(process.env.FRIDAY_PORT ?? 4317);
const ctx = createContext({ appRoot });
ctx.start();

const router = new Router();
for (const register of [systemRoutes, taskRoutes, memoryRoutes, toolRoutes, chatRoutes, workRoutes, computerRoutes]) register(router, ctx);
const serveStatic = makeStaticServer(resolve(appRoot, 'public'));

// One bucket per source IP: cheap brute-force protection for the bearer token.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;
const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateBuckets.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) { rateBuckets.set(ip, { start: now, count: 1 }); return false; }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function isAuthorized(req) {
  const a = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
  const b = Buffer.from(ctx.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, payload, extraHeaders = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(data);
}

const MAX_BODY = 64 * 1024;
function bodyReader(req) {
  return async ({ optional = false } = {}) => {
    try {
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > MAX_BODY) throw new Error('body_too_large');
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
  if (isRateLimited(req.socket.remoteAddress ?? 'unknown')) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  if (!isAuthorized(req)) return send(res, 401, { error: 'unauthorized' });
  try {
    const out = await router.dispatch(req.method, url.pathname, { req, url, body: bodyReader(req) });
    if (!out) return send(res, 404, { error: 'not_found' });
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
