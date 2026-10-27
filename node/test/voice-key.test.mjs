import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, cueWav, explainError, loadConfig, needsScreen, notifyText, releaseLock, speechChunks, stripTags, Vad, wavFromPcm16 } from '../voice-lib.mjs';
import { VoiceSession } from '../voice-session.mjs';

const RATE = 16000;
const tone = (ms, db, hz = 220) => { const n = Math.round(RATE * ms / 1000); const a = 32768 * 10 ** (db / 20) * Math.SQRT2; return Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(2 * Math.PI * hz * i / RATE) * a)); };
const noise = (ms, db) => { const n = Math.round(RATE * ms / 1000); const a = 32768 * 10 ** (db / 20) * Math.sqrt(3); let s = 7; return Int16Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; return Math.round((s / 2147483647 * 2 - 1) * a); }); };
const feed = (vad, ...parts) => { for (const p of parts) for (let i = 0; i < p.length; i += 1600) { const r = vad.push(p.subarray(i, i + 1600)); if (r) return r; } return null; };

test('vad: speech then silence ends the recording; the cut keeps the speech with a little padding', () => {
  const v = new Vad({ silenceMs: 1200 });
  const r = feed(v, noise(400, -60), tone(1500, -22), noise(2000, -60));
  assert.equal(r.reason, 'silence');
  const s = v.summary();
  assert.equal(s.heard, true); assert.ok(s.speechMs >= 1300 && s.speechMs <= 1600, `speechMs ${s.speechMs}`);
  assert.ok(s.from > 0 && s.from < 400 * 16, 'starts ~300 ms before speech'); assert.ok(s.to > 1900 * 16 && s.to < 2600 * 16, `ends shortly after speech (${s.to / 16} ms)`);
  assert.ok(s.floorDb < -55);
});

test('vad: nobody talks -> no_speech; a click is not speech; pure digital zeros = muted mic; hard max', () => {
  const quiet = new Vad({ noSpeechMs: 3000 });
  assert.equal(feed(quiet, noise(4000, -58)).reason, 'no_speech'); assert.equal(quiet.summary().heard, false);
  const click = new Vad({ noSpeechMs: 3000, minSpeechMs: 350 });
  feed(click, noise(500, -60), tone(150, -15), noise(3000, -60));
  assert.equal(click.summary().heard, false, '150 ms blip is below minSpeechMs');
  const muted = new Vad();
  assert.equal(feed(muted, new Int16Array(RATE * 2)).reason, 'mic_silent'); assert.equal(muted.summary().micSilent, true);
  const long = new Vad({ maxMs: 2000, silenceMs: 5000 });
  assert.equal(feed(long, noise(300, -60), tone(5000, -20)).reason, 'max');
  const loudRoom = new Vad({ noSpeechMs: 3000 }); // steady fan noise at -40 dBFS is learned as the floor, not speech
  assert.equal(feed(loudRoom, noise(4000, -40)).reason, 'no_speech');
});

test('wav + cues: valid 16-bit PCM headers; cues are short, quiet and click-free', () => {
  const w = wavFromPcm16(Int16Array.from([1, -1, 2]), 16000);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.toString('ascii', 8, 12), 'WAVE');
  assert.equal(w.readUInt32LE(24), 16000); assert.equal(w.readUInt16LE(34), 16); assert.equal(w.readUInt32LE(40), 6); assert.equal(w.length, 50);
  for (const k of ['start', 'stop', 'error', 'cancel']) {
    const c = cueWav(k, { volume: 0.25 }); const n = (c.length - 44) / 2; let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c.readInt16LE(44 + i * 2)));
    assert.ok(peak <= 0.25 * 32767 + 1 && peak > 1000, `${k} peak ${peak}`); assert.ok(n / 24000 < 0.4, `${k} is short`);
    assert.ok(Math.abs(c.readInt16LE(44)) < 50 && Math.abs(c.readInt16LE(c.length - 2)) < 50, `${k} fades in/out`);
  }
});

