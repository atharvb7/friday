import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VoicePipeline, chunkText, MAX_CLAUSE_CHARS } from '../src/voice.mjs';
import { PetStateMachine, STATES } from '../src/pet.mjs';
import { renderPet } from '../public/pet.js';

// --- voice: chunking ---

test('requestSpeak returns indexed clauses each <=200 chars', () => {
  const v = new VoicePipeline();
  v.configure({ vad: 'silero', stt: 'whisper', tts: 'piper' });
  const text = 'Hello there. This is a longer sentence that should be split into clauses that stay short enough for speech synthesis to handle nicely. And a final bit!';
  const out = v.requestSpeak(text);
  assert.ok(Array.isArray(out) && out.length >= 2);
  out.forEach((entry, i) => {
    assert.equal(entry.index, i);
    assert.ok(typeof entry.clause === 'string' && entry.clause.length > 0);
    assert.ok(entry.clause.length <= MAX_CLAUSE_CHARS, `clause too long: ${entry.clause.length}`);
  });
  assert.equal(v.getState(), 'speaking');
});

test('chunkText hard-splits very long single-token input', () => {
  const long = 'x'.repeat(450);
  const clauses = chunkText(long);
  assert.ok(clauses.length >= 3);
  for (const c of clauses) assert.ok(c.length <= 200);
  assert.equal(clauses.join(''), long);
});

test('requestSpeak rejects empty / non-string input', () => {
  const v = new VoicePipeline();
  assert.throws(() => v.requestSpeak('   '), TypeError);
  assert.throws(() => v.requestSpeak(42), TypeError);
  assert.throws(() => v.pushTranscript(''), TypeError);
  assert.throws(() => v.pushTranscript(null), TypeError);
});

// --- voice: barge-in + transcripts + confirm ---

test('bargeIn cancels pending clauses and returns to listening', () => {
  const v = new VoicePipeline();
  v.startListening();
  const out = v.requestSpeak('One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve.');
  assert.ok(v.getPending().length >= 1);
  void out;
  const dropped = v.bargeIn();
  assert.ok(dropped >= 1);
  assert.equal(v.getPending().length, 0);
  assert.equal(v.getState(), 'listening');
});

test('pushTranscript validates, moves to thinking, and emits read-only event', () => {
  const v = new VoicePipeline();
  v.startListening();
  const seen = [];
  v.subscribe((e) => seen.push(e));
  const evt = v.pushTranscript('hello friday');
  assert.equal(evt.text, 'hello friday');
  assert.equal(v.getState(), 'thinking');
  assert.ok(seen.some((e) => e.type === 'transcript'));
});

test('consequential utterance helper requires visual confirm and changes nothing', () => {
  const v = new VoicePipeline();
  v.startListening();
  const before = v.getState();
  const res = v.proposeConsequentialUtterance('Delete all files now please.');
  assert.equal(res.needsVisualConfirm, true);
  assert.match(res.text, /Delete/);
  assert.equal(v.getState(), before, 'state must not change');
  assert.equal(v.getPending().length, 0, 'nothing queued');
});

test('configure stores backend names only; no audio/network globals touched', async () => {
  const v = new VoicePipeline();
  const cfg = v.configure({ vad: 'silero', stt: 'whisper-tiny', tts: 'piper' });
  assert.deepEqual(cfg, { vad: 'silero', stt: 'whisper-tiny', tts: 'piper' });
  assert.deepEqual(v.getConfig(), cfg);
  assert.throws(() => v.configure({ vad: '' }), TypeError);
  // Pure-logic proof: no mic/speaker/network APIs are touched or required.
  assert.equal(globalThis.navigator?.mediaDevices, undefined);
  assert.equal(typeof globalThis.AudioContext, 'undefined');
  const raw = await readFile(new URL('../src/voice.mjs', import.meta.url), 'utf8')
    + await readFile(new URL('../src/pet.mjs', import.meta.url), 'utf8');
  // Strip comments so doc mentions ("no mic ...") don't count as usage.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['mediaDevices', 'AudioContext', 'getUserMedia', 'fetch(', 'XMLHttpRequest']) {
    assert.ok(!src.includes(banned), `banned API in pure module: ${banned}`);
  }
});

// --- pet state machine ---

test('pet happy path: wake -> hear -> task_running(acting) -> task_done', () => {
  const pet = new PetStateMachine();
  assert.equal(pet.getState(), 'sleeping');
  assert.equal(pet.transition('wake'), 'listening');
  assert.equal(pet.transition('hear'), 'thinking');
  assert.equal(pet.transition('task_running'), 'acting');
  assert.equal(pet.transition('task_done'), 'done');
});

test('pet approval pause: acting -> waiting -> approved -> thinking', () => {
  const pet = new PetStateMachine();
  pet.transition('wake');
  pet.transition('hear');
  pet.transition('task_running');
  assert.equal(pet.transition('approval_needed'), 'waiting');
  assert.equal(pet.transition('approved'), 'thinking');
});

test('pet emergency -> blocked and circuit_open -> offline from acting', () => {
  const pet = new PetStateMachine('acting');
  assert.equal(pet.transition('emergency'), 'blocked');
  const pet2 = new PetStateMachine('acting');
  assert.equal(pet2.transition('circuit_open'), 'offline');
  assert.equal(pet2.transition('recovered'), 'sleeping');
});

test('pet invalid transitions and unknown events are rejected', () => {
  const pet = new PetStateMachine();
  assert.throws(() => pet.transition('task_running'), RangeError);
  assert.throws(() => pet.transition('task_done'), RangeError);
  assert.throws(() => pet.transition('nope'), RangeError);
  assert.throws(() => pet.transition(''), TypeError);
  assert.equal(pet.getState(), 'sleeping', 'rejected transition must not move');
});

test('pet subscribe receives frozen events; unsubscribe stops them', () => {
  const pet = new PetStateMachine();
  const seen = [];
  const unsub = pet.subscribe((e) => seen.push(e));
  pet.transition('wake');
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].from, seen[0].to, seen[0].event], ['sleeping', 'listening', 'wake']);
  assert.ok(Object.isFrozen(seen[0]));
  unsub();
  pet.transition('hear');
  assert.equal(seen.length, 1);
  assert.throws(() => pet.subscribe('x'), TypeError);
});

test('pet exports all documented states and grants no authority', () => {
  assert.deepEqual([...STATES], ['sleeping', 'listening', 'thinking', 'acting', 'waiting', 'blocked', 'offline', 'done']);
  const pet = new PetStateMachine();
  assert.equal(typeof pet.transition, 'function');
  // No tool/effect/approval surface on the machine itself.
  for (const k of ['approve', 'runTool', 'claim', 'fetch', 'grant']) {
    assert.equal(pet[k], undefined);
  }
});

// --- renderer ---

test('renderPet maps every pet state to emoji+label; unknown falls back; no auto-init', () => {
  const expected = {
    sleeping: '😴', listening: '👂', thinking: '💭', acting: '🐾',
    waiting: '⏳', blocked: '⛔', offline: '📴', done: '✅',
  };
  for (const s of STATES) {
    const r = renderPet(s);
    assert.equal(r.emoji, expected[s]);
    assert.ok(typeof r.label === 'string' && r.label.length > 0);
  }
  assert.deepEqual(renderPet('bogus'), { emoji: '❓', label: 'Unknown' });
  assert.equal(typeof document, 'undefined', 'renderer must not require DOM at import');
});
