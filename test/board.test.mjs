import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';
import { ChatStore } from '../src/chat.mjs';
import { Approvals } from '../src/approvals.mjs';
import { Recs } from '../src/recs.mjs';
import { Commitments } from '../src/commitments.mjs';
import { buildBoard, shouldPush, pushPolicy } from '../src/board.mjs';

test('board: one list of what waits on the owner, decisions first, critical on top; push policy holds back only completions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-board-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const settings = new Settings(store); const bus = new EventBus();
    const notifications = new Notifications(store, bus); const chat = new ChatStore(store);
    const approvals = new Approvals({ store, notifications, chat, bus });
    const recs = new Recs({ store, settings });
    const commitments = new Commitments({ store, settings });
    const ctx = {
      store, approvals, recs, commitments,
      questions: { pending: () => [{ id: 'q1', question: 'Which date works for the dentist?', field: null, created_at: '2026-11-01T05:00:00.000Z' }] },
      loops: { list: () => [{ name: 'pipeline', status: 'down', last_error: 'imap timeout', failing_since: '2026-11-01T04:00:00.000Z' }, { name: 'jobs', status: 'ok' }] },
    };
    approvals.request({ category: 'messaging', risk: 'consequential', tool: 'send', summary: 'Email Acme', payload: { a: 1 } });
    approvals.request({ category: 'money', risk: 'critical', tool: 'pay', summary: 'Pay ₹4,000 invoice', payload: { b: 2 } });
    recs.add({ title: 'Pitch freight forwarders in Pune', because: '3 of 4 had manual quote forms', expect: '2 replies from 15' });
    commitments.add({ title: 'Submit lab manual', due: '2020-01-01' });
    for (let i = 0; i < 7; i++) commitments.add({ title: `old thing ${i}`, due: `2019-0${i + 1}-01` });
    const b = buildBoard(ctx, { now: Date.now() });
    assert.equal(b.count, 11);
    assert.deepEqual(b.cards.map((c) => c.kind), ['approval', 'approval', 'rec', 'question', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo_more', 'loop']);
    assert.equal(b.cards.find((c) => c.kind === 'todo').title, 'Submit lab manual', 'most recently due first');
    assert.equal(b.cards.find((c) => c.kind === 'todo_more').title, '3 more overdue to-dos');
    assert.equal(b.cards[0].title, 'Pay ₹4,000 invoice', 'critical first');
    assert.ok(!b.cards.some((c) => c.title.includes('jobs')), 'healthy loops are not cards');

    assert.equal(pushPolicy(settings), 'all');
    assert.equal(shouldPush('all', { level: 'success' }), true);
    settings.set('push_policy', 'needs_you');
    assert.equal(pushPolicy(settings), 'needs_you');
    assert.equal(shouldPush('needs_you', { level: 'success', title: 'Done: research' }), false);
    for (const level of ['info', 'warning', 'error']) assert.equal(shouldPush('needs_you', { level }), true, level);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
