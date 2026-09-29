import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Memory } from './memory.mjs';
import { Effects } from './effects.mjs';
import { ResourceGovernor } from './resource-governor.mjs';
import { WorkerLoop } from './worker.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.FRIDAY_DATA_DIR ?? resolve(appRoot, 'data'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const tokenPath = resolve(dataDir, 'access-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
chmodSync(tokenPath, 0o600);
const token = readFileSync(tokenPath, 'utf8').trim();
const store = new Store(resolve(dataDir, 'friday.sqlite'));
const memory = new Memory(store);
const effects = new Effects(store);
const host = '127.0.0.1';
const port = Number(process.env.FRIDAY_PORT ?? 4317);

// Phase 1: the governor owns pressure state. Status reports its smoothed
// mode (with hysteresis) instead of a raw instantaneous reading.
// Telemetry is local, bounded, and rotated by the governor itself.
const governor = new ResourceGovernor({
  telemetryPath: resolve(dataDir, 'resource-telemetry.jsonl'),
});
governor.sample();
const governorTimer = setInterval(() => {
  try { governor.sample(); } catch { /* sampling must never crash the service */ }
}, 2000);
governorTimer.unref();

// Phase 1: no DSH execution adapter exists yet, so the worker loop runs but
// never claims tasks. This wires the lifecycle (start, cancel-abort,
// graceful shutdown) and makes /v1/status report honest worker state.
const dshAdapter = {
  status: () => ({ ready: false, reason: 'dsh_adapter_not_connected' }),
  run: async () => ({ status: 'failed', error: 'dsh_adapter_not_connected' }),
};
const worker = new WorkerLoop({ store, governor, adapter: dshAdapter });
worker.start();

// Loopback-only service: one bucket per source IP is enough, and it doubles
// as cheap brute-force protection for the bearer token.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;
const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateBuckets.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) return true;
  return false;
}

// Static UI: exact-path map only — no directory traversal is possible because
// the request path must match a key and filenames are fixed. Served without
// auth (the token gate lives in app.js); the API below always requires it.
const publicDir = resolve(appRoot, 'public');
const staticAssets = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);
const STATIC_SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};
function serveStatic(req, res, pathname) {
  const asset = staticAssets.get(pathname);
  if (!asset || req.method !== 'GET') return false;
  let body;
  try { body = readFileSync(resolve(publicDir, asset.file)); } catch { return false; }
  res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': body.length, ...STATIC_SECURITY_HEADERS });
  res.end(body);
  return true;
}

function isAuthorized(req) {
  const candidate = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(data);
}

async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64 * 1024) throw new Error('body_too_large');
  }
  return JSON.parse(text || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (serveStatic(req, res, url.pathname)) return;
  if (isRateLimited(req.socket.remoteAddress ?? 'unknown')) {
    return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  }
  if (!isAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
  try {
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      const snapshot = governor.getSnapshot();
      const adapterStatus = dshAdapter.status();
      return json(res, 200, {
        name: 'Friday',
        phase: 'foundation',
        resources: snapshot,
        tasks: store.countTasks(),
        worker: { running: worker.current !== null, currentTaskId: worker.current?.taskId ?? null, adapterReady: adapterStatus.ready, adapterReason: adapterStatus.reason ?? null },
        capabilities: { localModel: false, dsh: adapterStatus.ready, computerUse: false, remoteAccess: false },
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/tasks') return json(res, 200, { tasks: store.listTasks() });
    if (req.method === 'GET' && url.pathname === '/v1/memory') return json(res, 200, { memories: memory.list() });
    if (req.method === 'GET' && url.pathname === '/v1/memory/search') {
      try { return json(res, 200, { memories: memory.search(url.searchParams.get('q') ?? '') }); }
      catch (error) { if (error instanceof TypeError) return json(res, 400, { error: error.message }); throw error; }
    }
    if (req.method === 'POST' && url.pathname === '/v1/memory') {
      const body = await bodyJson(req);
      try { return json(res, 201, { memory: memory.create(body) }); }
      catch (error) { if (error instanceof TypeError) return json(res, 400, { error: error.message }); throw error; }
    }
    const memoryMatch = url.pathname.match(/^\/v1\/memory\/([a-f0-9-]+)$/);
    if (memoryMatch && req.method === 'DELETE') {
      const deleted = memory.delete(memoryMatch[1]);
      return json(res, deleted ? 200 : 404, { deleted });
    }
    if (req.method === 'POST' && url.pathname === '/v1/tasks') {
      const body = await bodyJson(req);
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 20000) return json(res, 400, { error: 'invalid_task' });
      const key = req.headers['idempotency-key'];
      if (key && (typeof key !== 'string' || key.length > 200)) return json(res, 400, { error: 'invalid_idempotency_key' });
      const task = store.createTask({ title: body.title.trim(), instruction: body.instruction.trim(), idempotencyKey: key ?? null });
      return json(res, 201, { task });
    }
    const match = url.pathname.match(/^\/v1\/tasks\/([a-f0-9-]+)(?:\/(events|effects|cancel))?$/);
    if (match) {
      const task = store.getTask(match[1]);
      if (!task) return json(res, 404, { error: 'not_found' });
      if (req.method === 'GET' && !match[2]) return json(res, 200, { task });
      if (req.method === 'GET' && match[2] === 'events') return json(res, 200, { events: store.listEvents(task.id) });
      if (req.method === 'GET' && match[2] === 'effects') return json(res, 200, { effects: effects.list(task.id) });
      if (req.method === 'POST' && match[2] === 'cancel') {
        worker.cancel(task.id);
        const result = store.transition(task.id, 'cancelled');
        return result.error ? json(res, 409, result) : json(res, 200, result);
      }
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    return json(res, error.message === 'body_too_large' ? 413 : error instanceof SyntaxError ? 400 : 500, { error: error.message === 'body_too_large' ? 'body_too_large' : error instanceof SyntaxError ? 'invalid_json' : 'internal_error' });
  }
});

server.listen(port, host, () => console.log(`Friday core listening on http://${host}:${port}`));
server.on('error', error => {
  console.error(`Friday core failed to listen: ${error.message}`);
  try { store.close(); } catch {}
  process.exitCode = 1;
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
  clearInterval(governorTimer);
  server.close(() => { try { store.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { store.close(); } catch {} process.exit(0); }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
