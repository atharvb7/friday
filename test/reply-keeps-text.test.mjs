import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatProvider } from '../src/ai/openai-compat.mjs';
import { ModelRouter } from '../src/ai/router.mjs';
import { Store } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { ContextBuilder } from '../src/agent/context-builder.mjs';
import { buildFridayTools } from '../src/agent/friday-tools.mjs';
import { Brain } from '../src/agent/brain.mjs';

const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) }, json: async () => obj, text: async () => JSON.stringify(obj) });
const FILE = '0123abcd-0000-4000-8000-000000000000';

function setup(script) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-reply-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const memory = new Memory(store);
  const chat = new ChatStore(store);
  const convo = chat.createConversation('t');
  const prov = new OpenAICompatProvider({ name: 'nv', baseUrl: 'http://x', apiKey: 'test-secret-key-123', fetchImpl: async () => { const n = script.shift(); return n === 503 ? jsonRes({ error: { message: 'down' } }, 503) : jsonRes(n); } });
  const ai = new ModelRouter({ chains: { execute: [{ provider: 'nv', model: 'm' }], chat: [{ provider: 'nv', model: 'm' }] } }).register(prov);
  const tools = buildFridayTools({ memory, store, tools: null, indexer: null, worker: { cancel() {} } });
  tools.get('image_create').run = () => ({ images: [{ file: FILE.slice(0, 8) }], _attach: [FILE] }); // stands in for a real render
  const brain = new Brain({ ai, fridayTools: tools, settings: new Settings(store), chat, bus: new EventBus(), contextBuilder: new ContextBuilder({ memory, store }) });
  return { brain, chat, convo, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const call = (content) => ({ choices: [{ message: { content, tool_calls: [{ id: 'a', function: { name: 'image_create', arguments: '{"prompt":"a cat"}' } }] }, finish_reason: 'tool_calls' }] });
const say = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });

test('reply keeps what she wrote before an image tool call (it is streamed, so it must be saved too)', async () => {
  const { brain, chat, convo, done } = setup([call('Ooh, drawing your cat now ✨'), say('')]);
  try {
    chat.addMessage(convo.id, 'user', 'draw me a cat');
    const out = await brain.respond({ conversationId: convo.id, text: 'draw me a cat' });
    assert.equal(out.reply, 'Ooh, drawing your cat now ✨');
    assert.deepEqual(out.attachments, [FILE]);
  } finally { done(); }
});

test('reply joins text from before and after the tool call, without repeating it', async () => {
  const { brain, chat, convo, done } = setup([call('On it!'), say('Here it is, tell me if you want changes.')]);
  try {
    chat.addMessage(convo.id, 'user', 'draw me a cat');
    const out = await brain.respond({ conversationId: convo.id, text: 'draw me a cat' });
    assert.equal(out.reply, 'On it!\n\nHere it is, tell me if you want changes.');
  } finally { done(); }
  const again = setup([call('Here you go!'), say('Here you go!')]);
  try {
    again.chat.addMessage(again.convo.id, 'user', 'draw');
    assert.equal((await again.brain.respond({ conversationId: again.convo.id, text: 'draw' })).reply, 'Here you go!');
  } finally { again.done(); }
});

test('a claim the guard rejected is not kept in the reply', async () => {
  const { brain, chat, convo, done } = setup([say("I've drawn it for you!"), call(''), say('Done, it should be in the chat.')]);
  try {
    chat.addMessage(convo.id, 'user', 'draw me a cat');
    const out = await brain.respond({ conversationId: convo.id, text: 'draw me a cat' });
    assert.equal(out.reply, 'Done, it should be in the chat.');
  } finally { done(); }
});

test('the brain going down after the picture was made keeps her words and the picture', async () => {
  const { brain, chat, convo, done } = setup([call('Drawing it now!'), 503]);
  try {
    chat.addMessage(convo.id, 'user', 'draw me a cat');
    const out = await brain.respond({ conversationId: convo.id, text: 'draw me a cat' });
    assert.equal(out.reply, 'Drawing it now!');
    assert.deepEqual(out.attachments, [FILE]);
  } finally { done(); }
  const none = setup([503]);
  try {
    none.chat.addMessage(none.convo.id, 'user', 'hi');
    await assert.rejects(() => none.brain.respond({ conversationId: none.convo.id, text: 'hi' }), /all_models_failed/);
  } finally { none.done(); }
});

test('step budget used up: the wrap-up runs even after text, and its failure keeps her words and the pictures', async () => {
  const steps = Array.from({ length: 10 }, (_, i) => call(`Drawing number ${i + 1}`));
  const { brain, chat, convo, done } = setup([...steps, say('All ten are done.')]);
  try {
    chat.addMessage(convo.id, 'user', 'draw ten cats');
    const out = await brain.respond({ conversationId: convo.id, text: 'draw ten cats' });
    assert.match(out.reply, /Drawing number 10\n\nAll ten are done\.$/);
  } finally { done(); }
  const broken = setup([...Array.from({ length: 10 }, () => call('Drawing')), 503, 503]);
  try {
    broken.chat.addMessage(broken.convo.id, 'user', 'draw ten cats');
    const out = await broken.brain.respond({ conversationId: broken.convo.id, text: 'draw ten cats' });
    assert.equal(out.reply, 'Drawing\n\nDrawing\n\nDrawing\n\nDrawing\n\nDrawing\n\nDrawing\n\nDrawing\n\nDrawing\n\nDrawing\n\nDrawing');
    assert.deepEqual(out.attachments, [FILE]);
  } finally { broken.done(); }
});
