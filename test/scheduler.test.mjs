// test/scheduler.test.mjs — coverage for the durable scheduler:
// schedule (taskId or title+instruction), due listing, atomic claimDue,
// done/cancel transitions, validation, and no auto-run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';

function makeScheduler() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-scheduler-'));
  const store = new Store(join(dir, 'scheduler-test.sqlite'));
  const scheduler = new Scheduler(store);
  return { dir, store, scheduler, cleanup: () => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

test('schedule with title+instruction creates a task and a scheduled row', () => {
  const { scheduler, cleanup } = makeScheduler();
  try {
    const row = scheduler.schedule({ title: 'Cleanup', instruction: 'Tidy the workspace', runAt: FUTURE });
    assert.equal(row.status, 'scheduled');
    assert.equal(row.run_at, new Date(FUTURE).toISOString());
    assert.equal(row.repeat, null);
    assert.ok(row.task_id);
    assert.equal(row.title, 'Cleanup');
    const fetched = scheduler.get(row.id);
    assert.deepEqual(fetched, row);
  } finally {
    cleanup();
  }
});

test('schedule with an existing taskId links it and validates runAt', () => {
  const { store, scheduler, cleanup } = makeScheduler();
  try {
    const task = store.createTask({ title: 'Linked', instruction: 'Do it later' });
    const row = scheduler.schedule({ taskId: task.id, runAt: PAST, repeat: 'daily' });
    assert.equal(row.task_id, task.id);
    assert.equal(row.status, 'scheduled');
    assert.equal(row.repeat, 'daily');
    assert.throws(() => scheduler.schedule({ taskId: task.id, runAt: 'not-a-date' }), TypeError);
    assert.throws(() => scheduler.schedule({ taskId: 'missing-task-id', runAt: PAST }), /task_not_found/);
    assert.throws(() => scheduler.schedule({ title: '', instruction: 'x', runAt: PAST }), TypeError);
  } finally {
    cleanup();
  }
});

test('claimDue atomically flips only due rows to due', () => {
  const { scheduler, cleanup } = makeScheduler();
  try {
    const due = scheduler.schedule({ title: 'Due', instruction: 'run me', runAt: PAST });
    const later = scheduler.schedule({ title: 'Later', instruction: 'not yet', runAt: FUTURE });
    const claimed = scheduler.claimDue();
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, due.id);
    assert.equal(claimed[0].status, 'due');
    assert.equal(scheduler.get(due.id).status, 'due');
    assert.equal(scheduler.get(later.id).status, 'scheduled');
    // Second claim returns nothing: the flip already happened.
    assert.deepEqual(scheduler.claimDue(), []);
  } finally {
    cleanup();
  }
});

test('claimDue respects an explicit now boundary', () => {
  const { scheduler, cleanup } = makeScheduler();
  try {
    const row = scheduler.schedule({ title: 'Edge', instruction: 'boundary', runAt: FUTURE });
    assert.deepEqual(scheduler.claimDue(new Date(Date.now() - 1000).toISOString()), []);
    assert.equal(scheduler.get(row.id).status, 'scheduled');
    const claimed = scheduler.claimDue(new Date(Date.now() + 7200_000).toISOString());
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, row.id);
  } finally {
    cleanup();
  }
});

test('done and cancel follow valid transitions only', () => {
  const { scheduler, cleanup } = makeScheduler();
  try {
    const row = scheduler.schedule({ title: 'Work', instruction: 'do it', runAt: PAST });
    const [claimed] = scheduler.claimDue();
    assert.equal(claimed.id, row.id);
    const done = scheduler.done(row.id);
    assert.equal(done.status, 'done');
    assert.throws(() => scheduler.done(row.id), /cannot transition/);
    assert.throws(() => scheduler.cancel(row.id), /cannot transition/);
    const other = scheduler.schedule({ title: 'Scrapped', instruction: 'skip', runAt: FUTURE });
    const cancelled = scheduler.cancel(other.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(scheduler.claimDue(new Date(Date.now() + 7200_000).toISOString()), []);
    assert.throws(() => scheduler.done('no-such-id'), /schedule_not_found/);
  } finally {
    cleanup();
  }
});

test('scheduling never auto-runs: rows wait for claimDue', async () => {
  const { scheduler, cleanup } = makeScheduler();
  try {
    const row = scheduler.schedule({ title: 'Idle', instruction: 'wipe nothing', runAt: PAST });
    assert.equal(scheduler.get(row.id).status, 'scheduled');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(scheduler.get(row.id).status, 'scheduled');
    assert.equal(scheduler.list('scheduled').length, 1);
    assert.equal(scheduler.list('due').length, 0);
    assert.equal(scheduler.list().length, 1);
  } finally {
    cleanup();
  }
});

test('schedules persist in the SQLite table across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-scheduler-'));
  const store = new Store(join(dir, 'persist.sqlite'));
  try {
    const first = new Scheduler(store);
    const row = first.schedule({ title: 'Durable', instruction: 'survive', runAt: FUTURE });
    const second = new Scheduler(store);
    assert.deepEqual(second.get(row.id), row);
    assert.equal(second.list().length, 1);
  } finally {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
