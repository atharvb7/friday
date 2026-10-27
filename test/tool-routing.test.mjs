import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatProvider } from '../src/ai/openai-compat.mjs';
import { ModelRouter, AllModelsFailed, chainsFromEnv } from '../src/ai/router.mjs';
import { ToolRouter, CORE, GROUPS, schemasFor, toolsLoadTool, groupOf } from '../src/agent/toolsets.mjs';
import { Store } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { ContextBuilder } from '../src/agent/context-builder.mjs';
import { buildFridayTools } from '../src/agent/friday-tools.mjs';
import { Brain } from '../src/agent/brain.mjs';

const KEY = 'test-secret-key-123';
const jsonRes = (obj, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (h) => (h === 'content-type' ? 'application/json' : headers[h.toLowerCase()] ?? null) }, json: async () => obj, text: async () => JSON.stringify(obj) });
const sseRes = (lines) => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: (async function* () { for (const l of lines) yield Buffer.from(l); })() });
const mk = (fetchImpl, name = 'p', o = {}) => new OpenAICompatProvider({ name, baseUrl: 'http://x', apiKey: KEY, fetchImpl, ...o });
const ok = (content = 'ok') => jsonRes({ choices: [{ message: { content }, finish_reason: 'stop' }] });

test('tool routing: core always; words pick groups; previous message and recent use keep them; off switch sends all', () => {
  const r = new ToolRouter();
  assert.deepEqual([...r.select({ conversationId: 'c', text: 'remind me in 2 hours to call the CA' })], []);
  assert.ok(r.select({ conversationId: 'c', text: 'check my inbox for the invoice' }).has('email'));
  assert.ok(r.select({ conversationId: 'c', text: 'draw me a cute cat wallpaper' }).has('images'));
  assert.ok(r.select({ conversationId: 'c', text: 'book a table on zomato' }).has('laptop'));
  assert.ok(r.select({ conversationId: 'c', text: 'ok do it', previousText: 'find me 5 leads for freight companies' }).has('business'));
  assert.ok(r.select({ conversationId: 'c', text: 'here [attached files: a.pdf (file id 1234abcd)]' }).has('documents'));
  r.remember('c', ['outreach_send']);
  assert.ok(r.select({ conversationId: 'c', text: 'yes' }).has('business'), 'sticky for the next turns');
  r.select({ conversationId: 'c', text: 'x' }); r.select({ conversationId: 'c', text: 'x' }); r.select({ conversationId: 'c', text: 'x' });
  assert.ok(!r.select({ conversationId: 'c', text: 'hello' }).has('business'), 'and then it drops');
  assert.equal(new ToolRouter({ enabled: false }).select({ text: 'hi' }).size, Object.keys(GROUPS).length);
  assert.equal(groupOf('computer_task'), 'laptop'); assert.equal(groupOf('memory_save'), 'core');
});

