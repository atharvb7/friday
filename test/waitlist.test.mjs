import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Waitlist, NOTIFY_PER_DAY } from '../src/waitlist.mjs';

test('waitlist: joins once, normalises, rejects bad emails, caps owner notifications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-wait-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const notes = [];
    const w = new Waitlist({ store, notifications: { create: (n) => notes.push(n) } });
    assert.deepEqual(w.join({ email: '  Maya@Example.com ', source: 'hero' }), { joined: true });
    assert.deepEqual(w.join({ email: 'maya@example.com', source: 'final' }), { joined: false }, 'second time is not a new entry');
    assert.equal(w.count(), 1);
    assert.equal(w.list()[0].email, 'maya@example.com');
    assert.equal(w.list()[0].source, 'hero');
    assert.equal(w.join({ email: 'x@y.co', source: '<script>' }).joined, true);
    assert.equal(w.list().find((r) => r.email === 'x@y.co').source, 'other', 'unknown sources are not stored as given');
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', `${'a'.repeat(250)}@b.com`, null]) assert.throws(() => w.join({ email: bad }), TypeError, String(bad));
    assert.equal(notes.length, 2);
    assert.match(notes[0].title, /maya@example\.com/);
    for (let i = 0; i < NOTIFY_PER_DAY + 5; i++) w.join({ email: `p${i}@example.com` });
    assert.equal(notes.length, NOTIFY_PER_DAY, 'a burst cannot flood the inbox');
    assert.equal(w.remove('MAYA@example.com'), true);
    assert.equal(w.remove('maya@example.com'), false);
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});

const PORT = 43431, PUB = 43432;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

test('waitlist over HTTP: public join without auth, JSON only, honeypot, same answer twice, owner-only list, rate limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-wait-http-'));
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_PUBLIC_PORT: String(PUB) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`http://127.0.0.1:${PUB}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const join_ = (body, ip = '7.7.7.7', type = 'application/json') => fetch(`http://127.0.0.1:${PUB}/v1/waitlist`, { method: 'POST', headers: { 'Content-Type': type, 'CF-Connecting-IP': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const r1 = await join_({ email: 'Maya@Example.com', source: 'hero' });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true });
    assert.deepEqual(await (await join_({ email: 'maya@example.com', source: 'final' })).json(), { ok: true }, 'repeat looks the same: no membership oracle');
    assert.equal((await join_({ email: 'not-an-email' })).status, 400);
    assert.equal((await join_('email=a%40b.com', '7.7.7.8', 'application/x-www-form-urlencoded')).status, 415, 'cross-site forms cannot post');
    assert.equal((await join_({ email: 'bot@spam.com', website: 'http://spam' }, '7.7.7.9')).status, 200, 'honeypot answers ok');
    const priv = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...o, headers: { Authorization: `Bearer ${token}`, ...(o.headers ?? {}) } });
    const list = await (await priv('/v1/waitlist')).json();
    assert.equal(list.count, 1, 'the honeypot entry was not stored');
    assert.equal(list.entries[0].email, 'maya@example.com');
    assert.equal((await fetch(`http://127.0.0.1:${PUB}/v1/waitlist`)).status, 401, 'the list is not public');
    assert.equal((await priv('/v1/waitlist/maya%40example.com', { method: 'DELETE' })).status, 200);
    assert.equal((await (await priv('/v1/waitlist')).json()).count, 0);
    // CORS: the landing (its own site) may ask; other sites may not.
    const pre = (origin) => fetch(`http://127.0.0.1:${PUB}/v1/waitlist`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    const okPre = await pre('https://fridayy.site');
    assert.equal(okPre.status, 204);
    assert.equal(okPre.headers.get('access-control-allow-origin'), 'https://fridayy.site');
    assert.match(okPre.headers.get('access-control-allow-headers') ?? '', /Content-Type/i);
    const badPre = await pre('https://evil.example');
    assert.equal(badPre.status, 403);
    assert.equal(badPre.headers.get('access-control-allow-origin'), null);
    const fromLanding = await fetch(`http://127.0.0.1:${PUB}/v1/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://fridayy-landing-page.vercel.app', 'CF-Connecting-IP': '8.8.8.1' }, body: JSON.stringify({ email: 'cors@example.com', source: 'hero' }) });
    assert.equal(fromLanding.status, 200);
    assert.equal(fromLanding.headers.get('access-control-allow-origin'), 'https://fridayy-landing-page.vercel.app');
    assert.equal((await fetch(`http://127.0.0.1:${PUB}/v1/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'CF-Connecting-IP': '8.8.8.2' }, body: JSON.stringify({ email: 'evil@example.com' }) })).status, 403);
    assert.equal((await (await priv('/v1/waitlist')).json()).entries.some((e) => e.email === 'evil@example.com'), false);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await join_({ email: `r${i}@example.com` }, '6.6.6.6')).status;
    assert.equal(last, 429, 'per-IP rate limit');
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
