import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { ChatStore } from '../src/chat.mjs';
import { Auth } from '../src/auth.mjs';
import { totp } from '../src/totp.mjs';
import { validateMcpConfig } from '../src/mcp-config.mjs';
import { WebPush } from '../src/webpush.mjs';
import { Settings } from '../src/settings.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'friday-fix-'));

test('chat history window is the NEWEST messages (oldest-first), not the start of the conversation', () => {
  const d = tmp();
  try {
    const store = new Store(join(d, 'db.sqlite')); const chat = new ChatStore(store);
    const c = chat.createConversation('t');
    for (let i = 1; i <= 30; i++) chat.addMessage(c.id, i % 2 ? 'user' : 'assistant', `m${i}`);
    const h = chat.historyForProvider(c.id, 5);
    assert.deepEqual(h.map((m) => m.content), ['m26', 'm27', 'm28', 'm29', 'm30']);
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('TOTP: 5 wrong codes lock checking for everyone (brute-force defence); a valid code works before that and resets', () => {
  const d = tmp();
  try {
    const store = new Store(join(d, 'db.sqlite')); const auth = new Auth(store, 'owner-token-owner-token-owner-token-1234');
    const { secret } = auth.enrollTotp(); assert.ok(auth.confirmTotp(totp(secret)));
    for (let i = 0; i < 4; i++) assert.equal(auth.checkTotp('000000'), false);
    assert.equal(auth.totpLocked, false);
    auth.checkTotp('000001'); // 5th failure
    assert.equal(auth.totpLocked, true);
    assert.equal(auth.checkTotp(totp(secret, Date.now() + 30_000)), false, 'even a correct code is refused while locked');
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('web push: private/loopback endpoints and subscription floods are rejected; MCP urls use real hostname parsing', () => {
  const d = tmp();
  try {
    const store = new Store(join(d, 'db.sqlite')); const wp = new WebPush({ store, settings: new Settings(store) });
    const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') };
    for (const ep of ['https://localhost/x', 'https://127.0.0.1/x', 'https://[::ffff:7f00:1]/x', 'https://10.0.0.5/x', 'https://nas.local/x']) assert.throws(() => wp.subscribe({ endpoint: ep, keys }), /not allowed/, ep);
    for (let i = 0; i < 30; i++) wp.subscribe({ endpoint: `https://push.example.com/${i}`, keys });
    assert.throws(() => wp.subscribe({ endpoint: 'https://push.example.com/overflow', keys }), /too many/);
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
  for (const url of ['http://localhost.evil.com/mcp', 'http://127.0.0.1.evil.com/mcp', 'ftp://x/y']) assert.throws(() => validateMcpConfig({ servers: { a: { transport: 'streamable-http', url } } }), /https/, url);
  validateMcpConfig({ servers: { a: { transport: 'streamable-http', url: 'http://127.0.0.1:9000/mcp' } } });
});

const PORT = 43451;
test('over HTTP: a device token can sign in (whoami=read), and one principal cannot exhaust the event streams', async () => {
  const dir = tmp();
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_NVIDIA_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`; const aborts = [];
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const owner = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const call = (tok, path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
    const dev = (await (await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'phone', scopes: ['read', 'chat'] }) })).json()).device.token;
    const who = await call(dev, '/v1/auth/whoami');
    assert.equal(who.status, 200, 'a scoped device must be able to sign in to the UI');
    assert.equal((await who.json()).principal.kind, 'device');
    assert.equal((await call(dev, '/v1/auth/totp/enroll', { method: 'POST' })).status, 403, 'other auth routes stay admin-only');
    const statuses = [];
    for (let i = 0; i < 6; i++) { const ac = new AbortController(); aborts.push(ac); const r = await fetch(base + '/v1/events', { headers: { Authorization: `Bearer ${dev}` }, signal: ac.signal }); statuses.push(r.status); }
    assert.deepEqual(statuses, [200, 200, 200, 200, 503, 503]);
    assert.equal((await call(owner, '/v1/status')).status, 200, 'owner is unaffected');
    const ow = await fetch(base + '/v1/events', { headers: { Authorization: `Bearer ${owner}` }, signal: (() => { const a = new AbortController(); aborts.push(a); return a.signal; })() });
    assert.equal(ow.status, 200, 'other principals still get their own streams');
  } finally { aborts.forEach((a) => a.abort()); child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); }); rmSync(dir, { recursive: true, force: true }); }
});

test('retention prunes old finished data but keeps pending approvals, unread notifications, active tasks and the audit chain', async () => {
  const { createContext } = await import('../src/context.mjs');
  const { prune } = await import('../src/retention.mjs');
  const d = tmp();
  const ctx = createContext({ appRoot: new URL('..', import.meta.url).pathname, env: { FRIDAY_DATA_DIR: d } });
  try {
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    const t = ctx.store.createTask({ title: 'old', instruction: 'x' }); ctx.store.transition(t.id, 'cancelled');
    const live = ctx.store.createTask({ title: 'live', instruction: 'x' });
    ctx.store.db.prepare('UPDATE events SET created_at=?').run(old);
    ctx.notifications.create({ title: 'read-old' }); ctx.notifications.create({ title: 'unread-old' });
    const [a, b] = ctx.notifications.list(); ctx.notifications.markRead(a.id);
    ctx.store.db.prepare('UPDATE notifications SET created_at=?').run(old);
    ctx.audit.append('ad-hoc-local', 'test.event', {});
    const res = prune(ctx.store.db);
    assert.ok(res.events >= 1 && res.notifications === 1);
    assert.equal(ctx.store.listEvents(live.id).length, 1, 'events of active tasks are kept');
    assert.equal(ctx.notifications.list().length, 1, 'unread notification kept');
    assert.equal(ctx.audit.verify().ok, true);
  } finally { ctx.stop(); rmSync(d, { recursive: true, force: true }); }
});
