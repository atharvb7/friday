import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 43299;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');
const unitPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'systemd', 'friday.service.in');

function startServer(dataDir) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, FRIDAY_DATA_DIR: dataDir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  return child;
}
async function waitForBoot(timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status === 200) return; } catch {}
    if (Date.now() - start > timeoutMs) throw new Error('no boot');
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function stopServer(child) {
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no exit')), 10000);
    child.on('exit', () => { clearTimeout(t); resolve(); });
  });
}

test('phase1: status/tools/effects-approval/emergency-stop/systemd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-phase1-'));
  const child = startServer(dir);
  try {
    await waitForBoot();
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const auth = { Authorization: `Bearer ${token}` };
    const api = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...o, headers: { ...auth, ...(o.headers || {}) } });

    const status = await (await api('/v1/status')).json();
    assert.equal(status.phase, 'phase1');
    assert.ok(typeof status.emergencyStopped === 'boolean');
    assert.ok(status.provider && typeof status.provider.consecutiveFailures === 'number');
    assert.ok('cgroup' in status.resources);
    assert.equal(status.capabilities.localModel, false);
    assert.equal(status.capabilities.remoteAccess, false);

    // Safe tools only; traversal blocked.
    const tools = await (await api('/v1/tools')).json();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['file.read', 'file.search', 'research.record']);
    assert.equal((await api('/v1/tools/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'nope', args: {} }) })).status, 404);
    const trav = await api('/v1/tools/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'file.read', args: { path: '../../etc/passwd' } }) });
    assert.equal(trav.status, 400);

    // Effect approval: propose -> approve -> single-use enforced.
    const task = (await (await api('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 't', instruction: 'i' }) })).json()).task;
    const args = { to: 'x', n: 1 };
    const prop = await api(`/v1/tasks/${task.id}/effects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'test.effect', exactArgs: args }) });
    assert.equal(prop.status, 201);
    const { effect, approvalToken } = await prop.json();
    assert.equal(effect.status, 'awaiting_approval');
    assert.ok(typeof approvalToken === 'string' && approvalToken.length > 16);
    const ok = await api(`/v1/effects/${effect.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalToken, exactArgs: args }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).effect.status, 'approved');
    const again = await api(`/v1/effects/${effect.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalToken, exactArgs: args }) });
    assert.equal(again.status, 400);
    const listed = await (await api(`/v1/tasks/${task.id}/effects`)).json();
    assert.ok(listed.effects.some((e) => e.id === effect.id));

    // Emergency stop latch + clear.
    assert.equal((await (await api('/v1/emergency-stop', { method: 'POST' })).json()).emergencyStopped, true);
    assert.equal((await (await api('/v1/status')).json()).emergencyStopped, true);
    assert.equal((await (await api('/v1/emergency-clear', { method: 'POST' })).json()).emergencyStopped, false);

    // Systemd unit stays staged with 2G cap, loopback, no auto-enable changes here.
    assert.ok(existsSync(unitPath));
    const unit = readFileSync(unitPath, 'utf8');
    assert.match(unit, /MemoryMax=@MEM_MAX@/);
    assert.match(unit, /MemoryHigh=@MEM_HIGH@/);
    assert.match(unit, /127\.0\.0\.1|src\/server\.mjs/);
  } finally {
    await stopServer(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
