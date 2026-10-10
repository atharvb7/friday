import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NemotronProvider } from '../src/nemotron.mjs';
import { Store } from '../src/store.mjs';
import { ChatStore } from '../src/chat.mjs';
import { Memory } from '../src/memory.mjs';
import { answerLocal } from '../src/chat-reply.mjs';

test('nemotron: unconfigured fails closed, never leaks key', async () => {
  const p = new NemotronProvider({ apiKey: null });
  assert.equal(p.status().reason, 'nemotron_not_configured');
  assert.equal((await p.run({ instruction: 'hi' })).error, 'nemotron_not_configured');
});

test('nemotron: mocked success, http error redacts key', async () => {
  const ok = new NemotronProvider({
    apiKey: 'nvapi-secret-xyz',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Hello!' } }] }) }),
  });
  assert.equal(ok.status().ready, true);
  const out = await ok.run({ instruction: 'hi' });
  assert.equal(out.status, 'completed');
  assert.equal(out.output, 'Hello!');

  const bad = new NemotronProvider({
    apiKey: 'nvapi-secret-xyz',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad nvapi-secret-xyz key' }),
  });
  const err = await bad.run({ instruction: 'hi' });
  assert.match(err.error, /nemotron_http_401/);
  assert.doesNotMatch(err.error, /nvapi-secret-xyz/);
});

test('nemotron: falls over to next model on 503, reports answering model', async () => {
  const calls = [];
  const p = new NemotronProvider({
    apiKey: 'nvapi-secret-xyz',
    models: ['m-ultra', 'm-super'],
    fetchImpl: async (url, { body } = {}) => {
      const m = JSON.parse(body).model;
      calls.push(m);
      if (m === 'm-ultra') return { ok: false, status: 503, text: async () => 'overloaded' };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hi from super.' } }] }) };
    },
  });
  const out = await p.run({ instruction: 'hi' });
  assert.equal(out.status, 'completed');
  assert.equal(out.output, 'Hi from super.');
  assert.equal(out.model, 'm-super');
  assert.deepEqual(calls, ['m-ultra', 'm-super']);
});

test('chat store: conversations persist messages oldest-first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-chat-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const chat = new ChatStore(store);
    const c = chat.createConversation('hi there, friday');
    chat.addMessage(c.id, 'user', 'hello');
    chat.addMessage(c.id, 'assistant', 'hey!');
    const msgs = chat.listMessages(c.id);
    assert.equal(msgs.map((m) => m.role).join(','), 'user,assistant');
    assert.equal(chat.historyForProvider(c.id).length, 2);
    assert.throws(() => chat.addMessage(c.id, 'user', ''), /invalid message/);
    assert.throws(() => chat.addMessage('nope', 'user', 'x'), /conversation_not_found/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('answerLocal: remember/recall/files/chitchat/guardrails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-reply-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const memory = new Memory(store);
    const saved = await answerLocal({ intent: 'memory', needsApproval: false }, 'remember my dog is Bruno', { memory });
    assert.equal(saved.acted, true);
    const recalled = await answerLocal({ intent: 'memory', needsApproval: false }, 'what do you remember about my dog?', { memory });
    assert.match(recalled.text, /Bruno/);
    const chit = await answerLocal({ intent: 'chitchat' }, 'hello', {});
    assert.match(chit.text, /Hey|Friday/);
    const who = await answerLocal({ intent: 'chitchat' }, 'who are you', {});
    assert.match(who.text, /Friday/);
    const guard = await answerLocal({ intent: 'browser', needsApproval: true, riskScore: 4 }, 'send it', {});
    assert.match(guard.text, /approval/);
    const unknown = await answerLocal({ intent: 'unknown' }, 'blarg', {});
    assert.match(unknown.text, /listening/);
    const yoo = await answerLocal({ intent: 'chitchat' }, 'yoo', {});
    assert.match(yoo.text, /Hey|hey/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
