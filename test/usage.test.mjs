import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { ModelRouter } from '../src/ai/router.mjs';
import { Usage } from '../src/usage.mjs';
import { JevClient } from '../src/jev.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-usage-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store);
  settings.set('timezone', 'Asia/Kolkata');
  const t = Date.parse('2026-11-01T12:00:00Z'); // 05:00 Pacific, 17:30 IST
  const calls = [];
  const fake = (name) => ({ name, configured: true, async complete({ model }) { calls.push(`${name}:${model}`); return { content: 'ok', usage: { prompt_tokens: 1000, completion_tokens: 200 } }; } });
  const ai = new ModelRouter({ db: store.db, now: () => t, chains: { chat: [{ provider: 'gemini', model: 'gemini-3.6-flash' }, { provider: 'nvidia', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' }] } });
  ai.register(fake('gemini')).register(fake('nvidia'));
  const usage = new Usage({ db: store.db, settings, now: () => t });
  ai.capCheck = (e) => usage.capReason(e);
  const log = (provider, model, ts, ok = 1) => store.db.prepare('INSERT INTO model_calls (ts, role, provider, model, latency_ms, prompt_tokens, completion_tokens, ok) VALUES (?,?,?,?,?,?,?,?)').run(ts, 'chat', provider, model, 10, 100, 10, ok);
  return { store, settings, ai, usage, calls, log, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('usage: a model whose daily quota is spent is skipped (shared quota, Pacific day), and comes back after reset or a raised limit', async () => {
  const r = rig();
  try {
    // 19 calls today (Pacific) on 3.6-flash's shared quota, one of them through 3.5-flash; yesterday's do not count.
    for (let i = 0; i < 18; i++) r.log('gemini', 'gemini-3.6-flash', '2026-11-01T08:00:00.000Z');
    r.log('gemini', 'gemini-3.5-flash', '2026-11-01T09:00:00.000Z');
    r.log('gemini', 'gemini-3.6-flash', '2026-11-01T06:59:00.000Z'); // 23:59 Pacific the day before
    r.log('gemini', 'gemini-3.6-flash', '2026-11-01T10:00:00.000Z', 0); // failed: not counted
    assert.equal(r.usage.usedToday('gemini:gemini-3.6-flash'), 19);
    await r.ai.run('chat', { messages: [] });
    assert.deepEqual(r.calls, ['gemini:gemini-3.6-flash'], 'the 20th request still goes');
    const out = await r.ai.run('chat', { messages: [] });
    assert.equal(out.provider, 'nvidia', 'cap reached: falls back without asking Google');
    assert.match(out.attempts[0].error, /daily_cap: 20\/20 .*America\/Los_Angeles/);
    assert.match(r.usage.capReason({ provider: 'gemini', model: 'gemini-3.5-flash' }), /daily_cap/, 'shared quota');
    r.usage.setLimit('gemini:gemini-3.6-flash', 50);
    assert.equal(r.usage.capReason({ provider: 'gemini', model: 'gemini-3.6-flash' }), null);
    assert.throws(() => r.usage.setLimit('nonsense', 5), /provider:model/);
  } finally { r.done(); }
});

test('usage: summary prices calls, lists unpriced models, shows headroom; JEV calls are metered into the same log', async () => {
  const r = rig();
  try {
    await r.ai.run('chat', { messages: [] });
    const jev = new JevClient({ apiKey: 'k'.repeat(20), fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {}, usage: { input_tokens: 2_000_000, output_tokens: 10 } }) }),
      meter: (m) => r.ai.recordExternal({ role: 'sales_judge', ...m }) });
    await jev.decide({ state: 's', questions: [] });
    const bad = new JevClient({ apiKey: 'k'.repeat(20), fetchImpl: async () => ({ ok: false, status: 500 }), meter: (m) => r.ai.recordExternal({ role: 'sales_judge', ...m }) });
    await assert.rejects(bad.decide({ state: 's', questions: [] }), /jev_http_500/);
    r.log('fallback', 'mystery-model', '2026-11-01T11:00:00.000Z');

    const s = r.usage.summary();
    const row = (list, p, m) => list.find((x) => x.provider === p && x.model === m);
    const jevRow = row(s.today, 'typesafe', 'jev-1.14.0');
    assert.equal(jevRow.calls, 2); assert.equal(jevRow.errors, 1);
    assert.ok(Math.abs(jevRow.usd - 0.084) < 1e-9, '2M input tokens at $0.042/M');
    assert.equal(row(s.today, 'gemini', 'gemini-3.6-flash').usd, 0);
    assert.equal(row(s.today, 'gemini', 'gemini-3.6-flash').used_today, 1);
    assert.equal(row(s.today, 'gemini', 'gemini-3.8-flash').calls, 0, 'limited models show headroom even with no calls');
    assert.equal(row(s.today, 'fallback', 'mystery-model').usd, null);
    assert.deepEqual(s.unpriced, ['fallback:mystery-model']);
    assert.ok(Math.abs(s.usd_today - 0.084) < 1e-9);
  } finally { r.done(); }
});
