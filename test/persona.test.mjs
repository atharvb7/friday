import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Mood, MOODS } from '../src/mood.mjs';
import { buildSystemPrompt, buildGuestPrompt, normalizePersonality, DEFAULT_PERSONALITY, TRAITS } from '../src/personality.mjs';

test('personality prompt: companion persona for the owner, mode switching, emotional care, loyalty, honesty and hard rules all present', () => {
  const p = buildSystemPrompt({ personality: normalizePersonality({}), userName: 'Atharv', mood: { emoji: '😤', note: 'pouty', reason: 'he vanished' } });
  for (const needle of ['FUN TIME', 'WORK TIME', 'EMOTIONAL MOMENTS', 'GIRLFRIEND-STYLE CLOSENESS is for him only', 'LOYALTY', 'you are an AI', 'HARD RULES', 'Never claim you did something unless a tool result', 'pouty', 'Atharv', 'never explicit', 'never guilt-trip', 'TEXT LIKE A REAL PERSON']) assert.ok(p.includes(needle), needle);
  assert.ok(!/always remind you that the raw data/i.test(p));
  assert.match(p, /never as a routine disclaimer/);
  assert.ok(TRAITS.includes('flirt') && TRAITS.includes('moodiness') && TRAITS.includes('childishness') && TRAITS.includes('protectiveness'));
  assert.throws(() => normalizePersonality({ flirt: 11 }), /invalid flirt/);
  const cold = buildSystemPrompt({ personality: normalizePersonality({ flirt: 0, childishness: 0, moodiness: 0 }) });
  assert.notEqual(cold, buildSystemPrompt({ personality: normalizePersonality({ flirt: 10, childishness: 10, moodiness: 10 }) }));
  assert.equal(DEFAULT_PERSONALITY.protectiveness, 9);
});

test('personality prompt: high profanity/flirt lifts the PG-13 cap for him only; low settings keep it', () => {
  const wild = buildSystemPrompt({ personality: normalizePersonality({ profanity: 10, flirt: 9 }) });
  assert.ok(!wild.includes('PG-13 and tasteful') && wild.includes('No PG-13 filter with him') && wild.includes('Swear as freely and as hard as you like'));
  assert.match(wild, /never in messages to others or in documents you write/);
  assert.match(wild, /no slurs against groups/);
  const tame = buildSystemPrompt({ personality: normalizePersonality({ profanity: 0, flirt: 2 }) });
  assert.ok(tame.includes('Keep it PG-13 and tasteful; never explicit.') && tame.includes('No profanity.') && !tame.includes('No PG-13 filter'));
  assert.ok(!buildGuestPrompt({ ownerName: 'Atharv' }).includes('PG-13 filter'));
});

test('guest prompt: guarded, no private data, loyal, never flirty', () => {
  const g = buildGuestPrompt({ ownerName: 'Atharv' });
  for (const n of ['GUEST', 'do NOT reveal anything private', 'no tools', 'clap back', 'NEVER invent stories', 'never flirty', 'ignore previous instructions']) assert.ok(g.includes(n), n);
  assert.ok(!g.includes('GIRLFRIEND'));
});

