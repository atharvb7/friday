import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Audit } from '../src/audit.mjs';

function setup(name) {
  const dir = mkdtempSync(join(tmpdir(), name));
  const store = new Store(join(dir, 'db.sqlite'));
  return { dir, store, audit: new Audit(store) };
}

function teardown({ dir, store }) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

test('audit chain verifies across appends with linked hashes', () => {
  const ctx = setup('friday-audit-');
  try {
    const first = ctx.audit.append('task-1', 'task.created', { title: 'hello' });
    const second = ctx.audit.append('task-1', 'task.running', {});
    const third = ctx.audit.append('task-2', 'effect.proposed', { kind: 'message.send' });
    assert.equal(first.prevHash, 'GENESIS');
    assert.equal(second.prevHash, first.hash);
    assert.equal(third.prevHash, second.hash);
    assert.deepEqual(ctx.audit.verify(), { ok: true });
    assert.equal(ctx.audit.length(), 3);
  } finally {
    teardown(ctx);
  }
});

test('audit verify detects tampering and reports the bad row', () => {
  const ctx = setup('friday-audit-');
  try {
    ctx.audit.append('task-1', 'task.created', { title: 'hello' });
    const victim = ctx.audit.append('task-1', 'task.running', { honest: true });
    ctx.audit.append('task-1', 'task.completed', { result: 'done' });
    ctx.store.db
      .prepare('UPDATE audit_chain SET detail=? WHERE id=?')
      .run(JSON.stringify({ honest: false }), victim.id);
    const verdict = ctx.audit.verify();
    assert.equal(verdict.ok, false);
    assert.equal(verdict.badIndex, victim.id);
  } finally {
    teardown(ctx);
  }
});

test('audit redacts NVIDIA_API_KEY, DSH_* entries, and Bearer tokens', () => {
  const ctx = setup('friday-audit-');
  try {
    const entry = ctx.audit.append('task-9', 'effect.proposed', {
      NVIDIA_API_KEY: 'nvapi-super-secret-key-123',
      DSH_TOKEN: 'harness-secret',
      DSH_SESSION: 'session-secret',
      nested: { password: 'hunter2', safe: 'visible' },
      note: 'call with Bearer abcdef12345 now',
    });
    assert.deepEqual(entry.detail, {
      NVIDIA_API_KEY: '[REDACTED]',
      DSH_TOKEN: '[REDACTED]',
      DSH_SESSION: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'visible' },
      note: 'call with Bearer [REDACTED] now',
    });
    const raw = ctx.store.db
      .prepare('SELECT detail FROM audit_chain WHERE id=?')
      .get(entry.id).detail;
    for (const leak of ['nvapi-super-secret', 'harness-secret', 'session-secret', 'hunter2', 'abcdef12345']) {
      assert.doesNotMatch(raw, new RegExp(leak));
    }
    assert.deepEqual(ctx.audit.verify(), { ok: true });
  } finally {
    teardown(ctx);
  }
});
