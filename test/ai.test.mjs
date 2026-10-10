import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatProvider, ProviderError } from '../src/ai/openai-compat.mjs';
import { ModelRouter, AllModelsFailed } from '../src/ai/router.mjs';
import { Store } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { ContextBuilder } from '../src/agent/context-builder.mjs';
import { buildFridayTools } from '../src/agent/friday-tools.mjs';
import { Brain } from '../src/agent/brain.mjs';
import { normalizePersonality, buildSystemPrompt, DEFAULT_PERSONALITY } from '../src/personality.mjs';

const KEY = 'nvapi-test-secret-key';
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
const sseRes = (lines) => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: (async function* () { for (const l of lines) yield Buffer.from(l); })() });
const mk = (fetchImpl, name = 'p') => new OpenAICompatProvider({ name, baseUrl: 'http://x', apiKey: KEY, fetchImpl });

test('provider: parses streamed content, reasoning and tool-call deltas', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"memory_save","arguments":"{\\"content\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ];
  const p = mk(async () => sseRes(frames));
  const deltas = []; const thoughts = [];
  const out = await p.complete({ model: 'm', messages: [], stream: true, onDelta: (d) => deltas.push(d), onThinking: (t) => thoughts.push(t) });
  assert.equal(out.content, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.deepEqual(thoughts, ['hmm']);
  assert.equal(out.reasoning, 'hmm');
  assert.deepEqual(out.toolCalls[0].args, { content: 'x' });
  assert.equal(out.usage.prompt_tokens, 5);
});

test('provider: reasoning-only truncation is an error (never leaks chain of thought as the answer)', async () => {
  const p = mk(async () => jsonRes({ choices: [{ message: { content: null, reasoning_content: 'thinking...' }, finish_reason: 'length' }] }));
  await assert.rejects(() => p.complete({ model: 'm', messages: [] }), (e) => e instanceof ProviderError && e.kind === 'empty' && e.retryable);
});

test('provider: http errors are classified and the key is redacted', async () => {
  const p = mk(async () => jsonRes({ detail: `bad ${KEY}` }, 401));
  await assert.rejects(() => p.complete({ model: 'm', messages: [] }), (e) => e.kind === 'auth' && !e.message.includes(KEY));
});

