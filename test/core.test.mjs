import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { readResources } from '../src/resources.mjs';

test('tasks persist, prevent duplicate submissions, and record transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-test-'));
  try {
    let store = new Store(join(dir, 'tasks.sqlite'));
    const task = store.createTask({ title: 'Research', instruction: 'Collect sources', idempotencyKey: 'phone-1' });
    assert.equal(store.createTask({ title: 'Research', instruction: 'Collect sources', idempotencyKey: 'phone-1' }).id, task.id);
    assert.equal(store.listTasks().length, 1);
    assert.equal(store.transition(task.id, 'completed').error, 'invalid_transition');
    assert.equal(store.transition(task.id, 'running').task.status, 'running');
    store.close();
    store = new Store(join(dir, 'tasks.sqlite'));
    assert.equal(store.getTask(task.id).status, 'blocked');
    assert.match(store.getTask(task.id).error, /interrupted/);
    assert.deepEqual(store.listEvents(task.id).map(e => e.kind), ['task.created', 'task.running', 'task.blocked']);
    assert.equal(store.transition(task.id, 'cancelled').task.status, 'cancelled');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resource snapshot reports host availability and keeps local inference disabled', () => {
  const resources = readResources();
  assert.ok(resources.totalBytes > 0);
  assert.ok(resources.availableBytes > 0);
  assert.equal(resources.localModelEnabled, false);
  assert.ok(['normal', 'constrained', 'paused', 'emergency'].includes(resources.mode));
});
