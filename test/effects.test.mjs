import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';

test('effect approval binds exact arguments and is single-use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-effects-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const effects = new Effects(store);
    const task = store.createTask({ title: 'Send file', instruction: 'Test only' });
    const args = { recipient: 'john-id', fileHash: 'abc123' };
    const effect = effects.propose(task.id, 'message.send', args);
    effects.stage(effect.id, args);
    const { token } = effects.requestApproval(effect.id);
    assert.throws(() => effects.approve(effect.id, token, { recipient: 'jane-id', fileHash: 'abc123' }), /arguments changed/);
    effects.approve(effect.id, token, args);
    assert.throws(() => effects.approve(effect.id, token, args), /must be awaiting_approval/);
    effects.beginCommit(effect.id, args);
    effects.resolve(effect.id, 'verified_success', { observed: true });
    assert.equal(effects.get(effect.id).status, 'verified_success');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit interrupted by a crash becomes unknown, never approved for retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-effects-'));
  try {
    let store = new Store(join(dir, 'db.sqlite'));
    let effects = new Effects(store);
    const task = store.createTask({ title: 'Send file', instruction: 'Test only' });
    const args = { recipient: 'john-id' };
    const effect = effects.propose(task.id, 'message.send', args);
    effects.stage(effect.id, args);
    const { token } = effects.requestApproval(effect.id);
    effects.approve(effect.id, token, args);
    effects.beginCommit(effect.id, args);
    store.close();
    store = new Store(join(dir, 'db.sqlite'));
    effects = new Effects(store);
    assert.equal(effects.get(effect.id).status, 'effect_unknown');
    assert.throws(() => effects.beginCommit(effect.id, args), /must be approved/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ledger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-effects-'));
  const path = join(dir, 'db.sqlite');
  const store = new Store(path);
  try { return fn({ store, effects: new Effects(store), path }); }
  finally { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}

function approved(effects, task, args) {
  const effect = effects.propose(task.id, 'message.send', args);
  effects.stage(effect.id, args);
  const { token } = effects.requestApproval(effect.id);
  return { effect, token };
}

test('a cancelled task can neither commit an approved effect nor collect a new approval', () => ledger(({ store, effects }) => {
  const task = store.createTask({ title: 'Send', instruction: 'Test only' });
  const args = { recipient: 'john-id' };
  const first = approved(effects, task, args);
  effects.approve(first.effect.id, first.token, args);
  const second = approved(effects, task, args);
  assert.equal(store.transition(task.id, 'cancelled').error, undefined);
  assert.throws(() => effects.beginCommit(first.effect.id, args), /task is cancelled/);
  assert.equal(effects.get(first.effect.id).status, 'approved');
  assert.throws(() => effects.approve(second.effect.id, second.token, args), /task is cancelled/);
  assert.equal(effects.get(second.effect.id).status, 'awaiting_approval');
}));

test('an approved effect must be committed within its commit window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-effects-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const effects = new Effects(store, { commitWindowMs: 5 });
    const task = store.createTask({ title: 'Send', instruction: 'Test only' });
    const args = { recipient: 'john-id' };
    const { effect, token } = approved(effects, task, args);
    assert.ok(effects.approve(effect.id, token, args).commit_by);
    await new Promise((r) => setTimeout(r, 20));
    assert.throws(() => effects.beginCommit(effect.id, args), /commit window expired/);
    assert.equal(effects.get(effect.id).status, 'expired');
    assert.throws(() => effects.beginCommit(effect.id, args), /must be approved/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an effect left unknown by a crash can be settled after inspection, but never re-run', () => ledger(({ store, path }) => {
  let effects = new Effects(store);
  const task = store.createTask({ title: 'Send', instruction: 'Test only' });
  const args = { recipient: 'john-id' };
  const { effect, token } = approved(effects, task, args);
  effects.approve(effect.id, token, args);
  effects.beginCommit(effect.id, args);
  store.close();
  const reopened = new Store(path);
  try {
    effects = new Effects(reopened);
    assert.equal(effects.get(effect.id).status, 'effect_unknown');
    assert.throws(() => effects.resolve(effect.id, 'effect_unknown', { checked: true }), /already effect_unknown/);
    assert.throws(() => effects.resolve(effect.id, 'verified_failure'), /receipt required/);
    effects.resolve(effect.id, 'verified_failure', { inspected: 'message never arrived' });
    assert.equal(effects.get(effect.id).status, 'verified_failure');
    assert.deepEqual(effects.get(effect.id).receipt, { inspected: 'message never arrived' });
    assert.throws(() => effects.beginCommit(effect.id, args), /must be approved/);
    assert.throws(() => effects.resolve(effect.id, 'verified_success', { again: true }), /must be committing or effect_unknown/);
  } finally { reopened.close(); }
}));

test('an expired approval is closed, on approve and on restart', () => ledger(({ store, path }) => {
  let effects = new Effects(store);
  const task = store.createTask({ title: 'Send', instruction: 'Test only' });
  const args = { recipient: 'john-id' };
  const late = approved(effects, task, args);
  const idle = approved(effects, task, args);
  const past = new Date(Date.now() - 1000).toISOString();
  store.db.prepare('UPDATE effects SET approval_expires_at=? WHERE id IN (?, ?)').run(past, late.effect.id, idle.effect.id);
  assert.throws(() => effects.approve(late.effect.id, late.token, args), /approval expired/);
  assert.equal(effects.get(late.effect.id).status, 'expired');
  assert.equal(effects.get(idle.effect.id).status, 'awaiting_approval');
  store.close();
  const reopened = new Store(path);
  try {
    effects = new Effects(reopened);
    assert.equal(effects.get(idle.effect.id).status, 'expired');
  } finally { reopened.close(); }
}));
