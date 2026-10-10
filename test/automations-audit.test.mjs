import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Automations } from '../src/automations.mjs';
import { Audit } from '../src/audit.mjs';

function setup(name) {
  const dir = mkdtempSync(join(tmpdir(), name));
  const store = new Store(join(dir, 'db.sqlite'));
  return { dir, store, automations: new Automations(store), audit: new Audit(store) };
}

function teardown({ dir, store }) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

const BASE = {
  owner: 'user',
  trigger: { kind: 'build_failed' },
  capabilities: ['notify', 'diagnose-draft'],
};

test('scope validation rejects unknown trigger kinds', () => {
  const ctx = setup('friday-auto-');
  try {
    assert.throws(
      () => ctx.automations.create({ ...BASE, trigger: { kind: 'email_received' } }),
      /invalid trigger kind/,
    );
    assert.throws(() => ctx.automations.fire('email_received'), /invalid trigger kind/);
  } finally {
    teardown(ctx);
  }
});

test('scope validation rejects write-like capabilities and empty scopes', () => {
  const ctx = setup('friday-auto-');
  try {
    for (const bad of ['send', 'exec', 'write', 'delete', 'publish', 'commit', 'shell']) {
      assert.throws(
        () => ctx.automations.create({ ...BASE, capabilities: [bad] }),
        /forbidden capability/,
        bad,
      );
    }
    assert.throws(() => ctx.automations.create({ ...BASE, capabilities: [] }), /non-empty/);
    assert.throws(() => ctx.automations.create({ ...BASE, capabilities: 'notify' }), /non-empty/);
    const ok = ctx.automations.create(BASE);
    assert.deepEqual(ok.capabilities, ['notify', 'diagnose-draft']);
    assert.equal(ok.killSwitch, true);
  } finally {
    teardown(ctx);
  }
});

test('schedule triggers require at; event triggers reject at', () => {
  const ctx = setup('friday-auto-');
  try {
    assert.throws(
      () => ctx.automations.create({ ...BASE, trigger: { kind: 'schedule' } }),
      /requires 'at'/,
    );
    assert.throws(
      () => ctx.automations.create({ ...BASE, trigger: { kind: 'schedule', at: 'not-a-date' } }),
      /requires 'at'/,
    );
    assert.throws(
      () =>
        ctx.automations.create({
          ...BASE,
          trigger: { kind: 'download_done', at: '2026-09-20T10:00:00.000Z' },
        }),
      /does not accept 'at'/,
    );
    // Past schedule time is due; future schedule time is not yet due.
    const now = '2026-09-20T15:00:00.000Z';
    ctx.automations.create({
      ...BASE,
      trigger: { kind: 'schedule', at: '2026-09-20T10:00:00.000Z' },
    });
    ctx.automations.create({
      ...BASE,
      trigger: { kind: 'schedule', at: '2026-09-21T10:00:00.000Z' },
    });
    assert.equal(ctx.automations.fire({ kind: 'schedule' }, { now }).length, 1);
  } finally {
    teardown(ctx);
  }
});

test('expired automations never fire, and bad expiry is rejected', () => {
  const ctx = setup('friday-auto-');
  try {
    assert.throws(() => ctx.automations.create({ ...BASE, expiresAt: 'yesterday-ish' }), /expiresAt/);
    ctx.automations.create({ ...BASE, expiresAt: '2020-01-01T00:00:00.000Z' });
    assert.deepEqual(ctx.automations.fire('build_failed'), []);
    const live = ctx.automations.create({ ...BASE, expiresAt: '2030-01-01T00:00:00.000Z' });
    assert.equal(ctx.automations.fire('build_failed').length, 1);
    assert.equal(ctx.automations.fire('build_failed', { now: '2031-01-01T00:00:00.000Z' }).length, 0);
    assert.equal(live.expiresAt, '2030-01-01T00:00:00.000Z');
  } finally {
    teardown(ctx);
  }
});

test('frequency cap: maxPerDay limits dispatches per UTC day', () => {
  const ctx = setup('friday-auto-');
  try {
    const now = '2026-09-20T15:00:00.000Z';
    const auto = ctx.automations.create({ ...BASE, maxPerDay: 1 });
    assert.equal(ctx.automations.fire('build_failed', { now }).length, 1);
    ctx.automations.dispatch(auto.id, { now });
    assert.deepEqual(ctx.automations.fire('build_failed', { now }), []);
    assert.throws(() => ctx.automations.dispatch(auto.id, { now }), /frequency cap/);
    // Quota resets the next UTC day.
    assert.equal(ctx.automations.fire('build_failed', { now: '2026-09-21T00:00:01.000Z' }).length, 1);
    assert.throws(() => ctx.automations.create({ ...BASE, maxPerDay: 0 }), /maxPerDay/);
  } finally {
    teardown(ctx);
  }
});

test('quiet hours suppress firing only inside the window', () => {
  const ctx = setup('friday-auto-');
  try {
    ctx.automations.create({
      ...BASE,
      quietHours: { start: '11:00', end: '13:00' },
    });
    assert.deepEqual(
      ctx.automations.fire('build_failed', { now: '2026-09-20T12:00:00.000Z' }),
      [],
    );
    assert.equal(
      ctx.automations.fire('build_failed', { now: '2026-09-20T15:00:00.000Z' }).length,
      1,
    );
    assert.throws(
      () => ctx.automations.create({ ...BASE, quietHours: { start: '25:00', end: '13:00' } }),
      /HH:MM/,
    );
  } finally {
    teardown(ctx);
  }
});

test('kill by id revokes one automation; kill by owner revokes the rest', () => {
  const ctx = setup('friday-auto-');
  try {
    const first = ctx.automations.create(BASE);
    const second = ctx.automations.create(BASE);
    ctx.automations.create({ ...BASE, owner: 'other' });
    assert.deepEqual(ctx.automations.kill(first.id), { revoked: 1, ids: [first.id] });
    assert.equal(ctx.automations.get(first.id).revoked, true);
    assert.equal(ctx.automations.fire('build_failed').length, 2);
    assert.deepEqual(ctx.automations.kill('user'), { revoked: 1, ids: [second.id] });
    const remaining = ctx.automations.fire('build_failed');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].owner, 'other');
    const stopped = ctx.automations.killAll();
    assert.equal(stopped.revoked, 1);
    assert.deepEqual(ctx.automations.fire('build_failed'), []);
  } finally {
    teardown(ctx);
  }
});

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
