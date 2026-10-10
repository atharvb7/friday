import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chunkSpeak, parseInterim, VOICE_MAX_CHUNK } from '../public/voice.js';

// No mic use in tests: only pure helpers are exercised. No DOM, no audio,
// no SpeechRecognition / speechSynthesis globals are touched here.

test('voice-bar pure import touches no DOM/THREE/mic-capture APIs', async () => {
  assert.equal(typeof document, 'undefined', 'tests run without DOM');
  assert.equal(VOICE_MAX_CHUNK, 200);
  const src = await readFile(new URL('../public/voice.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['THREE', 'getUserMedia', 'mediaDevices', 'AudioContext', 'fetch(']) {
    assert.ok(!code.includes(banned), `banned API in voice bar module: ${banned}`);
  }
});

test('chunkSpeak splits long text into clauses each <=200 chars', () => {
  const text = 'Hello there. This is a longer sentence that should be split into short clauses for speech synthesis to handle nicely. And a final bit!';
  const out = chunkSpeak(text);
  assert.ok(out.length >= 2);
  for (const c of out) {
    assert.ok(typeof c === 'string' && c.length > 0);
    assert.ok(c.length <= 200, `clause too long: ${c.length}`);
  }
  // Lossless at word level.
  assert.deepEqual(out.join(' ').replace(/\s+/g, ' ').trim().split(' '), text.replace(/\s+/g, ' ').trim().split(' '));
});

test('chunkSpeak hard-splits very long single-token input', () => {
  const long = 'x'.repeat(450);
  const clauses = chunkSpeak(long);
  assert.ok(clauses.length >= 3);
  for (const c of clauses) assert.ok(c.length <= 200);
  assert.equal(clauses.join(''), long);
});

test('chunkSpeak validates input and handles blanks', () => {
  assert.deepEqual(chunkSpeak('   '), []);
  assert.throws(() => chunkSpeak(42), TypeError);
  assert.throws(() => chunkSpeak(null), TypeError);
});

test('parseInterim separates interim vs final transcripts', () => {
  const fake = (transcript, isFinal) => ({ 0: { transcript }, isFinal, length: 1 });
  const event = {
    resultIndex: 0,
    results: [fake('hello fri', false), fake('open the queue', true), fake('please', true)],
  };
  const { interim, final } = parseInterim(event);
  assert.equal(interim, 'hello fri');
  assert.equal(final, 'open the queue please');
});

test('parseInterim honors resultIndex and tolerates junk', () => {
  const fake = (transcript, isFinal) => ({ 0: { transcript }, isFinal, length: 1 });
  const event = {
    resultIndex: 1,
    results: [fake('skip me', true), fake('live words', false)],
  };
  assert.deepEqual(parseInterim(event), { interim: 'live words', final: '' });
  assert.deepEqual(parseInterim(null), { interim: '', final: '' });
  assert.deepEqual(parseInterim({}), { interim: '', final: '' });
  assert.deepEqual(parseInterim({ resultIndex: 0, results: { length: 0 } }), { interim: '', final: '' });
});
