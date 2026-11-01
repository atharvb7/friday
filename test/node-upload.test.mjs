import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 43431;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

test('node upload: the laptop node can hand a .zip bundle to Friday (node scope only, .zip only), and it downloads intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-up-'));
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const owner = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const api = (p, o = {}, tok = owner) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...o, headers: { Authorization: `Bearer ${tok}`, ...(o.headers ?? {}) } });
    const node = (await (await api('/v1/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'laptop-node', scopes: ['read', 'node'] }) })).json()).device.token;
    const phone = (await (await api('/v1/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'phone', scopes: ['read', 'chat', 'tasks'] }) })).json()).device.token;
    const conv = (await (await api('/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) })).json()).conversation.id;
    const zip = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(30 * 1024 * 1024, 9)]); // 30 MB: above the 25 MB chat-upload cap on purpose
    assert.equal((await api('/v1/node/upload?name=x.zip', { method: 'POST', body: zip }, phone)).status, 403, 'only the laptop node');
    assert.equal((await api('/v1/node/upload?name=x.exe', { method: 'POST', body: Buffer.from('MZ') }, node)).status, 400, '.zip only');
    const up = await api(`/v1/node/upload?name=reel-rain.zip&conversation=${conv}`, { method: 'POST', body: zip }, node);
    assert.equal(up.status, 201);
    const f = (await up.json()).file;
    assert.equal(f.name, 'reel-rain.zip'); assert.equal(f.size, zip.length);
    const back = Buffer.from(await (await api(`/v1/files/${f.id}`)).arrayBuffer());
    assert.ok(back.equals(zip), 'downloads byte-identical');
  } finally { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); rmSync(dir, { recursive: true, force: true }); }
});
