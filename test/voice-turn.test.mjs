import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImage, voiceTurn, describeScreen, MAX_IMAGE_BYTES } from '../src/voice-turn.mjs';
import { stripVoiceTags } from '../src/routes/voice.mjs';
import { chainsFromEnv } from '../src/ai/router.mjs';

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]).toString('base64');

test('voice turn: images are checked by type, magic bytes and size', () => {
  assert.equal(parseImage(undefined), null);
  assert.equal(parseImage({ mime: 'image/jpeg', data: jpeg }).mime, 'image/jpeg');
  assert.equal(parseImage({ mime: 'image/png', data: png }).mime, 'image/png');
  assert.throws(() => parseImage({ mime: 'image/gif', data: jpeg }), TypeError);
  assert.throws(() => parseImage({ mime: 'image/png', data: jpeg }), /do not match/);
  assert.throws(() => parseImage({ mime: 'image/jpeg', data: 'not base64!!' }), TypeError);
  assert.throws(() => parseImage({ mime: 'image/jpeg', data: Buffer.alloc(MAX_IMAGE_BYTES + 10, 0xff).toString('base64') }), /under/);
  assert.throws(() => parseImage('data:image/jpeg;base64,xx'), TypeError);
});

function stubs({ visionFails = false } = {}) {
  const calls = { vision: [], turns: [] };
  const ai = { run: async (role, opts) => { calls.vision.push({ role, opts }); if (visionFails) throw new Error('all_models_failed(vision)'); return { content: '**Terminal**: Error: Cannot find module `express`', provider: 'gemini', model: 'gemini-3.5-flash-lite' }; } };
  const quickTurn = async (text, convo, channel, note = '') => { calls.turns.push({ text, convo, channel, note }); return { reply: '[sigh] Express is not installed. Run npm install.', conversation: { id: convo ?? 'new-convo' } }; };
  const chat = { owns: (id, user) => id === 'mine' && user === null };
  return { calls, deps: { ai, quickTurn, chat, stripTags: stripVoiceTags } };
}

test('voice turn: no image -> no vision call, brain answers on the voice channel, display text has no tags', async () => {
  const { calls, deps } = stubs();
  const out = await voiceTurn({ text: '  what is the time  ', conversationId: 'mine' }, deps);
  assert.equal(calls.vision.length, 0, 'no image tokens for a normal question');
  assert.deepEqual(calls.turns, [{ text: 'what is the time', convo: 'mine', channel: 'voice', note: '' }]);
  assert.equal(out.reply, '[sigh] Express is not installed. Run npm install.'); assert.equal(out.text, 'Express is not installed. Run npm install.');
  assert.equal(out.conversationId, 'mine'); assert.equal(out.screen, null);
  await voiceTurn({ text: 'hi', conversationId: 'someone-elses' }, deps);
  assert.equal(calls.turns[1].convo, null, 'unknown/foreign conversation ids start a new conversation');
  await assert.rejects(() => voiceTurn({ text: '   ' }, deps), TypeError);
  await assert.rejects(() => voiceTurn({ text: 'x'.repeat(2001) }, deps), TypeError);
});

test('voice turn: screenshot -> one vision call (thinking off) -> brain gets a text note, never the image', async () => {
  const { calls, deps } = stubs();
  const out = await voiceTurn({ text: 'what does this error mean', image: { mime: 'image/jpeg', data: jpeg } }, deps);
  assert.equal(calls.vision.length, 1); assert.equal(calls.vision[0].role, 'vision');
  const o = calls.vision[0].opts; assert.equal(o.thinking, false);
  const parts = o.messages[0].content;
  assert.match(parts[0].text, /what does this error mean/); assert.equal(parts[1].type, 'image_url'); assert.match(parts[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(calls.turns[0].text, 'what does this error mean', 'his own words go to the brain as his message (guards + tool loading read only these)');
  const sent = calls.turns[0].note;
  assert.match(sent, /^\(Screenshot of my laptop/); assert.match(sent, /Cannot find module express/, 'markdown stripped from the note');
  assert.ok(!sent.includes('base64') && !/\bscreen\b/i.test(sent), 'no image data and no bare "screen" word');
  assert.deepEqual(out.screen, { used: true, model: 'gemini:gemini-3.5-flash-lite' });
});

test('voice turn: vision down -> she still answers and says she could not read it', async () => {
  const { calls, deps } = stubs({ visionFails: true });
  const out = await voiceTurn({ text: 'read this', image: { mime: 'image/png', data: png } }, deps);
  assert.equal(calls.turns[0].text, 'read this'); assert.match(calls.turns[0].note, /could not read it/); assert.equal(out.screen.used, false);
  await assert.rejects(() => describeScreen({ run: async () => ({ content: '  ' }) }, 'q', { mime: 'image/png', base64: png }), /vision_empty/);
});

test('vision chain: Gemini Flash-Lite first (fast, exact text), NVIDIA vision models as fallback, never a text-only model', () => {
  const c = chainsFromEnv({});
  assert.deepEqual(c.vision.map((e) => `${e.provider}:${e.model}`), ['gemini:gemini-3.5-flash-lite', 'nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning']);
  assert.ok(chainsFromEnv({ FRIDAY_GEMINI_VISION_MODEL: '' }).vision.every((e) => e.provider === 'nvidia'));
  assert.ok(!chainsFromEnv({ FRIDAY_FALLBACK_MODEL: 'x' }).vision.some((e) => e.provider === 'fallback'));
  assert.deepEqual(chainsFromEnv({ FRIDAY_MODELS_VISION: 'nvidia:a' }).vision, [{ provider: 'nvidia', model: 'a' }]);
});
