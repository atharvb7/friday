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
