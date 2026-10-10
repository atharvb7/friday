import test from 'node:test';
import assert from 'node:assert/strict';
import { ResilientAdapter, isTransientError } from '../src/provider.mjs';

test('transient errors retry then succeed; abort never retries', async () => {
  let calls = 0;
  const inner = {
    status: () => ({ ready: true }),
    run: async () => (++calls <= 2 ? { status: 'failed', error: '503 overloaded, try again' } : { status: 'completed', output: 'ok' }),
  };
  const a = new ResilientAdapter({ inner, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} });
  const out = await a.run({ taskId: 't', instruction: 'hi' });
  assert.equal(out.status, 'completed');
  assert.equal(calls, 3);
  assert.ok(isTransientError('rate_limited'));
  assert.ok(!isTransientError('dsh_binary_missing'));
});

test('consecutive failures open circuit and fast-fail', async () => {
  const inner = { status: () => ({ ready: true }), run: async () => ({ status: 'failed', error: 'auth denied' }) };
  const a = new ResilientAdapter({ inner, breakerThreshold: 2, breakerCooldownMs: 60000, sleep: async () => {} });
  await a.run({ taskId: 't', instruction: 'x' });
  await a.run({ taskId: 't', instruction: 'x' });
  const fast = await a.run({ taskId: 't', instruction: 'x' });
  assert.match(fast.error, /provider_circuit_open/);
  assert.equal(a.status().reason, 'provider_circuit_open');
});
