import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Images, ASPECTS } from '../src/images.mjs';
import { MEMBER_TOOLS, claimsActionWithoutTool, stripFileNotes } from '../src/agent/brain.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const ok = (seed) => ({ ok: true, status: 200, json: async () => ({ artifacts: [{ base64: JPEG.toString('base64'), finishReason: 'SUCCESS', seed }] }) });
const fail = (status, detail = 'boom') => ({ ok: false, status, json: async () => ({ detail }) });

function rig(handler) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-img-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const files = new Files({ store, dir: join(dir, 'files') });
  const calls = [];
  const fetchImpl = async (url, o) => { const body = JSON.parse(o.body); calls.push({ url, body, auth: o.headers.Authorization }); return handler({ url, body, n: calls.length }); };
  return { store, files, calls, images: new Images({ store, files, apiKey: 'nvapi-test', fetchImpl }), done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('images: not configured is an honest error; prompt is required and capped at 800 chars', async () => {
  const r = rig(() => ok(1));
  try {
    assert.equal((await new Images({ store: r.store, files: r.files }).create({ prompt: 'a cat' })).error, 'image_generation_not_configured');
    assert.match((await r.images.create({ prompt: '  ' })).error, /prompt required/);
    assert.match((await r.images.create({ prompt: 'x'.repeat(801) })).error, /at most 800/);
    assert.equal(r.calls.length, 0);
  } finally { r.done(); }
});

test('images: fast FLUX.2 klein by default, aspect sets the size, file attached and recorded with its seed', async () => {
  const r = rig(({ body }) => ok(body.seed));
  try {
    const out = await r.images.create({ prompt: 'A red  fox reading under a lamp', aspect: '16:9', seed: 42, conversationId: null });
    assert.equal(r.calls.length, 1);
    assert.match(r.calls[0].url, /\/v1\/genai\/black-forest-labs\/flux\.2-klein-4b$/);
    assert.equal(r.calls[0].auth, 'Bearer nvapi-test');
    assert.deepEqual(r.calls[0].body, { prompt: 'A red fox reading under a lamp', width: 1344, height: 768, seed: 42, steps: 4 });
    assert.equal(out.images.length, 1); assert.equal(out.size, '1344x768'); assert.equal(out._attach.length, 1);
    const f = r.files.get(out._attach[0]);
    assert.equal(f.name, 'a-red-fox-reading-under-a.jpg'); assert.equal(f.mime, 'image/jpeg'); assert.deepEqual(r.files.read(f.id), JPEG);
    const row = r.images.info(f.id);
    assert.equal(row.seed, 42); assert.equal(row.aspect, '16:9'); assert.equal(row.quality, 'fast');
    for (const [w, h] of Object.values(ASPECTS)) for (const v of [w, h]) assert.ok(v >= 768 && v <= 1344 && v % 64 === 0, 'every size is valid for FLUX.1-dev too');
  } finally { r.done(); }
});

test('images: based_on keeps the seed, size and model of the earlier picture; uploads cannot be used', async () => {
  const r = rig(({ body }) => ok(body.seed));
  try {
    const first = await r.images.create({ prompt: 'castle on a hill', aspect: '9:16', quality: 'best', seed: 7 });
    assert.match(r.calls[0].url, /flux\.1-dev$/); assert.equal(r.calls[0].body.steps, 30);
    const tweak = await r.images.create({ prompt: 'castle on a hill at night', based_on: first.images[0].file });
    assert.match(r.calls[1].url, /flux\.1-dev$/);
    assert.equal(r.calls[1].body.seed, 7); assert.equal(r.calls[1].body.width, 768); assert.equal(r.calls[1].body.height, 1344);
    assert.equal(r.images.info(tweak._attach[0]).based_on, first._attach[0]);
    const up = r.files.save({ name: 'me.png', data: Buffer.from([0x89, 0x50, 1]), source: 'upload' });
    assert.match((await r.images.create({ prompt: 'me as a cartoon', based_on: up.id })).error, /cannot be edited yet/);
  } finally { r.done(); }
});

test('images: a down model falls back to the other; a safety-filtered prompt does not; partial batches report failures', async () => {
  const down = rig(({ url, body }) => (url.includes('klein') ? fail(503) : ok(body.seed)));
  try {
    const out = await down.images.create({ prompt: 'lighthouse' });
    assert.equal(down.calls.length, 2); assert.match(down.calls[1].url, /flux\.1-dev$/);
    assert.match(out.images[0].note, /used best/); assert.equal(down.images.info(out._attach[0]).quality, 'best');
  } finally { down.done(); }
  const filtered = rig(() => ({ ok: true, status: 200, json: async () => ({ artifacts: [{ base64: JPEG.toString('base64'), finishReason: 'CONTENT_FILTERED', seed: 1 }] }) }));
  try {
    const out = await filtered.images.create({ prompt: 'something' });
    assert.match(out.error, /safety filter/); assert.equal(filtered.calls.length, 1); assert.equal(filtered.files.list().length, 0);
  } finally { filtered.done(); }
  const bad = rig(() => fail(422, [{ msg: 'Input should be less than or equal to 4' }]));
  try { assert.match((await bad.images.create({ prompt: 'x' })).error, /422: Input should be/); assert.equal(bad.calls.length, 1, 'a refused request is not retried'); } finally { bad.done(); }
  const some = rig(({ n, body }) => (n === 2 ? fail(422) : ok(body.seed)));
  try {
    const out = await some.images.create({ prompt: 'three hats', count: 3, seed: 5, name: 'Hats!' });
    assert.equal(out.images.length, 2); assert.equal(out.failed.length, 1);
    assert.equal(some.calls[0].body.seed, 5); assert.notEqual(some.calls[1].body.seed, 5);
    assert.ok(out.images.every((i) => /^hats-\d\.jpg$/.test(i.name)));
  } finally { some.done(); }
});

test('images: tool is registered for the owner only, runs in the chat, and "here is your picture" without it is a false claim', async () => {
  const { createContext } = await import('../src/context.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'friday-imgctx-'));
  const ctx = createContext({ appRoot: new URL('..', import.meta.url).pathname, env: { FRIDAY_DATA_DIR: dir, FRIDAY_NVIDIA_API_KEY: 'nvapi-test' } });
  try {
    ctx.images.fetchImpl = async (u, o) => ok(JSON.parse(o.body).seed);
    const convo = ctx.chat.createConversation('t');
    const tool = ctx.fridayTools.get('image_create');
    assert.equal(tool.risk, 'safe');
    const out = await tool.run({ prompt: 'a cozy reading nook', count: 2 }, { conversationId: convo.id });
    assert.equal(out._attach.length, 2);
    assert.deepEqual(ctx.files.list({ conversationId: convo.id }).map((f) => f.source), ['friday', 'friday']);
    ctx.chat.addMessage(convo.id, 'assistant', 'Here you go', { attachments: out._attach });
    const hist = ctx.chat.historyForProvider(convo.id).at(-1).content;
    assert.match(hist, /cozy-reading-nook-1\.jpg \(file id [0-9a-f]{8}; image you drew, prompt: "a cozy reading nook"\)/, 'she sees her own prompt when asked for a tweak');
    assert.equal(MEMBER_TOOLS.has('image_create'), false);
    assert.equal(stripFileNotes(`Two options for you 🦉\n\n[attached files: a.jpg (file id 076719ed; image you drew, prompt: "owl, cup [flat]")]`), 'Two options for you 🦉', 'a copied history note never reaches the chat');
    assert.equal(claimsActionWithoutTool('Here’s your picture! A fox in a library.', []), true);
    assert.equal(claimsActionWithoutTool('I just drew it for you', []), true);
    assert.equal(claimsActionWithoutTool('Here’s your picture!', [{ name: 'image_create' }]), false);
    assert.equal(claimsActionWithoutTool('Want me to draw it?', []), false);
    assert.equal(claimsActionWithoutTool('Here’s a logo idea: an owl inside a coffee bean.', []), false, 'describing an idea in words is not a claim');
  } finally { ctx.stop(); rmSync(dir, { recursive: true, force: true }); }
});
