import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { DueRunner } from '../src/scheduler-runner.mjs';

function makeStack({ governor } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-due-runner-'));
  const store = new Store(join(dir, 'due-runner.sqlite'));
  const scheduler = new Scheduler(store);
  const gov =
    governor ??
    ({
      sample: () => ({ mode: 'normal' }),
      canAdmit: () => ({ allowed: true, reason: 'admitted', mode: 'normal' }),
    });
  const calls = [];
  const runner = new DueRunner({ store, scheduler, governor: gov, onTask: (h) => calls.push(h) });
  return { dir, store, scheduler, runner, calls, cleanup: () => { try { runner.stop(); } catch {} try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PAST = new Date(Date.now() - 60_000).toISOString();

test('due schedules hand off to the queued task + onTask (no effect execution)', () => {
  const { scheduler, store, runner, calls, cleanup } = makeStack();
  try {
    const row = scheduler.schedule({ title: 'Due job', instruction: 'do the thing', runAt: PAST });
    assert.equal(scheduler.get(row.id).status, 'scheduled');
    const handed = runner.claimDue();
    assert.equal(handed.length, 1);
    assert.equal(handed[0].schedule.id, row.id);
    // Scheduler row flipped to due; linked task is queued for WorkerLoop.
    assert.equal(scheduler.get(row.id).status, 'due');
    const task = store.getTask(row.task_id);
    assert.ok(task);
    assert.equal(task.status, 'queued');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task.id, task.id);
    // Runner never runs effects: task stays queued (not running/completed),
    // and no effects module is involved.
    assert.equal(store.getTask(task.id).status, 'queued');
  } finally {
    cleanup();
  }
});

test('governor-blocked rows stay scheduled and onTask is not called', () => {
  const blockedGov = {
    sample: () => ({ mode: 'constrained' }),
    canAdmit: () => ({ allowed: false, reason: 'memory_pressure', mode: 'constrained' }),
  };
  const { scheduler, runner, calls, cleanup } = makeStack({ governor: blockedGov });
  try {
    const row = scheduler.schedule({ title: 'Blocked', instruction: 'wait', runAt: PAST });
    const handed = runner.runOnce();
    assert.deepEqual(handed, []);
    assert.equal(scheduler.get(row.id).status, 'scheduled');
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('emergency mode claims nothing and leaves rows scheduled', () => {
  const emergencyGov = {
    sample: () => ({ mode: 'emergency' }),
    canAdmit: () => ({ allowed: false, reason: 'memory_emergency', mode: 'emergency' }),
  };
  const { scheduler, runner, calls, cleanup } = makeStack({ governor: emergencyGov });
  try {
    const row = scheduler.schedule({ title: 'E', instruction: 'hold', runAt: PAST });
    assert.deepEqual(runner.pollOnce(), []);
    assert.equal(scheduler.get(row.id).status, 'scheduled');
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('start/stop manage a 30s unref’d poller; default onTask only logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-due-runner-'));
  const store = new Store(join(dir, 'x.sqlite'));
  const scheduler = new Scheduler(store);
  const gov = { sample: () => ({ mode: 'normal' }), canAdmit: () => ({ allowed: true }) };
  const runner = new DueRunner({ store, scheduler, governor: gov });
  try {
    assert.equal(runner.pollMs, 30_000);
    const handle = runner.start();
    assert.equal(handle.started, true);
    assert.ok(runner.timer);
    // Timer must not hold the process open.
    assert.equal(typeof runner.timer.unref === 'function' ? runner.timer.hasRef?.() ?? false : false, false);
    const stopped = runner.stop();
    assert.equal(stopped.stopped, true);
    assert.equal(runner.timer, null);
    // Default onTask logs only and never executes effects.
    const row = scheduler.schedule({ title: 'Log only', instruction: 'noop', runAt: PAST });
    const handed = runner.claimDue(); // uses default onTask (console.log)
    assert.equal(handed.length, 1);
    assert.equal(store.getTask(row.task_id).status, 'queued');
  } finally {
    try { runner.stop(); } catch {}
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler-runner is a pure handoff: no effect/adapter execution imports', () => {
  const src = readFileSync(new URL('../src/scheduler-runner.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const pat of [
    /from\s+['"]\.\/effects\.mjs['"]/,
    /from\s+['"]\.\/worker\.mjs['"]/,
    /\badapter\.run\b/,
    /\bclaimNextQueuedTask\b/,
    /\btransition\s*\(\s*task/,
  ]) {
    assert.doesNotMatch(code, pat, `runner must not execute effects (${pat})`);
  }
});
