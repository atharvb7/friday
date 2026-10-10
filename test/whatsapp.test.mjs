// test/whatsapp.test.mjs — WhatsAppFlow staging/commit without network.
// Recipients come from a temp contacts.json (exact-id allowlist); files are
// temp files; the effects ledger is a temp sqlite Store. No Nazarick login.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { WhatsAppFlow, MAX_FILE_BYTES } from '../src/whatsapp.mjs';

function setup(contacts = [{ id: 'alice' }, { id: 'alice.smith' }, { id: 'bob' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-wa-'));
  const contactsPath = join(dir, 'contacts.json');
  writeFileSync(contactsPath, JSON.stringify(contacts));
  const file = join(dir, 'pic.jpg');
  writeFileSync(file, 'fake-image-bytes');
  const store = new Store(join(dir, 'db.sqlite'));
  const effects = new Effects(store);
  const task = store.createTask({ title: 'WA test', instruction: 'test only' });
  const flow = new WhatsAppFlow({ effects, taskId: task.id, contactsPath });
  return { dir, contactsPath, file, store, effects, task, flow };
}

test('ambiguous recipient is blocked; exact id passes', () => {
  const ctx = setup();
  try {
    assert.throws(() => ctx.flow.stage('ali', ctx.file), /ambiguous_recipient/);
    assert.throws(() => ctx.flow.stage('nobody', ctx.file), /unknown_recipient/);
    const staged = ctx.flow.stage('alice', ctx.file, 'hi');
    assert.equal(staged.staged, true);
    assert.equal(staged.sent, false);
    assert.equal(staged.preview.recipient, 'alice');
    assert.ok(staged.approvalToken);
    assert.ok(staged.exactArgs.hash);
  } finally {
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('stage validates file exists and enforces 16MB cap', () => {
  const ctx = setup();
  try {
    assert.throws(() => ctx.flow.stage('bob', join(ctx.dir, 'missing.bin')), /file_not_found/);
    assert.throws(() => ctx.flow.stage('bob', 'relative/path.bin'), /absolute/);
    const big = join(ctx.dir, 'big.bin');
    writeFileSync(big, 'x');
    truncateSync(big, MAX_FILE_BYTES + 1); // sparse: no 17MB write
    assert.throws(() => ctx.flow.stage('bob', big), /file_too_large/);
  } finally {
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('approval binds exact args: tampered commit is rejected', async () => {
  const ctx = setup();
  try {
    const staged = ctx.flow.stage('bob', ctx.file, 'cap');
    const tampered = { ...staged.exactArgs, caption: 'evil-edit' };
    await assert.rejects(ctx.flow.commit(staged.effectId, staged.approvalToken, tampered), /arguments changed/);
    await assert.rejects(ctx.flow.commit(staged.effectId, 'wrong-token', staged.exactArgs), /invalid approval/);
  } finally {
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('commit without login readiness resolves verified_failure, never sends', async () => {
  const ctx = setup();
  const prev = process.env.FRIDAY_WHATSAPP_READY;
  delete process.env.FRIDAY_WHATSAPP_READY;
  try {
    const staged = ctx.flow.stage('bob', ctx.file);
    const done = await ctx.flow.commit(staged.effectId, staged.approvalToken, staged.exactArgs);
    assert.equal(done.status, 'verified_failure');
    assert.equal(done.receipt.error, 'whatsapp_not_logged_in');
    assert.equal(done.receipt.sent, false);
  } finally {
    if (prev === undefined) delete process.env.FRIDAY_WHATSAPP_READY;
    else process.env.FRIDAY_WHATSAPP_READY = prev;
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('rate limit: second commit within a minute is rejected', async () => {
  const ctx = setup();
  const prev = process.env.FRIDAY_WHATSAPP_READY;
  delete process.env.FRIDAY_WHATSAPP_READY;
  try {
    const a = ctx.flow.stage('bob', ctx.file);
    await ctx.flow.commit(a.effectId, a.approvalToken, a.exactArgs);
    const b = ctx.flow.stage('bob', ctx.file);
    await assert.rejects(ctx.flow.commit(b.effectId, b.approvalToken, b.exactArgs), /rate_limited/);
  } finally {
    if (prev === undefined) delete process.env.FRIDAY_WHATSAPP_READY;
    else process.env.FRIDAY_WHATSAPP_READY = prev;
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('crash between beginCommit and resolve stays effect_unknown (no blind resend)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-wa-crash-'));
  try {
    let store = new Store(join(dir, 'db.sqlite'));
    let effects = new Effects(store);
    const task = store.createTask({ title: 'WA crash', instruction: 'test' });
    const effect = effects.propose(task.id, 'whatsapp.send', { recipient: 'bob', file: '/x', size: 1, hash: 'h', caption: '' });
    effects.stage(effect.id, { recipient: 'bob', file: '/x', size: 1, hash: 'h', caption: '' });
    const { token } = effects.requestApproval(effect.id);
    effects.approve(effect.id, token, { recipient: 'bob', file: '/x', size: 1, hash: 'h', caption: '' });
    effects.beginCommit(effect.id, { recipient: 'bob', file: '/x', size: 1, hash: 'h', caption: '' });
    store.close(); // simulate crash before resolve
    store = new Store(join(dir, 'db.sqlite'));
    effects = new Effects(store);
    assert.equal(effects.get(effect.id).status, 'effect_unknown');
    assert.throws(() => effects.beginCommit(effect.id, { recipient: 'bob', file: '/x', size: 1, hash: 'h', caption: '' }), /must be approved/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
