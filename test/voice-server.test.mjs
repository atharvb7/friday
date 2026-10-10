import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceServer } from '../src/voice-server.mjs';

const wavHeader = () => { const b = Buffer.alloc(44); b.write('RIFF', 0, 'ascii'); b.write('WAVE', 8, 'ascii'); return b; };

test('voice server: not installed -> honest 501-style errors; fake engines work; temp audio is deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-vs-'));
  try {
    const none = new VoiceServer({ env: {} });
    assert.deepEqual(none.status(), { stt: 'not_installed', tts: 'not_installed' });
    await assert.rejects(() => none.transcribe(wavHeader()), (e) => e.code === 'unavailable');
    await assert.rejects(() => none.speak('hi'), (e) => e.code === 'unavailable');

    const whisper = join(dir, 'whisper'); writeFileSync(whisper, '#!/bin/sh\necho "[00:00:00] hello friday  "\n'); chmodSync(whisper, 0o755);
    const piper = join(dir, 'piper'); writeFileSync(piper, '#!/bin/sh\nwhile [ "$1" != "--output_file" ]; do shift; done\ncat > "$2.txt"; printf RIFFxxxxWAVE > "$2"\n'); chmodSync(piper, 0o755);
    const model = join(dir, 'model.bin'); writeFileSync(model, 'x');
    const vs = new VoiceServer({ env: { FRIDAY_WHISPER_BIN: whisper, FRIDAY_WHISPER_MODEL: model, FRIDAY_PIPER_BIN: piper, FRIDAY_PIPER_MODEL: model } });
    assert.deepEqual(vs.status(), { stt: 'ready', tts: 'ready' });
    assert.equal(await vs.transcribe(wavHeader()), 'hello friday');
    assert.equal((await vs.speak('Hello *there*')).toString('ascii', 0, 4), 'RIFF');
    await assert.rejects(() => vs.transcribe(Buffer.from('not a wav file at all, definitely not')), /expected a WAV/);
    await assert.rejects(() => vs.transcribe(Buffer.alloc(5 * 1024 * 1024)), /expected a WAV/);
    await assert.rejects(() => vs.speak('   '), /text required/);
    const leftovers = readdirSync(tmpdir()).filter((f) => /^friday-(stt|tts)-/.test(f));
    assert.deepEqual(leftovers, [], 'no raw audio left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