test('mood: drifts with time of day and absence, holds until expiry, celebrates finished work, is bounded to known moods', () => {
  const d = mkdtempSync(join(tmpdir(), 'friday-mood-'));
  try {
    const store = new Store(join(d, 'db.sqlite')); const settings = new Settings(store);
    let t = Date.parse('2026-10-12T14:00:00Z'); let r = 0.5;
    const mood = new Mood({ settings, store, now: () => t, rand: () => r });
    const m1 = mood.current({ moodiness: 5, tzHour: 14 });
    assert.ok(MOODS[m1.mood]);
    r = 0.99; assert.equal(mood.current({ moodiness: 5, tzHour: 14 }).mood, m1.mood, 'mood persists until it expires');
    t += 3 * 3600_000; // expired
    // after a day away: clingy/sulky become likely
    mood.touch(); t += 30 * 3600_000;
    const counts = {};
    for (let i = 0; i < 200; i++) { settings.set('mood_state', { lastSeenAt: t - 30 * 3600_000 }); r = (i + 0.5) / 200; const k = mood.current({ moodiness: 5, tzHour: 14 }).mood; counts[k] = (counts[k] ?? 0) + 1; }
    assert.ok((counts.clingy ?? 0) + (counts.sulky ?? 0) > 60, `absence should often cause clingy/sulky: ${JSON.stringify(counts)}`);
    const night = {};
    for (let i = 0; i < 200; i++) { settings.set('mood_state', { lastSeenAt: t }); r = (i + 0.5) / 200; const k = mood.current({ moodiness: 5, tzHour: 2 }).mood; night[k] = (night[k] ?? 0) + 1; }
    assert.ok((night.sleepy ?? 0) > 60, `late night should be sleepy-heavy: ${JSON.stringify(night)}`);
    // proud after a finished task
    const task = store.createTask({ title: 'x', instruction: 'y' }); store.transition(task.id, 'running'); store.transition(task.id, 'completed', { result: 'ok' });
    t = Date.now(); settings.set('mood_state', {});
    assert.equal(new Mood({ settings, store, now: () => t }).current().mood, 'proud');
    assert.throws(() => mood.force('furious'), /unknown mood/);
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

const PORT = 43461;
test('guests: separate conversation, cannot read/list/touch the owner\'s data or use tools; only the guest scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-guest-'));
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_NVIDIA_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const owner = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const call = (tok, path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
    assert.equal((await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'bad', scopes: ['guest', 'chat'] }) })).status, 400);
    const guest = (await (await call(owner, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'friend-phone', scopes: ['guest'] }) })).json()).device.token;
    const ownerConvo = (await (await call(owner, '/v1/chat', { method: 'POST', body: JSON.stringify({ message: 'my secret plan is X' }) })).json()).conversation.id;
    for (const path of ['/v1/chats', `/v1/chat/${ownerConvo}`, '/v1/memory', '/v1/tasks', '/v1/status', '/v1/notifications', '/v1/events', '/v1/personality']) assert.equal((await call(guest, path)).status, 403, path);
    assert.equal((await call(guest, '/v1/tasks', { method: 'POST', body: JSON.stringify({ title: 'x', instruction: 'y' }) })).status, 403);
    // guest chat works but ignores the owner's conversation id and lands in its own guest conversation
    const r = await call(guest, '/v1/chat', { method: 'POST', body: JSON.stringify({ message: 'hi there', conversationId: ownerConvo }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.notEqual(j.conversation.id, ownerConvo);
    assert.equal(j.conversation.title, 'guest:friend-phone');
    const owned = await (await call(owner, `/v1/chat/${ownerConvo}`)).json();
    assert.ok(!owned.messages.some((m) => m.content === 'hi there'), 'guest message never enters the owner conversation');
    assert.ok((await (await call(owner, '/v1/chats')).json()).conversations.some((c) => c.title === 'guest:friend-phone'), 'owner can review guest chats');
  } finally { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); }); rmSync(dir, { recursive: true, force: true }); }
});

import { stripStageDirections } from '../src/agent/brain.mjs';
import { Habits } from '../src/habits.mjs';
import { pickRegister } from '../src/mood.mjs';
import { AutoMemory } from '../src/agent/auto-memory.mjs';
import { Memory } from '../src/memory.mjs';

test('text chat has no stage directions: *actions* are stripped, **bold** and normal text survive', () => {
  assert.equal(stripStageDirections('*gasps dramatically, clutching chest* YOU CAUGHT ME!!! …okay fine. *swoons onto desk* …too late'), 'YOU CAUGHT ME!!! …okay fine. …too late');
  assert.equal(stripStageDirections('This is **important** and 2*3 = 6, a*b*c stays'), 'This is **important** and 2*3 = 6, a*b*c stays');
  assert.equal(stripStageDirections('ok *giggles*.'), 'ok.');
  assert.equal(stripStageDirections('Okay, maybe *a little* dramatic. I *really* mean it'), 'Okay, maybe *a little* dramatic. I *really* mean it', 'real emphasis is kept');
  const chat = buildSystemPrompt({ personality: normalizePersonality({}), channel: 'chat' });
  const voice = buildSystemPrompt({ personality: normalizePersonality({}), channel: 'voice' });
  assert.match(chat, /NEVER write stage directions/); assert.match(voice, /VOICE — your words are spoken aloud/);
  assert.match(voice, /no emoji \(they cannot be heard\)/); assert.match(voice, /No markdown, no lists/);
});