test('needsScreen: only screen-ish questions get a screenshot', () => {
  for (const t of ['What is on my screen?', 'what does this error mean', 'Read this for me', 'can you read this out', 'Explain this code', 'what am I looking at', 'summarise this page', 'Can you see this?', 'look at this', 'what is this?', 'what does that say', 'check my screen please', 'translate this paragraph', 'take a screenshot and tell me what you see'])
    assert.ok(needsScreen(t), t);
  for (const t of ['What is the weather in Pune?', 'remind me in 10 minutes to call mom', 'send an email to Rohan', 'what is the capital of France', 'play some music', 'how are you doing today', 'tell me a joke', 'what is my schedule tomorrow', ''])
    assert.ok(!needsScreen(t), t);
});

test('speechChunks: fast first sentence, grouped rest, tags stay attached, long text bounded', () => {
  const c = speechChunks('[chuckle] Okay so here is the thing. The server could not find the file. It is a small fix. Run npm install and restart it. [sigh] Then try again.');
  assert.equal(c[0], '[chuckle] Okay so here is the thing.');
  assert.ok(c.length >= 2 && c.length <= 3, JSON.stringify(c));
  assert.ok(c.at(-1).endsWith('[sigh] Then try again.'), 'a tag starts its sentence and stays with it');
  assert.deepEqual(speechChunks('Hi! [laugh]'), ['Hi! [laugh]'], 'a lone trailing tag joins the sentence before it');
  assert.deepEqual(speechChunks('   '), []);
  const long = speechChunks('word '.repeat(300));
  assert.ok(long.every((x) => x.length <= 440), 'no endless chunk without punctuation');
  assert.equal(long.join(' ').split(' ').length, 300);
});

test('text helpers: tags stripped for display, notification markup escaped and bounded, errors explained', () => {
  assert.equal(stripTags('[sigh] Fine. [chuckle] You win.'), 'Fine. You win.');
  assert.equal(notifyText('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.ok(notifyText('x'.repeat(500)).length <= 300);
  assert.match(explainError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), /reach Friday/);
  assert.match(explainError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), /too long/);
  assert.equal(explainError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), null, 'user cancel is silent');
  assert.match(explainError(new Error('server 403: forbidden')), /read,chat/);
  assert.match(explainError(new Error('server 401: unauthorized')), /token/);
  assert.match(explainError(new Error('mic: pw-record exited 1: no audio source')), /Microphone/);
});

