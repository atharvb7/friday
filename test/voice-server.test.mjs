import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { VoiceServer } from '../src/voice-server.mjs';

const wavHeader = () => { const b = Buffer.alloc(44); b.write('RIFF', 0, 'ascii'); b.write('WAVE', 8, 'ascii'); return b; };

test('voice server: not installed -> honest 501-style errors; fake engines work; temp audio is deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-vs-'));
  try {
    const none = new VoiceServer({ env: {} });
    assert.equal(none.status().stt, 'not_installed'); assert.equal(none.status().tts, 'not_installed');
    await assert.rejects(() => none.transcribe(wavHeader()), (e) => e.code === 'unavailable');
    await assert.rejects(() => none.speak('hi'), (e) => e.code === 'unavailable');

    const whisper = join(dir, 'whisper'); writeFileSync(whisper, '#!/bin/sh\necho "[00:00:00] hello friday  "\n'); chmodSync(whisper, 0o755);
    const piper = join(dir, 'piper'); writeFileSync(piper, '#!/bin/sh\nwhile [ "$1" != "--output_file" ]; do shift; done\ncat > "$2.txt"; printf RIFFxxxxWAVE > "$2"\n'); chmodSync(piper, 0o755);
    const model = join(dir, 'model.bin'); writeFileSync(model, 'x');
    const vs = new VoiceServer({ env: { FRIDAY_WHISPER_BIN: whisper, FRIDAY_WHISPER_MODEL: model, FRIDAY_PIPER_BIN: piper, FRIDAY_PIPER_MODEL: model } });
    assert.equal(vs.status().stt, 'ready'); assert.equal(vs.status().tts, 'ready'); assert.equal(vs.status().engine, 'cli');
    assert.equal(await vs.transcribe(wavHeader()), 'hello friday');
    assert.equal((await vs.speak('Hello *there*')).toString('ascii', 0, 4), 'RIFF');
    await assert.rejects(() => vs.transcribe(Buffer.from('not a wav file at all, definitely not')), /expected a WAV/);
    await assert.rejects(() => vs.transcribe(Buffer.alloc(5 * 1024 * 1024)), /expected a WAV/);
    await assert.rejects(() => vs.speak('   '), /text required/);
    const leftovers = readdirSync(tmpdir()).filter((f) => /^friday-(stt|tts)-/.test(f));
    assert.deepEqual(leftovers, [], 'no raw audio left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { mkdirSync } from 'node:fs';
import { PythonWorker } from '../src/voice-worker.mjs';

// A fake "python" (node) speaking the same JSON-lines protocol as voice/engine.py.
const FAKE_ENGINE = `
const rl = require('readline').createInterface({ input: process.stdin });
const fs = require('fs');
rl.on('line', (line) => {
  const r = JSON.parse(line);
  if (r.op === 'stt') return console.log(JSON.stringify({ id: r.id, ok: true, text: 'hey friday ' + (r.prompt ? 'primed' : 'plain') + ' ' + r.lang + ' ' + fs.statSync(r.wav).size }));
  if (r.op === 'tts') { fs.writeFileSync(r.out, Buffer.concat([Buffer.from('RIFF'), Buffer.from(JSON.stringify({ v: r.voice, s: r.speed, t: r.text, e: r.engine, p: r.pitch }))])); return console.log(JSON.stringify({ id: r.id, ok: true, engine: r.engine })); }
  if (r.op === 'warm') return console.log(JSON.stringify({ id: r.id, ok: true, engine: r.engine }));
  if (r.op === 'boom') return console.log(JSON.stringify({ id: r.id, ok: false, error: 'Boom' }));
  if (r.op === 'die') process.exit(1);
});`;

test('python voice worker: serialised requests, on-demand start, idle shutdown, crash recovery, model prompt + voice forwarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-pw-'));
  try {
    const script = join(dir, 'engine.py'); writeFileSync(script, FAKE_ENGINE);
    const w = new PythonWorker({ python: process.execPath, script, idleMs: 150, timeoutMs: 5000 });
    assert.equal(w.running, false);
    const [a, b] = await Promise.all([w.call({ op: 'tts', text: 'hi', voice: 'af_heart', speed: 1, out: join(dir, 'o1.wav') }), w.call({ op: 'boom' })]);
    assert.equal(a.ok, true); assert.equal(b.ok, false);
    assert.equal(w.running, true);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(w.running, false, 'worker exits when idle so model RAM is freed');
    assert.equal((await w.call({ op: 'tts', text: 'again', voice: 'x', speed: 1, out: join(dir, 'o2.wav') })).ok, true, 'restarts on demand');
    await assert.rejects(() => w.call({ op: 'die' }), /voice_worker_exited/);
    assert.equal((await w.call({ op: 'tts', text: 'recovered', voice: 'x', speed: 1, out: join(dir, 'o3.wav') })).ok, true, 'recovers after a crash');
    w.stop();

    // through VoiceServer
    const home = join(dir, 'voice'); mkdirSync(join(home, 'models', 'whisper'), { recursive: true });
    writeFileSync(join(home, 'models', 'whisper', 'model.bin'), 'x'); writeFileSync(join(home, 'models', 'kokoro-v1.0.onnx'), 'x'); writeFileSync(join(home, 'models', 'voices-v1.0.bin'), 'x');
    const appRoot = join(dir, 'app'); mkdirSync(join(appRoot, 'voice'), { recursive: true }); writeFileSync(join(appRoot, 'voice', 'engine.py'), FAKE_ENGINE);
    const vs = new VoiceServer({ env: { FRIDAY_VOICE_PYTHON: process.execPath, FRIDAY_VOICE_HOME: home }, appRoot });
    const st = vs.status(); assert.equal(st.stt, 'ready'); assert.equal(st.tts, 'ready'); assert.equal(st.engine, 'whisper+kokoro'); assert.equal(st.sttModel, 'small');
    assert.match(await vs.transcribe(wavHeader(), { prompt: 'names' }), /^hey friday primed en \d+$/);
    const audio = await vs.speak('Hello *there*', { voice: 'af_heart:65,af_nicole:35', speed: 0.96 });
    assert.match(audio.toString(), /"v":"af_heart:65,af_nicole:35"/); assert.match(audio.toString(), /"s":0.96/); assert.match(audio.toString(), /Hello there/);
    await assert.rejects(() => vs.speak('x', { voice: 'af_heart; rm -rf /' }), /invalid voice/);
    assert.deepEqual(readdirSync(tmpdir()).filter((f) => /^friday-(stt|tts)-/.test(f)), [], 'no raw audio left behind');
    vs.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('voice server: overlapping speak requests (prefetched next sentence) queue instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-voiceq-'));
  try {
    const piper = join(dir, 'piper'); writeFileSync(piper, '#!/bin/sh\nsleep 0.3\nwhile [ "$1" != "--output_file" ]; do shift; done\ncat > "$2.txt"; printf RIFFxxxxWAVE > "$2"\n'); chmodSync(piper, 0o755);
    const model = join(dir, 'model.bin'); writeFileSync(model, 'x');
    let active = 0, peak = 0;
    const governor = { acquire: () => { if (active >= 1) return { allowed: false, reason: 'class_full' }; active++; peak = Math.max(peak, active); return { allowed: true, release() { active--; } }; } };
    const vs = new VoiceServer({ env: { FRIDAY_PIPER_BIN: piper, FRIDAY_PIPER_MODEL: model }, governor });
    const outs = await Promise.all(['First sentence.', 'Second sentence.', 'Third sentence.'].map((t) => vs.speak(t)));
    assert.equal(outs.length, 3); assert.ok(outs.every((o) => o.toString('ascii', 0, 4) === 'RIFF'));
    assert.equal(peak, 1, 'still one voice job at a time');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expressive voice: used only when its models are installed; engine/pitch forwarded; warm-up; tags kept for speech', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-ex-'));
  try {
    const home = join(dir, 'voice'); const models = join(home, 'models'); mkdirSync(join(models, 'whisper'), { recursive: true });
    for (const f of ['kokoro-v1.0.onnx', 'voices-v1.0.bin']) writeFileSync(join(models, f), 'x');
    const appRoot = join(dir, 'app'); mkdirSync(join(appRoot, 'voice'), { recursive: true }); writeFileSync(join(appRoot, 'voice', 'engine.py'), FAKE_ENGINE);
    const mk = () => new VoiceServer({ env: { FRIDAY_VOICE_PYTHON: process.execPath, FRIDAY_VOICE_HOME: home }, appRoot });
    let vs = mk();
    assert.equal(vs.status().expressive, 'not_installed');
    let audio = (await vs.speak('[chuckle] Hi you', { engine: 'expressive', pitch: 1.12 })).toString();
    assert.match(audio, /"e":"kokoro"/, 'falls back to Kokoro when the expressive models are missing');
    vs.stop();
    mkdirSync(join(models, 'chatterbox-nano', 'onnx'), { recursive: true });
    for (const f of ['onnx/language_model_int8_mixed.onnx', 'onnx/conditional_decoder_int8.onnx', 'onnx/embed_tokens.onnx', 'onnx/speech_encoder.onnx', 'tokenizer.json']) writeFileSync(join(models, 'chatterbox-nano', f), 'x');
    vs = mk();
    assert.equal(vs.status().expressive, 'ready');
    audio = (await vs.speak('[chuckle] Hi *you*', { voice: 'af_heart:65,af_nicole:35', engine: 'expressive', pitch: 1.12 })).toString();
    assert.match(audio, /"e":"expressive"/); assert.match(audio, /"p":1.12/); assert.match(audio, /"t":"\[chuckle\] Hi you"/, 'tags reach the engine; markdown does not');
    assert.match((await vs.speak('x', { engine: 'expressive', pitch: 9 })).toString(), /"p":1.4/, 'pitch is clamped');
    assert.match((await vs.speak('x', { engine: 'kokoro' })).toString(), /"e":"kokoro"/);
    assert.deepEqual(await vs.warm({ engine: 'expressive', pitch: 1.12 }), { warmed: true, engine: 'expressive' });
    vs.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('voice tags: hidden from text, prompt teaches them only on the voice channel', async () => {
  const { stripVoiceTags } = await import('../src/routes/voice.mjs');
  assert.equal(stripVoiceTags('[whispering] Come here… [sigh] closer. [Laugh]'), 'Come here… closer.');
  assert.equal(stripVoiceTags('keep [this] text'), 'keep [this] text', 'only known tags are removed');
  const { buildSystemPrompt, normalizePersonality } = await import('../src/personality.mjs');
  const voice = buildSystemPrompt({ personality: normalizePersonality({}), channel: 'voice' });
  const text = buildSystemPrompt({ personality: normalizePersonality({}), channel: 'chat' });
  assert.match(voice, /\[whispering\]/); assert.match(voice, /\[laugh\]/); assert.match(voice, /Never write "haha"/);
  assert.ok(!text.includes('[whispering]'));
});

test('engine.py text handling: unknown tags and emoji are never read out, sentences are chunked', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 not available' }, () => {
  const code = `
import sys, json, types
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'voice'))})
import engine
fake = types.SimpleNamespace(tags={'[laugh]', '[whispering]', '[sigh]'})
out = {
  'plain': engine.plain('[whispering] Hey 😘 you [laugh]!'),
  'clean': engine.Expressive.clean(fake, '[Whispering] Hey 😘 [poke] you [laugh]!'),
  'chunks': engine.Expressive.chunks(fake, 'One. Two! ' + 'x' * 250 + '. [sigh]', 240),
}
print(json.dumps(out))`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.plain, 'Hey you !');
  assert.equal(o.clean, '[whispering] Hey you [laugh] !');
  assert.equal(o.chunks.length, 2); assert.equal(o.chunks[0], 'One. Two!'); assert.match(o.chunks[1], /\[sigh\]$/);
});
