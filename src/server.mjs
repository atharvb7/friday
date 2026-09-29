import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { readResources } from './resources.mjs';
import { Memory } from './memory.mjs';
import { Effects } from './effects.mjs';

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

function isAuthorized(req) {
  const candidate = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
  if (!isAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, `http://${host}:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      return json(res, 200, { name: 'Friday', phase: 'foundation', resources: readResources(), tasks: store.listTasks().length, capabilities: { localModel: false, dsh: false, computerUse: false, remoteAccess: false } });
    }
    if (req.method === 'GET' && url.pathname === '/v1/tasks') return json(res, 200, { tasks: store.listTasks() });
    if (req.method === 'GET' && url.pathname === '/v1/memory') return json(res, 200, { memories: memory.list() });
    if (req.method === 'GET' && url.pathname === '/v1/memory/search') return json(res, 200, { memories: memory.search(url.searchParams.get('q') ?? '') });
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
  store.close();
  process.exitCode = 1;
});
function shutdown() { server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
