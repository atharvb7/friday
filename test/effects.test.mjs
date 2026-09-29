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
