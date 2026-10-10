import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 43301;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');
function start(d) {
  const c = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: d, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.resume(); c.stderr.resume(); return c;
}
async function boot(t = 15000) {
  const s = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status === 200) return; } catch {}
    if (Date.now() - s > t) throw new Error('no boot');
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function stop(c) {
  c.kill('SIGTERM');
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('no exit')), 10000); c.on('exit', () => { clearTimeout(t); res(); }); });
}

test('all phases: jev route, schedules, research, workspaces, automations, audit, presence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-all-'));
  const child = start(dir);
  try {
    await boot();
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const auth = { Authorization: `Bearer ${token}` };
    const api = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...o, headers: { ...auth, ...(o.headers || {}) } });
    const J = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

    // JEV router: safe read needs no approval; send needs approval (fail-closed fallback).
    const r1 = await (await api('/v1/route', J({ instruction: 'find xyz.pdf in Downloads' }))).json();
    assert.equal(r1.route.intent, 'file_search');
    assert.equal(r1.route.tool, 'file.search');
    assert.equal(r1.route.needsApproval, false);
    const r2 = await (await api('/v1/route', J({ instruction: 'send xyz.pdf to Rohan on WhatsApp' }))).json();
    assert.equal(r2.route.needsApproval, true);
    assert.ok(r2.route.riskScore >= 3);
    assert.equal((await api('/v1/route', J({ instruction: '' }))).status, 400);

    // Scheduler + research + workspace + automations + audit + presence.
    const sched = await (await api('/v1/schedules', J({ title: 't', instruction: 'i', runAt: '2026-10-01T00:00:00.000Z' }))).json();
    assert.equal(sched.schedule.status, 'scheduled');
    const src = await (await api('/v1/research/sources', J({ url: 'https://example.com/a', title: 'A' }))).json();
    assert.ok(src.source.id);
    assert.equal((await api('/v1/research/sources', J({ url: 'http://bad.com', title: 'B' }))).status, 400);
    const ws = await (await api('/v1/workspaces', { method: 'POST' })).json();
    const wid = ws.workspace.id;
    assert.equal((await api(`/v1/workspaces/${wid}/write`, J({ path: 'a.txt', content: 'hi' }))).status, 200);
    assert.equal((await api(`/v1/workspaces/${wid}/write`, J({ path: '../../x', content: 'hi' }))).status, 400);
    const auto = await (await api('/v1/automations', J({ owner: 'me', trigger: { kind: 'build_failed' }, capabilities: ['notify'] }))).json();
    assert.equal(auto.automation.killSwitch, true);
    assert.equal((await api('/v1/automations', J({ owner: 'me', trigger: { kind: 'build_failed' }, capabilities: ['send'] }))).status, 400);
    assert.equal((await (await api('/v1/audit/verify')).json()).ok, true);
    const pres = await (await api('/v1/presence')).json();
    assert.equal(pres.presence.pet, 'sleeping');
    assert.equal(pres.presence.drivers.browser, 'scaffold-disabled');
    assert.equal(pres.jevConfigured, false);
  } finally {
    await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
