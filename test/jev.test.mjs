import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, classifyIntentLocal, assessRiskLocal, TOOL_FOR_INTENT } from '../src/jev.mjs';

test('local fallback classifies without network and fails closed', () => {
  const r = classifyIntentLocal('find xyz.pdf in Downloads');
  assert.equal(r.intent, 'file_search');
  assert.ok(r.confidence < 0.6);
  assert.equal(assessRiskLocal('send xyz.pdf to Rohan').needsApproval, true);
  assert.equal(assessRiskLocal('what is photosynthesis').needsApproval, false);
  assert.ok(TOOL_FOR_INTENT.file_search === 'file.search');
});

test('routeInstruction uses local fallback when unconfigured', async () => {
  const jev = new JevClient({ apiKey: null });
  const out = await jev.routeInstruction('remind me at 7pm');
  assert.equal(out.source, 'local-fallback');
  assert.equal(out.intent, 'schedule');
  assert.ok(out.needsApproval === false || out.needsApproval === true);
});

test('routeInstruction uses JEV when configured (mocked fetch), fails closed on low confidence', async () => {
  const good = new JevClient({ apiKey: 'jv_live_test', fetchImpl: async () => ({
    ok: true,
    json: async () => ({ answers: { intent: { choice: 'file_search' }, risk: { score: 1 }, needsApproval: { probability: 0.1 }, urgency: { score: 1 } }, confidence: { intent: 0.92 }, model: 'jev-1.13.0' }),
  }) });
  const out = await good.routeInstruction('find xyz.pdf');
  assert.equal(out.source, 'jev');
  assert.equal(out.intent, 'file_search');
  assert.equal(out.tool, 'file.search');

  const unsure = new JevClient({ apiKey: 'jv_live_test', fetchImpl: async () => ({
    ok: true,
    json: async () => ({ answers: { intent: { choice: 'browser' }, risk: { score: 2 }, needsApproval: { probability: 0.2 }, urgency: { score: 2 } }, confidence: { intent: 0.3 }, model: 'jev-1.13.0' }),
  }) });
  const out2 = await unsure.routeInstruction('do something vague');
  assert.equal(out2.intent, 'unknown');
  assert.equal(out2.needsApproval, true);
});

test('JEV failure falls back safely (no throw, approval required)', async () => {
  const broken = new JevClient({ apiKey: 'jv_live_test', fetchImpl: async () => { throw new Error('down'); } });
  const out = await broken.routeInstruction('delete everything');
  assert.equal(out.source, 'local-fallback');
  assert.equal(out.needsApproval, true);
});