test('tool routing: every Friday tool belongs to core or a group; unknown tools are never hidden', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-tr-'));
  return import('../src/context.mjs').then(({ createContext }) => {
    const ctx = createContext({ appRoot: new URL('..', import.meta.url).pathname, env: { FRIDAY_DATA_DIR: dir } });
    try {
      const names = ctx.fridayTools.list().map((t) => t.name);
      const known = new Set([...CORE, ...Object.values(GROUPS).flatMap((g) => g.tools)]);
      assert.deepEqual(names.filter((n) => !known.has(n)), [], 'unassigned tools');
      assert.deepEqual([...known].filter((n) => !names.includes(n)), [], 'grouped tools that do not exist');
      const all = ctx.fridayTools.schemas();
      const core = schemasFor(all, new Set());
      assert.ok(JSON.stringify(core).length < JSON.stringify(all).length / 3, 'core is a fraction of all tools');
      const extra = schemasFor([...all, { type: 'function', function: { name: 'plugin_x', parameters: {} } }], new Set());
      assert.ok(extra.some((s) => s.function.name === 'plugin_x'));
    } finally { ctx.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

test('brain: sends only routed tools, tools_load adds a group for the next step, guard retry loads everything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-brain-tr-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const memory = new Memory(store);
    const chat = new ChatStore(store);
    const convo = chat.createConversation('t');
    chat.addMessage(convo.id, 'user', 'hey can you handle that thing for me');
    const seen = [];
    const script = [
      { choices: [{ message: { content: null, tool_calls: [{ id: 'a', function: { name: 'tools_load', arguments: '{"groups":["images"]}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: 'Done, loaded.' }, finish_reason: 'stop' }] },
    ];
    const prov = mk(async (u, { body }) => { seen.push(JSON.parse(body).tools.map((t) => t.function.name)); return jsonRes(script.shift()); }, 'nv');
    const ai = new ModelRouter({ chains: { execute: [{ provider: 'nv', model: 'm' }] } }).register(prov);
    const tools = buildFridayTools({ memory, store, tools: null, indexer: null, worker: { cancel() {} } });
    tools.register(toolsLoadTool());
    tools.register({ name: 'image_create', risk: 'safe', description: 'draw', parameters: { type: 'object', properties: {} }, run: () => ({ ok: true }) });
    const brain = new Brain({ ai, fridayTools: tools, settings: new Settings(store), chat, bus: new EventBus(), contextBuilder: new ContextBuilder({ memory, store }) });
    const out = await brain.respond({ conversationId: convo.id, text: 'hey can you handle that thing for me' });
    assert.equal(out.reply, 'Done, loaded.');
    assert.ok(seen[0].includes('tools_load') && !seen[0].includes('image_create'), 'first step: core only');
    assert.ok(seen[1].includes('image_create'), 'after tools_load the group is sent');
    // the model asked for images: the next short turn keeps them
    seen.length = 0;
    script.push({ choices: [{ message: { content: 'sure' }, finish_reason: 'stop' }] });
    chat.addMessage(convo.id, 'user', 'yes');
    await brain.respond({ conversationId: convo.id, text: 'yes' });
    assert.ok(seen[0].includes('image_create'));
    // claim guard: "I've set a reminder" with no tool -> retry with every group loaded
    seen.length = 0;
    script.push({ choices: [{ message: { content: "I've set a reminder for you!" }, finish_reason: 'stop' }] }, { choices: [{ message: { content: 'Actually, not yet.' }, finish_reason: 'stop' }] });
    chat.addMessage(convo.id, 'user', 'nice');
    await brain.respond({ conversationId: convo.id, text: 'nice' });
    assert.ok(seen[1].length > seen[0].length || seen[1].includes('image_create'));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gemini: thought signatures round-trip (streamed and JSON), foreign tool calls get the placeholder, others strip them', async () => {
  const bodies = [];
  const frames = ['data: {"choices":[{"delta":{"tool_calls":[{"extra_content":{"google":{"thought_signature":"SIG1"}},"id":"c1","function":{"name":"time_now","arguments":"{}"}},{"extra_content":{"google":{"thought_signature":"SIG2"}},"id":"c2","function":{"name":"memory_search","arguments":"{\\"query\\":\\"x\\"}"}}]},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
  const g = mk(async (u, { body }) => { bodies.push(JSON.parse(body)); return sseRes(frames); }, 'gemini', { thoughtSignatures: true });
  const out = await g.complete({ model: 'm', messages: [], stream: true });
  assert.deepEqual(out.toolCalls.map((c) => [c.name, c.extra.google.thought_signature]), [['time_now', 'SIG1'], ['memory_search', 'SIG2']], 'two whole calls without index stay separate');
  const history = [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'time_now', arguments: '{}' }, extra_content: out.toolCalls[0].extra }, { id: 'n1', type: 'function', function: { name: 'x', arguments: '{}' } }] }];
  await g.complete({ model: 'm', messages: history, stream: true });
  assert.equal(bodies[1].messages[0].tool_calls[0].extra_content.google.thought_signature, 'SIG1');
  assert.equal(bodies[1].messages[0].tool_calls[1].extra_content.google.thought_signature, 'skip_thought_signature_validator');
  const nvBodies = [];
  const nv = mk(async (u, { body }) => { nvBodies.push(JSON.parse(body)); return ok(); }, 'nvidia');
  await nv.complete({ model: 'm', messages: history });
  assert.ok(nvBodies[0].messages[0].tool_calls.every((c) => !('extra_content' in c)));
});

test('provider: rate-limit hints become retryAfterMs; daily quota is an hour; a stalled stream is a retryable timeout', async () => {
  const gemini429 = [{ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 5. Please retry in 29.38s.', details: [{ retryDelay: '29s' }] } }];
  await assert.rejects(() => mk(async () => jsonRes(gemini429, 429)).complete({ model: 'm', messages: [] }), (e) => e.kind === 'rate' && e.retryAfterMs >= 29_000 && e.retryAfterMs < 30_000);
  await assert.rejects(() => mk(async () => jsonRes({}, 429, { 'retry-after': '7' })).complete({ model: 'm', messages: [] }), (e) => e.retryAfterMs === 7000);
  await assert.rejects(() => mk(async () => jsonRes({ error: { message: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }, 429)).complete({ model: 'm', messages: [] }), (e) => e.kind === 'quota' && e.retryAfterMs === 3_600_000);
  const hang = mk((u, { signal }) => new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); }), 'g', { stallMs: 30 });
  await assert.rejects(() => hang.complete({ model: 'm', messages: [], stream: true }), (e) => e.kind === 'timeout' && e.retryable && /stalled/.test(e.message));
});

test('router: rate limit skips the model for the hinted time; 400 skips only that provider; cooling models are a last resort', async () => {
  let t = 1_000_000;
  const calls = [];
  let gState = 'rate';
  const g = mk(async (u, { body }) => { calls.push(`g:${JSON.parse(body).model}`); return gState === 'rate' ? jsonRes({ error: { message: 'retry in 20s' } }, 429) : gState === 'bad' ? jsonRes({ error: { message: 'schema' } }, 400) : ok('from gemini'); }, 'gemini');
  let nvDown = false;
  const nv = mk(async (u, { body }) => { calls.push(`nv:${JSON.parse(body).model}`); return nvDown ? jsonRes({}, 503) : ok('from nvidia'); }, 'nvidia');
  const ai = new ModelRouter({ now: () => t, chains: { execute: [{ provider: 'gemini', model: 'g1' }, { provider: 'gemini', model: 'g2' }, { provider: 'nvidia', model: 'n1' }] } }).register(g).register(nv);
  gState = 'rate';
  assert.equal((await ai.execute([])).content, 'from nvidia');
  assert.deepEqual(calls, ['g:g1', 'g:g2', 'nv:n1']);
  calls.length = 0; t += 10_000;
  await ai.execute([]);
  assert.deepEqual(calls, ['nv:n1'], 'one 429 is enough: both Gemini models skipped while cooling');
  calls.length = 0; t += 15_000; gState = 'ok';
  assert.equal((await ai.execute([])).content, 'from gemini', 'back after the hinted 20s');
  // 400 from one provider: its other models are not tried, the next provider answers
  calls.length = 0; gState = 'bad';
  assert.equal((await ai.execute([])).content, 'from nvidia');
  assert.deepEqual(calls, ['g:g1', 'nv:n1']);
  // everything cooling down after overload: still try rather than fail without a request
  calls.length = 0; gState = 'rate'; nvDown = true;
  await assert.rejects(() => ai.execute([]), AllModelsFailed);
  calls.length = 0; nvDown = false; t += 1000;
  assert.equal((await ai.execute([])).content, 'from nvidia', 'soft-open nvidia retried as last resort');
});

test('chains: Gemini (20 free requests/day) leads only reason/plan by default; roles are configurable; heavy loops stay on Nemotron', () => {
  const c = chainsFromEnv({});
  assert.equal(c.reason[0].model, 'gemini-3.8-flash');
  assert.equal(c.plan[0].provider, 'gemini');
  assert.equal(c.execute[0].provider, 'nvidia');
  assert.deepEqual(c.execute.filter((e) => e.provider === 'gemini').map((e) => e.model), ['gemini-3.5-flash-lite'], 'Flash-Lite only as the outage backup, last');
  assert.equal(c.execute.at(-1).model, 'gemini-3.5-flash-lite');
  assert.ok(chainsFromEnv({ FRIDAY_GEMINI_BACKUP_MODEL: '' }).execute.every((e) => e.provider === 'nvidia'));
  assert.ok(c.computer.every((e) => e.provider === 'nvidia') && c.extract.every((e) => e.provider === 'nvidia'));
  const wide = chainsFromEnv({ FRIDAY_GEMINI_ROLES: 'chat,execute' });
  assert.equal(wide.execute[0].provider, 'gemini');
  assert.ok(!wide.reason.some((e) => e.model === 'gemini-3.8-flash'));
});

test('provider: alwaysStream streams on the wire for a plain call (stall-guarded) without leaking deltas', async () => {
  const bodies = [];
  const p = mk(async (u, { body }) => { bodies.push(JSON.parse(body)); return sseRes(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']); }, 'gemini', { alwaysStream: true, stallMs: 1000 });
  const out = await p.complete({ model: 'm', messages: [] });
  assert.equal(out.content, 'hi');
  assert.equal(bodies[0].stream, true);
});
