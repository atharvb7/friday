import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReelPipeline } from '../src/reel.mjs';
import { Store } from '../src/store.mjs';
import { ChatStore } from '../src/chat.mjs';

test('reel pipeline: a finished reel_create job is edited on the laptop, then sent to WhatsApp; failures are reported, not retried blindly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-reel-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const chat = new ChatStore(store); const conv = chat.createConversation('t');
    const zipId = '11111111-2222-3333-4444-555555555555';
    const dispatched = []; let editResult = { done: true, path: '/home/u/Downloads/friday-media/reel-goa/final.mp4', size: 5_000_000, summary: '18 s, hook first' };
    const nodes = { online: true, dispatch: async (c) => { dispatched.push(c); return c.action === 'reel_zip' ? { file: { id: zipId }, files: 6, bytes: 31_457_280 } : editResult; } };
    const sent = [];
    const reels = new ReelPipeline({ store, nodes, chat, createSendTask: (o) => { sent.push(o); return { id: 'send-task-1234' }; } });
    const t = store.createTask({ title: 'reel', kind: 'computer', instruction: 'x', conversationId: conv.id, meta: { grant: true, reel: { slug: 'goa', folder: 'reel-goa', brief: 'goa sunset', aspect: '9:16', autoEdit: true, autoSend: true } } });
    store.transition(t.id, 'running'); store.transition(t.id, 'completed', { result: 'clips done' });
    await reels.onTaskCompleted(t.id);
    assert.equal(dispatched[0].action, 'reel_zip', 'the zip of all assets comes first'); assert.deepEqual(dispatched[0].args, { folder: 'reel-goa', conversationId: conv.id });
    assert.match(chat.listMessages(conv.id).find((m) => m.attachments?.length === 0 || true).content + chat.listMessages(conv.id).map((m) => m.content).join('\n'), /All generated photos and videos/);
    assert.equal(dispatched[1].action, 'reel_edit'); assert.deepEqual(dispatched[1].args, { folder: 'reel-goa', brief: 'goa sunset', aspect: '9:16', seconds: null });
    assert.ok(dispatched[1].timeoutMs >= 30 * 60_000);
    assert.equal(sent[0].path, '/home/u/Downloads/friday-media/reel-goa/final.mp4');
    assert.match(chat.listMessages(conv.id).map((m) => m.content).join('\n'), /Opening Claude Code[\s\S]*Reel edited[\s\S]*Sending it to your WhatsApp/);
    // a plain laptop task (no reel meta) does nothing
    const other = store.createTask({ title: 'x', kind: 'computer', instruction: 'x', meta: { grant: true } }); store.transition(other.id, 'running'); store.transition(other.id, 'completed', { result: 'ok' });
    await reels.onTaskCompleted(other.id); assert.equal(dispatched.length, 2);
    // edit fails -> told, nothing sent
    editResult = { done: false, error: 'no final.mp4 was exported' };
    await reels.edit({ conversationId: conv.id, folder: 'reel-goa', title: 'goa' });
    assert.equal(sent.length, 1); assert.match(chat.listMessages(conv.id).at(-1).content, /couldn't finish the reel/);
    nodes.online = false;
    assert.equal((await reels.edit({ conversationId: conv.id, folder: 'reel-goa', title: 'goa' })).error, 'laptop_offline');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('reel pipeline default: clips done -> only a .zip in the chat (no edit, no WhatsApp)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-reel2-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const chat = new ChatStore(store); const conv = chat.createConversation('t');
    const dispatched = []; const sent = [];
    const nodes = { online: true, dispatch: async (c) => { dispatched.push(c); return { file: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, files: 4, bytes: 10_485_760 }; } };
    const reels = new ReelPipeline({ store, nodes, chat, createSendTask: (o) => { sent.push(o); return { id: 'x' }; } });
    const t = store.createTask({ title: 'reel', kind: 'computer', instruction: 'x', conversationId: conv.id, meta: { grant: true, reel: { slug: 'rain', folder: 'reel-rain', zip: true, autoEdit: false } } });
    store.transition(t.id, 'running'); store.transition(t.id, 'completed', { result: 'done' });
    await reels.onTaskCompleted(t.id);
    assert.deepEqual(dispatched.map((d) => d.action), ['reel_zip']);
    assert.equal(sent.length, 0);
    assert.match(chat.listMessages(conv.id).at(-1).content, /4 files, 10 MB/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
