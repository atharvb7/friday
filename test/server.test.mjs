import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 43199;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

function startServer(dataDir) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, FRIDAY_DATA_DIR: dataDir, FRIDAY_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForBoot(timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.status === 200) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error('server did not boot in time');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function stopServer(child, timeoutMs = 10000) {
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not exit in time')), timeoutMs);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('wired server: static UI, governor status, true counts, cancel, hardening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-server-'));
  const child = startServer(dir);
  try {
    await waitForBoot();
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const auth = { Authorization: `Bearer ${token}` };
    const api = (path, options = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, { ...options, headers: { ...auth, ...(options.headers || {}) } });

    // Static UI needs no auth; exact paths only.
    const index = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await index.text(), /Friday/);
    const appJs = await fetch(`http://127.0.0.1:${PORT}/app.js`);
    assert.equal(appJs.status, 200);
    assert.match(appJs.headers.get('content-type'), /javascript/);
    const css = await fetch(`http://127.0.0.1:${PORT}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/../package.json`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/nope.js`)).status, 401);

    // API still requires auth.
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/v1/status`)).status, 401);
    // Exact-path static map: even authenticated, traversal-style paths are 404.
    assert.equal((await api('/../package.json')).status, 404);
    assert.equal((await api('/nope.js')).status, 404);

    // Status reports governor mode, a true task count, and worker state.
    let status = await (await api('/v1/status')).json();
    assert.equal(status.name, 'Friday');
    assert.ok(['normal', 'constrained', 'paused', 'emergency'].includes(status.resources.mode));
    assert.equal(status.tasks, 0);
    assert.equal(status.worker.running, false);
    assert.equal(status.worker.adapterReady, false);
    assert.equal(status.capabilities.dsh, false);

    // True count (not capped at list length) and cancel through the worker path.
    const mkTask = title => api('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `srv-${title}` },
      body: JSON.stringify({ title, instruction: 'wired slice' }),
    });
    assert.equal((await (await mkTask('one')).json()).task.status, 'queued');
    assert.equal((await (await mkTask('two')).json()).task.status, 'queued');
    status = await (await api('/v1/status')).json();
    assert.equal(status.tasks, 2);
    const tasks = await (await api('/v1/tasks')).json();
    const cancel = await api(`/v1/tasks/${tasks.tasks[0].id}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).task.status, 'cancelled');

    // Overlong memory search is a 400, not a 500.
    assert.equal((await api(`/v1/memory/search?q=${'x'.repeat(201)}`)).status, 400);
  } finally {
    await stopServer(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
