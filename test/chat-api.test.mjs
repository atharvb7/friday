import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 43311;
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

test('chat api: local brain answers, persists, validates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-chatapi-'));
  const child = start(dir);
  try {
    await boot();
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const auth = { Authorization: `Bearer ${token}` };
    const api = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...o, headers: { ...auth, ...(o.headers || {}) } });
    const J = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

    assert.equal((await fetch(`http://127.0.0.1:${PORT}/v1/chat`, J({ message: 'hi' }))).status, 401);
    assert.equal((await api('/v1/chat', J({ message: '' }))).status, 400);

    const status = await (await api('/v1/status')).json();
    assert.equal(status.brain, 'local-fallback');
    assert.equal(status.nemotronConfigured, false);

    // Chitchat in a fresh conversation.
    const r1 = await (await api('/v1/chat', J({ message: 'hello friday' }))).json();
    assert.ok(r1.conversation.id);
    assert.equal(r1.brain, 'local-fallback');
    assert.match(r1.reply, /Hey|Friday/);

    // Remember + recall across turns in the same conversation.
    const cid = r1.conversation.id;
    const r2 = await (await api('/v1/chat', J({ conversationId: cid, message: 'remember my bike is red' }))).json();
    assert.match(r2.reply, /Saved/);
    const r3 = await (await api('/v1/chat', J({ conversationId: cid, message: 'what do you remember about my bike?' }))).json();
    assert.match(r3.reply, /red/);

    // History round-trip + conversation list.
    const hist = await (await api(`/v1/chat/${cid}`)).json();
    assert.equal(hist.messages.length, 6);
    // The reply names its saved message ids, so the web app can tell its own messages from ones that arrive later (pictures).
    assert.deepEqual(r3.messageIds, hist.messages.slice(-2).map((m) => m.id));
    assert.deepEqual(hist.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const chats = await (await api('/v1/chats')).json();
    assert.ok(chats.conversations.some((c) => c.id === cid));
    assert.equal((await api('/v1/chat/nope')).status, 404);
    assert.equal((await api('/v1/chat', J({ conversationId: 'nope', message: 'hi' }))).status, 404);

    // Consequential ask becomes words + approval guidance, never an action.
    const r4 = await (await api('/v1/chat', J({ message: 'send xyz.pdf to Rohan on WhatsApp' }))).json();
    assert.match(r4.reply, /approval/);
  } finally {
    await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