test('lock: one owner; a live voice-key instance is found; stale locks are taken over; release only by the owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-vk-'));
  try {
    const f = join(dir, 'lock');
    assert.deepEqual(acquireLock(f, { pid: 111, isOurs: () => false }), { owner: true });
    assert.deepEqual(acquireLock(f, { pid: 222, isOurs: (p) => p === 111 }), { owner: false, pid: 111 });
    assert.deepEqual(acquireLock(f, { pid: 222, isOurs: () => false }), { owner: true }, 'dead/reused pid -> stale lock replaced');
    assert.equal(readFileSync(f, 'utf8'), '222');
    releaseLock(f, 111); assert.ok(existsSync(f), 'not the owner: lock kept');
    releaseLock(f, 222); assert.ok(!existsSync(f));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config: voice token from env > voice.json > node config; server from the node pairing', () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-vk-home-'));
  try {
    const d = join(home, '.friday-node'); mkdirSync(d);
    writeFileSync(join(d, 'config.json'), JSON.stringify({ server: 'https://friday.example:4317/', token: 'fdv_node' }));
    let c = loadConfig({ env: {}, home });
    assert.equal(c.server, 'https://friday.example:4317'); assert.equal(c.token, 'fdv_node'); assert.equal(c.tokenSource, 'config.json');
    writeFileSync(join(d, 'voice.json'), JSON.stringify({ token: 'fdv_voice', screen: 'never', voice: { speed: 0.9 } }));
    c = loadConfig({ env: {}, home });
    assert.equal(c.token, 'fdv_voice'); assert.equal(c.screen, 'never'); assert.equal(c.voice.speed, 0.9); assert.ok(c.voice.voice, 'other voice defaults kept');
    c = loadConfig({ env: { FRIDAY_VOICE_TOKEN: 'fdv_env', FRIDAY_VOICE_SERVER: 'https://other' }, home });
    assert.equal(c.token, 'fdv_env'); assert.equal(c.server, 'https://other'); assert.equal(c.tokenSource, 'env');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------- the state machine, with stubbed side effects ----------
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function harness(over = {}, cfg = {}) {
  const calls = []; const ev = (n, x) => calls.push(x === undefined ? n : [n, x]);
  let convo = 'c-old'; let clock = 1_000_000;
  const deps = {
    now: () => clock,
    cue: async (k) => ev('cue', k),
    notify: async ({ title, body, transient }) => { ev('notify', `${title} | ${body}${transient ? '' : ' (kept)'}`); return 7; },
    closeNotification: async (id) => ev('close', id),
    record: () => { ev('record'); return { stop: () => ev('rec.stop'), done: Promise.resolve({ heard: true, wav: Buffer.from('RIFF') }) }; },
    transcribe: async () => { ev('transcribe'); return 'what is the weather'; },
    screenshot: async () => { ev('screenshot'); return { mime: 'image/jpeg', data: '/9j/AA==' }; },
    turn: async (b) => { ev('turn', { text: b.text, image: Boolean(b.image), conversationId: b.conversationId }); return { reply: '[chuckle] Sunny. Take sunglasses.', text: 'Sunny. Take sunglasses.', conversationId: 'c-new' }; },
    synth: async (t) => { ev('synth', t); return Buffer.from(t); },
    play: async (w) => { ev('play', String(w)); },
    conversation: { get: () => convo, set: (id) => { convo = id; ev('convo', id); } },
    log: () => {},
    ...over,
  };
  const s = new VoiceSession(deps, cfg);
  return { s, calls, advance: (ms) => { clock += ms; }, convo: () => convo };
}

test('session: press -> listen -> transcribe -> answer -> notification + spoken reply; follow-up conversation kept', async () => {
  const h = harness();
  assert.equal(h.s.press(), 'listen'); await h.s.round;
  const names = h.calls.map((c) => (Array.isArray(c) ? c[0] : c));
  assert.deepEqual(names.filter((n) => n === 'cue'), ['cue', 'cue']);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'cue').map((c) => c[1]), ['start', 'stop']);
  assert.deepEqual(h.calls.find((c) => c[0] === 'turn')[1], { text: 'what is the weather', image: false, conversationId: 'c-old' });
  assert.ok(!names.includes('screenshot'), 'no screenshot for a non-screen question (no image tokens)');
  assert.ok(h.calls.some((c) => c[0] === 'notify' && /You: what is the weather \| Sunny\. Take sunglasses\. \(kept\)/.test(c[1])), 'answer stays in the notification list');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'synth').map((c) => c[1]), ['[chuckle] Sunny. Take sunglasses.'], 'tags go to the voice, not the notification');
  assert.equal(h.convo(), 'c-new'); assert.equal(h.s.state, 'idle');
});

test('session: screen questions close our banner, attach a screenshot; screen=never/always respected', async () => {
  let h = harness({ transcribe: async () => 'what does this error mean' });
  h.s.press(); await h.s.round;
  const i = h.calls.findIndex((c) => c[0] === 'close'); const j = h.calls.indexOf('screenshot');
  assert.ok(i >= 0 && j > i, 'notification closed before the screenshot');
  assert.equal(h.calls.find((c) => c[0] === 'turn')[1].image, true);
  h = harness({ transcribe: async () => 'what does this error mean' }, { screen: 'never' });
  h.s.press(); await h.s.round; assert.equal(h.calls.find((c) => c[0] === 'turn')[1].image, false);
  h = harness(); h.s.press({ screen: 'always' }); await h.s.round; assert.equal(h.calls.find((c) => c[0] === 'turn')[1].image, true, '--screen key');
  h = harness({ transcribe: async () => 'read this', screenshot: async () => { throw new Error('portal denied'); } });
  h.s.press(); await h.s.round; assert.equal(h.calls.find((c) => c[0] === 'turn')[1].image, false, 'a failed screenshot still answers');
});

