import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { WorkerLoop } from '../src/worker.mjs';

test('worker respects memory admission and completes only after adapter result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-worker-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const task = store.createTask({ title: 'Test', instruction: 'Hello' });
    let mode = 'constrained';
    const governor = {
      sample: () => ({ mode }),
      canAdmit: () => ({ allowed: mode === 'normal' }),
      acquire: () => ({ allowed: true, release() {} }),
    };
    const adapter = { status: () => ({ ready: true }), run: async () => ({ status: 'completed', output: 'Done' }) };
    const worker = new WorkerLoop({ store, governor, adapter });
    await worker.tick();
    assert.equal(store.getTask(task.id).status, 'queued');
    mode = 'normal';
    await worker.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.getTask(task.id).status, 'completed');
    assert.equal(store.getTask(task.id).result, 'Done');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
