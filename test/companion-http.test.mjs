import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 43431;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

test('companion over HTTP: read+chat device streams state, reports presence, voice reports not-installed honestly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-cmp-'));
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_NVIDIA_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`; const ac = new AbortController();
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const owner = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const call = (tok, path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
    const dev = (await (await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'desk', scopes: ['read', 'chat'] }) })).json()).device.token;

    assert.equal((await (await call(dev, '/v1/companion')).json()).state, 'offline', 'no brain configured in this test server');
    const res = await fetch(base + '/v1/companion/stream', { headers: { Authorization: `Bearer ${dev}` }, signal: ac.signal });
    const reader = res.body.getReader(); let text = '';
    const t0 = Date.now(); while (!text.includes('event: state') && Date.now() - t0 < 4000) text += Buffer.from((await reader.read()).value).toString();
    assert.match(text, /"state":"offline"/);
    assert.equal((await call(dev, '/v1/companion/events', { method: 'POST', body: JSON.stringify({ type: 'presence', distanceCm: 80 }) })).status, 200);
    assert.equal((await call(dev, '/v1/companion/events', { method: 'POST', body: JSON.stringify({ type: 'nuke' }) })).status, 400);
    assert.equal((await call(dev, '/v1/tasks', { method: 'POST', body: JSON.stringify({ title: 'x', instruction: 'y' }) })).status, 403, 'a desk device cannot create tasks');
    const st = await (await call(dev, '/v1/voice/status')).json();
    assert.equal(st.stt, 'not_installed'); assert.equal(st.tts, 'not_installed'); assert.equal(st.engine, 'none');
    const ask = await fetch(base + '/v1/voice/ask', { method: 'POST', headers: { Authorization: `Bearer ${dev}`, 'Content-Type': 'audio/wav' }, body: Buffer.alloc(100) });
    assert.equal(ask.status, 501);
    // laptop push-to-talk: text already transcribed on the device (works without server STT)
    const turn = await call(dev, '/v1/voice/turn', { method: 'POST', body: JSON.stringify({ text: 'hello there' }) });
    assert.equal(turn.status, 200); const tj = await turn.json();
    assert.equal(tj.heard, 'hello there'); assert.equal(typeof tj.reply, 'string'); assert.ok(tj.conversationId);
    assert.equal((await call(dev, '/v1/voice/turn', { method: 'POST', body: JSON.stringify({ text: 'x', image: { mime: 'image/png', data: 'AAAA' } }) })).status, 400);
    assert.equal((await call(dev, '/v1/voice/turn', { method: 'POST', body: JSON.stringify({}) })).status, 400);
    ac.abort();
  } finally { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); }); rmSync(dir, { recursive: true, force: true }); }
});