test('session: nothing heard / empty transcript / tts off / muted speaker -> no server call or no speech', async () => {
  let h = harness({ record: () => ({ stop() {}, done: Promise.resolve({ heard: false }) }) });
  h.s.press(); await h.s.round;
  assert.ok(!h.calls.includes('transcribe')); assert.ok(h.calls.some((c) => c[0] === 'notify' && /didn’t catch/.test(c[1])));
  h = harness({ transcribe: async () => '  ' }); h.s.press(); await h.s.round;
  assert.ok(!h.calls.some((c) => c[0] === 'turn'));
  h = harness({}, { tts: 'off' }); h.s.press(); await h.s.round;
  assert.ok(!h.calls.some((c) => c[0] === 'synth') && h.calls.some((c) => c[0] === 'turn'));
  h = harness({ speakerMuted: async () => true }); h.s.press(); await h.s.round;
  assert.ok(!h.calls.some((c) => c[0] === 'synth') && h.calls.some((c) => c[0] === 'notify' && /speaker is muted/.test(c[1])), 'muted speaker: written, not spoken');
});

test('session: mic missing/muted and server unreachable -> error beep + a clear notification', async () => {
  let h = harness({ record: () => ({ stop() {}, done: Promise.resolve({ error: 'pw-record exited 1: no audio source' }) }) });
  h.s.press(); await h.s.round;
  assert.ok(h.calls.some((c) => c[0] === 'cue' && c[1] === 'error')); assert.ok(h.calls.some((c) => c[0] === 'notify' && /Microphone unavailable/.test(c[1])));
  h = harness({ record: () => ({ stop() {}, done: Promise.resolve({ micSilent: true, heard: false }) }) });
  h.s.press(); await h.s.round; assert.ok(h.calls.some((c) => c[0] === 'notify' && /Microphone/.test(c[1])));
  h = harness({ turn: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  h.s.press(); await h.s.round;
  assert.ok(h.calls.some((c) => c[0] === 'notify' && /Can’t reach Friday/.test(c[1]))); assert.equal(h.s.state, 'idle');
});

test('session: press again = stop recording early; press while thinking = cancel; double tap debounced', async () => {
  let release;
  let h = harness({ record: () => ({ stop: () => release({ heard: true, wav: Buffer.from('x') }), done: new Promise((r) => { release = r; }) }) });
  h.s.press(); await tick(); assert.equal(h.s.state, 'listening');
  assert.equal(h.s.press(), 'debounced', 'second press within 350 ms ignored');
  h.advance(1000); assert.equal(h.s.press(), 'stop'); await h.s.round;
  assert.ok(h.calls.some((c) => c[0] === 'turn'), 'early stop still answers');

  h = harness({ turn: (b, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  h.s.press(); await tick(5); assert.equal(h.s.state, 'thinking');
  h.advance(1000); assert.equal(h.s.press(), 'cancel'); await h.s.round;
  assert.ok(h.calls.some((c) => c[0] === 'cue' && c[1] === 'cancel')); assert.ok(!h.calls.some((c) => c[0] === 'notify' && /went wrong|reach/.test(c[1])), 'no error for a cancel');
  assert.ok(!h.calls.some((c) => c[0] === 'synth'));
});

test('session: press while she talks interrupts playback and listens again', async () => {
  let plays = 0;
  const h = harness({
    turn: async () => ({ reply: 'First sentence here. Second sentence follows it. Third one.', text: 'x', conversationId: 'c1' }),
    play: (w, { signal }) => { plays += 1; return plays === 1 ? new Promise((r) => signal.addEventListener('abort', r)) : Promise.resolve(); },
  });
  h.s.press(); await tick(5); assert.equal(h.s.state, 'speaking');
  h.advance(1000); assert.equal(h.s.press(), 'interrupt');
  await tick(5); await h.s.round;
  assert.equal(h.calls.filter((c) => c === 'record').length, 2, 'listening again after the interrupt');
  assert.ok(!h.calls.some((c) => c[0] === 'cue' && c[1] === 'cancel'), 'interrupt goes straight to the start beep');
  assert.equal(h.s.state, 'idle');
});
