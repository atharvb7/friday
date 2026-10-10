import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeHub } from '../src/nodes.mjs';
import { EventEmitter } from 'node:events';

const fakeRes = () => { const r = new EventEmitter(); r.out = []; r.writeHead = () => {}; r.write = (x) => { r.out.push(x); return true; }; r.end = () => {}; return r; };
const frames = (res) => res.out.filter((x) => x.startsWith('event: command')).map((x) => JSON.parse(x.split('data: ')[1]));

test('hub: dispatch/result round trip, capability + offline + user-active rules, disconnect fails pending', async () => {
  let t = 1000;
  const hub = new NodeHub({ now: () => t });
  await assert.rejects(() => hub.dispatch({ action: 'screenshot' }), /node_offline/);
  const res = fakeRes(); const req = new EventEmitter();
  hub.attach('dev1', 'laptop', res, req);
  hub.hello('dev1', { caps: ['screenshot', 'desktop_click'], platform: 'linux' });
  await assert.rejects(() => hub.dispatch({ action: 'browser_open' }), /node_lacks_capability/);
  const p = hub.dispatch({ action: 'screenshot', args: { scale: 0.5 } });
  const [cmd] = frames(res);
  assert.equal(cmd.action, 'screenshot');
  assert.equal(hub.resolve('someone-else', { id: cmd.id, ok: true }), false, 'only the addressed node may answer');
  assert.ok(hub.resolve('dev1', { id: cmd.id, ok: true, result: { w: 10 } }));
  assert.deepEqual(await p, { w: 10 });
  // user activity blocks interactive actions but not read-only ones
  hub.activity('dev1', 10_000);
  await assert.rejects(() => hub.dispatch({ action: 'desktop_click', interactive: true }), (e) => e.code === 'user_active' && e.retryAfterMs > 0);
  const ro = hub.dispatch({ action: 'screenshot' }); hub.resolve('dev1', { id: frames(res).at(-1).id, ok: true, result: 1 }); await ro;
  t += 11_000;
  const ok = hub.dispatch({ action: 'desktop_click', interactive: true }); hub.resolve('dev1', { id: frames(res).at(-1).id, ok: true, result: 2 }); assert.equal(await ok, 2);
  // timeout + disconnect
  await assert.rejects(() => hub.dispatch({ action: 'screenshot', timeoutMs: 20 }), /node_timeout/);
  const pending = hub.dispatch({ action: 'screenshot' });
  hub.detach('dev1');
  await assert.rejects(() => pending, /node_disconnected/);
  assert.equal(hub.online, false);
});

const PORT = 43421;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

test('node protocol over HTTP: scoped device streams commands, answers them; others cannot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-node-'));
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_NVIDIA_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  const ac = new AbortController();
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const owner = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const call = (tok, path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
    const mk = async (name, scopes) => (await (await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name, scopes }) })).json()).device.token;
    const nodeTok = await mk('laptop', ['read', 'node']);
    const phone = await mk('phone', ['read', 'chat', 'tasks']);
    assert.equal((await call(phone, '/v1/node/hello', { method: 'POST', body: '{}' })).status, 403, 'a phone cannot impersonate a node');

    const stream = await fetch(base + '/v1/node/stream', { headers: { Authorization: `Bearer ${nodeTok}` }, signal: ac.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /event-stream/);
    assert.equal((await call(nodeTok, '/v1/node/hello', { method: 'POST', body: JSON.stringify({ caps: ['screenshot'], platform: 'linux' }) })).status, 200);
    const listed = await (await call(phone, '/v1/nodes')).json();
    assert.equal(listed.nodes.length, 1);
    assert.deepEqual(listed.nodes[0].caps, ['screenshot']);
    assert.equal((await call(nodeTok, '/v1/node/events', { method: 'POST', body: JSON.stringify({ type: 'activity', holdMs: 5000 }) })).status, 200);
    assert.equal((await (await call(phone, '/v1/nodes')).json()).nodes[0].userActive, true);
    ac.abort();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await (await call(phone, '/v1/nodes')).json()).nodes.length, 0, 'disconnect removes the node');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
    rmSync(dir, { recursive: true, force: true });
  }
});
