import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const PORT = 43411, PUB = 43412;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');
const b32 = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/=+$/, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
const totp = (secret, offset = 0) => { const step = Math.floor(Date.now() / 30000) + offset; const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step)); const h = createHmac('sha1', b32(secret)).update(msg).digest(); const o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };

test('public listener: raw tokens refused, token+TOTP gives a session without admin/node, lockout, private address unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-pub-'));
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_PUBLIC_PORT: String(PUB) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`http://127.0.0.1:${PUB}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const pub = (p, o = {}) => fetch(`http://127.0.0.1:${PUB}${p}`, o);
    const priv = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...o, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(o.headers ?? {}) } });
    assert.deepEqual(await (await pub('/v1/auth/mode')).json(), { public: true, totpActive: false, password: false, google: false });
    assert.equal((await (await fetch(`http://127.0.0.1:${PORT}/v1/auth/mode`)).json()).public, false);
    assert.match((await pub('/')).headers.get('strict-transport-security') ?? '', /max-age/);
    assert.equal((await pub('/v1/status', { headers: { Authorization: `Bearer ${token}` } })).status, 401, 'raw owner token is not enough on the internet');
    const login = (code, t = token, ip = '9.9.9.9') => pub('/v1/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ token: t, code }) });
    assert.equal((await (await login('123456')).json()).error, 'totp_not_set_up');
    const en = await (await priv('/v1/auth/totp/enroll', { method: 'POST' })).json();
    assert.equal((await priv('/v1/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code: totp(en.secret, -1) }) })).status, 200); // codes from three different 30s steps: -1 confirm, 0 token login, +1 password login
    assert.equal((await login('000000')).status, 401);
    const ok = await login(totp(en.secret, 0));
    assert.equal(ok.status, 201);
    const sess = (await ok.json()).token;
    assert.match(sess, /^fws_/);
    const as = (p, o = {}) => pub(p, { ...o, headers: { Authorization: `Bearer ${sess}`, ...(o.headers ?? {}) } });
    assert.equal((await as('/v1/status')).status, 200);
    assert.equal((await as('/v1/devices')).status, 403, 'admin stays private');
    assert.equal((await as('/v1/node/status')).status, 403, 'laptop node stays private');
    assert.equal((await as('/v1/emergency-clear', { method: 'POST' })).status, 403, 'consequential actions need a fresh code');
    const list = await (await priv('/v1/sessions')).json();
    assert.equal(list.sessions.length, 1);
    await priv(`/v1/sessions/${list.sessions[0].id}`, { method: 'DELETE' });
    assert.equal((await as('/v1/status')).status, 401, 'revoked session is dead');
    assert.equal((await priv('/v1/status')).status, 200, 'private address still takes the raw token');
    // email + password (+ authenticator) on the public site
    assert.equal((await priv('/v1/auth/password', { method: 'POST', body: JSON.stringify({ email: 'me@x.com', password: 'a-good-password-1' }) })).status, 200);
    assert.equal((await (await pub('/v1/auth/mode')).json()).password, true);
    const plog = (body, ip = '5.5.5.5') => pub('/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) });
    assert.equal((await plog({ email: 'me@x.com', password: 'wrong-password-9', code: totp(en.secret) })).status, 401);
    assert.equal((await plog({ email: 'me@x.com', password: 'a-good-password-1', code: '000000' })).status, 401, 'password alone is not enough');
    let okp = null; for (const off of [1]) { const r = await plog({ email: 'me@x.com', password: 'a-good-password-1', code: totp(en.secret, off) }); if (r.status === 201) { okp = r; break; } }
    assert.ok(okp, 'password + current code signs in');
    const ps = (await okp.json()).token;
    assert.equal((await pub('/v1/status', { headers: { Authorization: `Bearer ${ps}` } })).status, 200);
    assert.equal((await pub('/v1/auth/login-settings', { headers: { Authorization: `Bearer ${ps}` } })).status, 403, 'login settings are owner-only on the private address');
    assert.equal((await pub('/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/v1/auth/login`, { method: 'POST', body: '{}' })).status, 401, 'password login does not exist on the private address');
    for (let i = 0; i < 10; i++) await login('111111', token, '6.6.6.6');
    assert.equal((await login(totp(en.secret), token, '6.6.6.6')).status, 429, 'locked out after 10 failures');
    assert.notEqual((await login('111111', token, '7.7.7.7')).status, 429, 'other visitors unaffected');
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); rmSync(dir, { recursive: true, force: true });
  }
});