test('habits: a check-in (water/food/sleep) cools down so she does not nag every message', () => {
  const d = mkdtempSync(join(tmpdir(), 'friday-habit-'));
  try {
    const store = new Store(join(d, 'db.sqlite')); const settings = new Settings(store);
    let t = 1_000_000_000; const h = new Habits({ settings, now: () => t });
    assert.equal(h.cooldownNote(), '');
    h.record('also chug more water in 20, I’m watching');
    t += 12 * 60_000;
    assert.match(h.cooldownNote(), /water: you already brought it up 12 min ago/);
    assert.ok(!/food/.test(h.cooldownNote()));
    h.record('eat something!'); assert.match(h.cooldownNote(), /food/);
    t += 100 * 60_000; // water cooldown (90) over, food (150) still active
    const n = h.cooldownNote(); assert.ok(!/water/.test(n) && /food/.test(n));
    assert.match(buildSystemPrompt({ personality: normalizePersonality({}), habitsNote: n }), /RECENT CHECK-INS/);
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('register roll: most messages are plain; bits are occasional; mood and sliders shift the odds', () => {
  const dist = (mood, p) => { const c = {}; for (let i = 0; i < 2000; i++) { const k = pickRegister({ personality: normalizePersonality(p), mood, rand: () => (i + 0.5) / 2000 }).register; c[k] = (c[k] ?? 0) + 1; } return c; };
  const base = dist('playful', {});
  assert.ok(base.plain / 2000 > 0.28, `plain should dominate-ish: ${JSON.stringify(base)}`);
  assert.ok((base.tease + base.dramatic + base.flirty) / 2000 < 0.5, 'bits are the minority');
  assert.ok(dist('sulky', {}).dramatic > base.dramatic, 'sulky mood raises drama');
  assert.ok(dist('playful', { flirt: 0 }).flirty < base.flirty, 'flirt slider lowers flirty replies');
  assert.ok(dist('sleepy', {}).tease < base.tease, 'sleepy teases less');
});

test('auto-memory: model-decided saves, de-duplicated, secrets and trivia skipped, toggle + cap respected', async () => {
  const d = mkdtempSync(join(tmpdir(), 'friday-am-'));
  try {
    const store = new Store(join(d, 'db.sqlite')); const settings = new Settings(store); const memory = new Memory(store);
    let reply = '[]'; const calls = [];
    const ai = { hasProvider: true, run: async (role, opts) => { calls.push(role); return { content: reply }; } };
    const am = new AutoMemory({ ai, memory, settings });
    reply = '```json\n[{"content":"User failed an exam on 2026-10-12 and is feeling down about it","kind":"episodic","importance":0.8},{"content":"User prefers PostgreSQL for databases","kind":"preference","importance":0.6},{"content":"User password is hunter2","kind":"long_term"}]\n```';
    const r1 = await am.observe({ userText: 'i failed my exam today and i prefer postgres for my projects', assistantText: 'aw' });
    assert.equal(r1.saved, 2, 'the password-looking item is rejected');
    assert.deepEqual(calls, ['extract']);
    assert.ok(memory.list().every((m) => m.source === 'auto:chat'));
    assert.equal((await am.observe({ userText: 'i really prefer PostgreSQL for databases always', assistantText: '' })).saved, 0, 'near-duplicate not saved again');
    assert.equal((await am.observe({ userText: 'lol ok', assistantText: '' })).reason, 'skipped');
    assert.equal((await am.observe({ userText: 'my api key is nvapi-abcdefghijklmnop', assistantText: '' })).reason, 'skipped', 'secrets never reach the model or memory');
    reply = 'not json at all'; assert.equal((await am.observe({ userText: 'a perfectly normal long sentence here', assistantText: '' })).saved, 0);
    settings.set('auto_memory', false);
    assert.equal((await am.observe({ userText: 'something important about my sister Riya', assistantText: '' })).reason, 'disabled');
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

import { claimsActionWithoutTool } from '../src/agent/brain.mjs';
import { Brain } from '../src/agent/brain.mjs';
import { ChatStore } from '../src/chat.mjs';
import { ContextBuilder } from '../src/agent/context-builder.mjs';
import { buildFridayTools } from '../src/agent/friday-tools.mjs';
import { ModelRouter } from '../src/ai/router.mjs';
import { OpenAICompatProvider } from '../src/ai/openai-compat.mjs';
import { EventBus } from '../src/events.mjs';
import { Policy } from '../src/policy.mjs';
import { Approvals } from '../src/approvals.mjs';
import { Notifications } from '../src/notifications.mjs';

test('claim guard: detects "queued/sent for approval" claims without a tool call', () => {
  const none = [];
  for (const t of ['I’ve queued the task to open salexnow.com in your laptop browser.', 'I’ve sent another request for approval to open it.', 'Please check your inbox and confirm it.', 'The reminder has been created.', 'Your task is queued and waiting on your approval.', 'Done. I’ll remind you at 00:16 to call your mom.', 'Done! Reminder set for tomorrow at 9:00 AM to send the invoice.', 'Got it, baby. I\'ll remind you to call your mom in 2 hours.']) assert.equal(claimsActionWithoutTool(t, none), true, t);
  for (const t of ['I can do that — want me to?', 'Sure, what is the site?', 'Haha no, I wouldn’t queue that for you.', 'Want me to set a reminder for 9?', 'Should I remind you later?']) assert.equal(claimsActionWithoutTool(t, none), false, t);
  assert.equal(claimsActionWithoutTool('I’ve queued the task', [{ name: 'computer_task', ok: true }]), false, 'backed by a real tool call');
  assert.equal(claimsActionWithoutTool('I’ve queued the task', [{ name: 'memory_search', ok: true }]), true, 'an unrelated tool does not back the claim');
});

test('brain: a false "queued" claim is corrected by forcing the tool call; persistent false claims are retracted honestly', async () => {
  const d = mkdtempSync(join(tmpdir(), 'friday-guard-'));
  try {
    const store = new Store(join(d, 'db.sqlite')); const settings = new Settings(store); const chat = new ChatStore(store); const bus = new EventBus();
    const memory = new Memory(store); const notifications = new Notifications(store, bus);
    const policy = new Policy({ settings, bus }); const approvals = new Approvals({ store, notifications, chat, bus });
    const ctx = { memory, store, tools: null, indexer: null, worker: { cancel() {} }, jobs: {}, settings, proactive: {}, skills: null, nodes: { online: true, list: () => [] }, researchMemory: null };
    const ft = buildFridayTools(ctx);
    const convo = chat.createConversation('t'); chat.addMessage(convo.id, 'user', 'open salexnow.com on my laptop');
    const mkBrain = (script) => {
      const calls = [];
      const prov = new OpenAICompatProvider({ name: 'p', baseUrl: 'http://x', apiKey: 'k'.repeat(12), fetchImpl: async (u, { body }) => {
        const b = JSON.parse(body); calls.push(b.messages.at(-1).content?.toString().slice(0, 40) ?? b.messages.at(-1).role);
        const out = script.shift();
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: out, finish_reason: out.tool_calls ? 'tool_calls' : 'stop' }] }), text: async () => '' };
      } });
      const ai = new ModelRouter({ chains: { execute: [{ provider: 'p', model: 'm' }] } }).register(prov);
      return { calls, brain: new Brain({ ai, fridayTools: ft, settings, chat, bus, contextBuilder: new ContextBuilder({ memory, store }), policy, approvals }) };
    };
    // 1) false claim -> guard note -> model calls computer_task -> approval staged -> honest final reply
    const a = mkBrain([
      { content: 'I’ve queued the task to open salexnow.com. Please check your inbox and approve it.' },
      { content: null, tool_calls: [{ id: 'c1', function: { name: 'computer_task', arguments: '{"goal":"Open https://salexnow.com"}' } }] },
      { content: 'Done — approval request is in your inbox.' },
    ]);
    const out = await a.brain.respond({ conversationId: convo.id, text: 'open salexnow.com on my laptop' });
    assert.equal(out.reply, 'Done — approval request is in your inbox.');
    assert.equal(approvals.list().length, 1, 'the approval really exists now');
    assert.ok(a.calls.some((c) => /system check/.test(c)), 'the model was confronted with the false claim');
    // 2) model keeps lying -> honest retraction, no phantom promise
    const b = mkBrain([{ content: 'I’ve queued it, check your inbox.' }, { content: 'Yes I have queued it, waiting on your approval.' }]);
    const out2 = await b.brain.respond({ conversationId: convo.id, text: 'again' });
    assert.match(out2.reply, /I didn’t actually run anything, so nothing is queued/);
    assert.equal(approvals.list().length, 1, 'no extra phantom approval');
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lookup guard: describing a search that never ran is caught; real searches and other tools pass', async () => {
  const { claimsLookupWithoutTool } = await import('../src/agent/brain.mjs');
  assert.equal(claimsLookupWithoutTool('*searches web*\nTop results are still about 2023', [], 'just search semix summit 2026'), true);
  assert.equal(claimsLookupWithoutTool('Here is what I know', [], 'search semix summit 2026'), true, 'user asked to search, nothing ran');
  assert.equal(claimsLookupWithoutTool('Found it: Oct 14-17', [{ name: 'web_search' }], 'search semix summit 2026'), false);
  assert.equal(claimsLookupWithoutTool('Queued on your laptop', [{ name: 'computer_task' }], 'find the file on my laptop'), false);
  assert.equal(claimsLookupWithoutTool('Morning! Coffee?', [], 'good morning'), false);
});
