import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Users } from '../src/users.mjs';
import { Store } from '../src/store.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';
import { Approvals } from '../src/approvals.mjs';

test('users: sign-up needs owner approval (approve / deny via Inbox), password check, Google requests, daily cap, chat isolation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-users-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const bus = new EventBus(); const chat = new ChatStore(store); const notifications = new Notifications(store, bus);
    const approvals = new Approvals({ store, notifications, chat, bus });
    const users = new Users({ store, approvals, bus });
    assert.throws(() => users.signupPassword({ name: 'A', email: 'bad', password: 'x'.repeat(12) }), /email/);
    assert.throws(() => users.signupPassword({ name: 'A', email: 'a@x.com', password: 'short' }), /10-200/);
    const a = users.signupPassword({ name: 'Aditya', email: 'Aditya@X.com', password: 'aditya-password-1' });
    assert.equal(a.status, 'pending');
    assert.throws(() => users.signupPassword({ name: 'A2', email: 'aditya@x.com', password: 'another-password' }), /exists/);
    const [req] = approvals.list();
    assert.equal(req.tool, 'user_approve'); assert.match(req.summary, /Aditya <aditya@x.com>/);
    assert.ok(notifications.list().some((n) => /Approval needed/.test(n.title)), 'owner is notified');
    assert.equal(users.checkPassword('aditya@x.com', 'aditya-password-1').status, 'pending');
    assert.equal(users.checkPassword('aditya@x.com', 'wrong-password-x'), null);
    await approvals.decide(req.id, true);
    assert.equal(users.get(a.id).status, 'approved');
    const g = users.fromGoogle({ email: 'kanak@gmail.com', name: 'Kanak' });
    assert.equal(g.status, 'pending'); assert.equal(users.fromGoogle({ email: 'KANAK@gmail.com' }).id, g.id, 'same person, one request');
    const greq = approvals.list().find((x) => x.payload.userId === g.id);
    await approvals.decide(greq.id, false);
    assert.equal(users.get(g.id).status, 'rejected');
    for (let i = 0; i < 3; i++) assert.equal(users.takeMessage(a.id, 3), true);
    assert.equal(users.takeMessage(a.id, 3), false, 'daily cap');
    const mine = chat.createConversation('owner chat'); const theirs = chat.createConversation('aditya chat', a.id);
    assert.deepEqual(chat.listConversations().map((c) => c.id), [mine.id]);
    assert.deepEqual(chat.listConversations(a.id).map((c) => c.id), [theirs.id]);
    assert.equal(chat.owns(mine.id, a.id), false); assert.equal(chat.owns(theirs.id, a.id), true); assert.equal(chat.owns(theirs.id, null), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