test('router: falls through chain, breaker opens, records stats, publishes events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-ai-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const bus = new EventBus();
    const events = [];
    bus.subscribe((e) => events.push(e.type));
    const calls = [];
    const prov = mk(async (url, { body }) => {
      const m = JSON.parse(body).model;
      calls.push(m);
      if (m === 'big') return jsonRes({}, 503);
      return jsonRes({ choices: [{ message: { content: `hi from ${m}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    }, 'nv');
    let t = 1_000_000;
    const ai = new ModelRouter({ db: store.db, bus, now: () => t, chains: { chat: [{ provider: 'nv', model: 'big' }, { provider: 'nv', model: 'small' }] } }).register(prov);
    for (let i = 0; i < 3; i++) assert.equal((await ai.chat([{ role: 'user', content: 'x' }])).content, 'hi from small');
    assert.equal(ai.status().chains.chat[0].circuitOpen, true);
    calls.length = 0;
    await ai.chat([]);
    assert.deepEqual(calls, ['small'], 'open breaker is skipped');
    t += 61_000; // cooldown over
    calls.length = 0;
    await ai.chat([]);
    assert.deepEqual(calls, ['big', 'small']);
    const stat = ai.stats().find((s) => s.model === 'small');
    assert.ok(stat.calls >= 4 && stat.prompt_tokens > 0);
    assert.ok(events.includes('model.failed') && events.includes('model.changed'));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('router: all-failed raises AllModelsFailed; abort never falls through; unconfigured chain fails closed', async () => {
  const prov = mk(async () => jsonRes({}, 500));
  const ai = new ModelRouter({ chains: { chat: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] } }).register(prov);
  await assert.rejects(() => ai.chat([]), AllModelsFailed);
  const ctrl = new AbortController(); ctrl.abort(new Error('stop'));
  const seen = [];
  const p2 = mk(async (u, { signal }) => { seen.push(1); if (signal.aborted) throw signal.reason; return jsonRes({}); }, 'q');
  const ai2 = new ModelRouter({ chains: { chat: [{ provider: 'q', model: 'a' }, { provider: 'q', model: 'b' }] } }).register(p2);
  await assert.rejects(() => ai2.chat([], { signal: ctrl.signal }), /stop/);
  assert.equal(seen.length, 1);
  const none = new ModelRouter({ chains: { chat: [{ provider: 'ghost', model: 'a' }] } });
  assert.equal(none.hasProvider, false);
  await assert.rejects(() => none.chat([]), /no_provider_configured/);
});

test('memory: hybrid retrieval, edit invalidates embedding, pin, sensitive excluded from auto-context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-mem-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const mem = new Memory(store);
    const a = mem.create({ content: 'User prefers PostgreSQL for databases' });
    const b = mem.create({ content: 'User bank PIN hint is in the safe', sensitivity: 'sensitive' });
    const c = mem.create({ content: 'Dog is named Bruno' });
    mem.setEmbedding(a.id, Float32Array.from([1, 0, 0]), 'm');
    mem.setEmbedding(c.id, Float32Array.from([0, 1, 0]), 'm');
    // vector-only match (no shared words with the query)
    assert.equal(mem.searchHybrid('zzz', { queryVector: Float32Array.from([0.9, 0.1, 0]) })[0].id, a.id);
    assert.ok(!mem.searchHybrid('bank PIN', { includeSensitive: false }).some((r) => r.id === b.id));
    assert.equal(mem.get(a.id).embedded, true);
    mem.update(a.id, { content: 'User prefers MySQL' });
    assert.equal(mem.get(a.id).embedded, false, 'edited content must be re-embedded');
    assert.equal(mem.pin(c.id).pinned, 1);
    assert.equal(mem.pinned()[0].id, c.id);
    assert.throws(() => mem.update(a.id, { importance: 5 }), /invalid importance/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('brain: tool loop saves memory, result flows back, secrets/unknown tools are contained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-brain-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const memory = new Memory(store);
    const chat = new ChatStore(store);
    const bus = new EventBus();
    const convo = chat.createConversation('t');
    chat.addMessage(convo.id, 'user', 'remember I like tea');
    const script = [
      { choices: [{ message: { content: null, tool_calls: [
        { id: 'c1', function: { name: 'memory_save', arguments: '{"content":"User likes tea"}' } },
        { id: 'c2', function: { name: 'nope_tool', arguments: '{}' } },
        { id: 'c3', function: { name: 'memory_save', arguments: '{bad json' } },
      ] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: 'Noted: tea.' }, finish_reason: 'stop' }] },
    ];
    const seenToolMsgs = [];
    const prov = mk(async (u, { body }) => {
      const b = JSON.parse(body);
      if (script.length === 2) assert.ok(b.tools.some((t) => t.function.name === 'task_create') && b.messages[0].role === 'system');
      else seenToolMsgs.push(...b.messages.filter((m) => m.role === 'tool').map((m) => m.content));
      return jsonRes(script.shift());
    }, 'nv');
    const ai = new ModelRouter({ chains: { execute: [{ provider: 'nv', model: 'm' }] } }).register(prov);
    const ctx = { memory, store, tools: null, indexer: null, worker: { cancel() {} } };
    const brain = new Brain({ ai, fridayTools: buildFridayTools(ctx), settings: new Settings(store), chat, bus, contextBuilder: new ContextBuilder({ memory, store }) });
    const out = await brain.respond({ conversationId: convo.id, text: 'remember I like tea' });
    assert.equal(out.reply, 'Noted: tea.');
    assert.equal(memory.search('tea').length, 1);
    assert.deepEqual(out.toolsUsed.map((t) => `${t.name}:${t.ok}`), ['memory_save:true', 'nope_tool:false', 'memory_save:false']);
    assert.ok(seenToolMsgs.some((m) => m.includes('unknown_tool')) && seenToolMsgs.some((m) => m.includes('invalid_json_arguments')));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('personality: bounded sliders change style only; hard rules always present', () => {
  assert.throws(() => normalizePersonality({ humor: 11 }), /invalid humor/);
  const quiet = buildSystemPrompt({ personality: normalizePersonality({ sarcasm: 0, profanity: 0 }) });
  const wild = buildSystemPrompt({ personality: normalizePersonality({ sarcasm: 10, profanity: 10 }) });
  assert.notEqual(quiet, wild);
  for (const p of [quiet, wild]) assert.match(p, /Never claim you did something unless a tool result/);
  assert.equal(DEFAULT_PERSONALITY.sarcasm, 7);
});
