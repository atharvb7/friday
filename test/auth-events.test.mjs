import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totp, verifyTotp, hotp, base32Encode } from '../src/totp.mjs';
import { EventBus } from '../src/events.mjs';

const PORT = 43391;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

test('TOTP matches RFC 6238 vector and rejects bad/replayed codes', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(hotp(secret, 1), '287082'); // RFC 4226 test vector
  assert.equal(totp(secret, 59_000), '287082'); // RFC 6238 vector (T=59s)
  const now = 1_700_000_000_000;
  const code = totp(secret, now);
  assert.notEqual(verifyTotp(secret, code, { now }), null);
  assert.equal(verifyTotp(secret, '000000', { now: now + 10 * 60_000 }), null);
  assert.equal(verifyTotp(secret, 'abc', { now }), null);
});

test('EventBus replays after an id and isolates bad subscribers', () => {
  const bus = new EventBus({ size: 3 });
  bus.subscribe(() => { throw new Error('boom'); });
  const seen = [];
  const off = bus.subscribe((e) => seen.push(e.type));
  for (const t of ['a', 'b', 'c', 'd']) bus.publish(t);
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  assert.deepEqual(bus.since(2).map((e) => e.type), ['c', 'd']);
  assert.equal(bus.since(0).length, 3); // ring buffer capped
  off();
  assert.equal(bus.subscriberCount, 1);
});

test('devices: scoped, revocable, TOTP-gated approvals, SSE stream, health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-auth-'));
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_NVIDIA_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const owner = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const call = (tok, path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });

    // owner creates a limited phone device; admin scope is not grantable
    assert.equal((await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'bad', scopes: ['admin'] }) })).status, 400);
    const created = await (await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'phone', scopes: ['read', 'chat', 'tasks', 'approve'] }) })).json();
    const phone = created.device.token;
    assert.match(phone, /^fdv_/);
    assert.equal((await call(phone, '/v1/status')).status, 200);
    assert.equal((await call(phone, '/v1/devices')).status, 403); // admin is owner-only
    assert.ok(!JSON.stringify(await (await call(owner, '/v1/devices')).json()).includes(phone)); // token never listed

    // read-only device cannot create tasks, but CAN emergency-stop
    const ro = (await (await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'esp', scopes: ['read'] }) })).json()).device.token;
    assert.equal((await call(ro, '/v1/tasks', { method: 'POST', body: JSON.stringify({ title: 't', instruction: 'i' }) })).status, 403);
    assert.equal((await call(ro, '/v1/emergency-stop', { method: 'POST' })).status, 200);
    assert.equal((await call(owner, '/v1/emergency-clear', { method: 'POST' })).status, 200);

    // TOTP: enrol + confirm, then device approvals need a fresh code
    const enrol = await (await call(owner, '/v1/auth/totp/enroll', { method: 'POST' })).json();
    assert.equal((await call(owner, '/v1/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code: '123456' }) })).status, 400);
    assert.equal((await call(owner, '/v1/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code: totp(enrol.secret) }) })).status, 200);
    const noCode = await call(phone, '/v1/emergency-clear', { method: 'POST' });
    assert.equal(noCode.status, 403);
    assert.equal((await noCode.json()).error, 'totp_required');
    // owner is exempt (it already holds the local secret file)
    assert.equal((await call(owner, '/v1/emergency-clear', { method: 'POST' })).status, 200);

    // revoke -> immediately unauthorized
    assert.equal((await call(owner, `/v1/devices/${created.device.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await call(phone, '/v1/status')).status, 401);

    // SSE: replays task events and streams new ones (auth header, no URL secret)
    const ac = new AbortController();
    const res = await fetch(base + '/v1/events', { headers: { Authorization: `Bearer ${owner}` }, signal: ac.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    await call(owner, '/v1/tasks', { method: 'POST', body: JSON.stringify({ title: 'sse', instruction: 'x' }) });
    const reader = res.body.getReader();
    let text = '';
    const t0 = Date.now();
    while (!text.includes('task.created') && Date.now() - t0 < 5000) { const { value } = await reader.read(); text += Buffer.from(value).toString(); }
    ac.abort();
    assert.match(text, /event: task\.created/);

    const health = await (await call(owner, '/v1/health')).json();
    assert.ok(['ok', 'degraded', 'down'].includes(health.overall));
    assert.ok(health.checks.find((c) => c.name === 'local_model' && c.status === 'off'));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
    rmSync(dir, { recursive: true, force: true });
  }
});
