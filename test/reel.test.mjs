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
    const dispatched = []; let editResult = { done: true, path: '/home/u/Downloads/friday-media/reel-goa/final.mp4', size: 5_000_000, summary: '18 s, hook first' };
    const nodes = { online: true, dispatch: async (c) => { dispatched.push(c); return editResult; } };
    const sent = [];
    const reels = new ReelPipeline({ store, nodes, chat, createSendTask: (o) => { sent.push(o); return { id: 'send-task-1234' }; } });
    const t = store.createTask({ title: 'reel', kind: 'computer', instruction: 'x', conversationId: conv.id, meta: { grant: true, reel: { slug: 'goa', folder: 'reel-goa', brief: 'goa sunset', aspect: '9:16', autoEdit: true, autoSend: true } } });
    store.transition(t.id, 'running'); store.transition(t.id, 'completed', { result: 'clips done' });
    await reels.onTaskCompleted(t.id);
    assert.equal(dispatched[0].action, 'reel_edit'); assert.deepEqual(dispatched[0].args, { folder: 'reel-goa', brief: 'goa sunset', aspect: '9:16', seconds: null });
    assert.ok(dispatched[0].timeoutMs >= 30 * 60_000);
    assert.equal(sent[0].path, '/home/u/Downloads/friday-media/reel-goa/final.mp4');
    assert.match(chat.listMessages(conv.id).map((m) => m.content).join('\n'), /Opening Claude Code[\s\S]*Reel edited[\s\S]*Sending it to your WhatsApp/);
    // a plain laptop task (no reel meta) does nothing
    const other = store.createTask({ title: 'x', kind: 'computer', instruction: 'x', meta: { grant: true } }); store.transition(other.id, 'running'); store.transition(other.id, 'completed', { result: 'ok' });
    await reels.onTaskCompleted(other.id); assert.equal(dispatched.length, 1);
    // edit fails -> told, nothing sent
    editResult = { done: false, error: 'no final.mp4 was exported' };
    await reels.edit({ conversationId: conv.id, folder: 'reel-goa', title: 'goa' });
    assert.equal(sent.length, 1); assert.match(chat.listMessages(conv.id).at(-1).content, /couldn't finish the reel/);
    nodes.online = false;
    assert.equal((await reels.edit({ conversationId: conv.id, folder: 'reel-goa', title: 'goa' })).error, 'laptop_offline');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
