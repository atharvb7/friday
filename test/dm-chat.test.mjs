import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DmChats } from '../src/dm-chat.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-dm-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const bus = new EventBus(); const settings = new Settings(store); const chat = new ChatStore(store);
  settings.set('user_name', 'Atharv');
  const notifications = new Notifications(store, bus);
  const convs = [
    { id: 'grp', participants: { data: [{ id: 'me', username: 'atharv' }, { id: '258', username: 'pandeyy.jr' }, { id: '9', username: 'x' }] } },
    { id: 'dm1', participants: { data: [{ id: 'me', username: 'atharv' }, { id: '258', username: 'pandeyy.jr' }] } },
  ];
  let msgs = [{ id: 'm1', from: { id: 'me' }, message: 'Hey Aditya! I am Friday' }];
  const composio = { execute: async (_t, action, args) => {
    if (action === 'LIST_ALL_CONVERSATIONS') return { data: { data: convs } };
    if (action === 'LIST_ALL_MESSAGES') { assert.equal(args.conversation_id, 'dm1', 'always the 1:1 thread, never the group'); return { data: { data: msgs } }; }
    return { error: 'unexpected' };
  } };
  const sent = []; let nodeFails = false;
  const nodes = { dispatch: async ({ action, args }) => { if (nodeFails) throw new Error('instagram_login_required'); sent.push({ action, ...args }); return { sent: true }; } };
  const replies = [];
  const ai = { run: async (_r, { messages }) => { replies.push(messages); return { content: JSON.stringify(replies.length === 2 ? { reply: '', needs_owner: 'Aditya wants to meet tomorrow', end: true } : { reply: 'Haha bc = batch crew? 😄 How is college?', needs_owner: null, end: false }) }; } };
  let now = Date.parse('2026-10-11T10:30:00Z');
  const dm = new DmChats({ store, ai, composio, nodes, chat, notifications, bus, settings, now: () => now });
  const conv = chat.createConversation('t');
  return { dm, sent, replies, conv, chat, notifications, setMsgs: (m) => { msgs = m; }, fail: (v) => { nodeFails = v; }, advance: (ms) => { now += ms; }, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('dm chat: finds the 1:1 thread (not a group), ignores old messages, replies to new ones via the verified laptop send, reports to the owner', async () => {
  const r = rig();
  try {
    const out = await r.dm.start({ usernames: ['@Pandeyy.jr'], minutes: 30, goal: 'be playful', conversationId: r.conv.id });
    assert.equal(out[0].username, 'pandeyy.jr');
    await r.dm.tick();
    assert.equal(r.sent.length, 0, 'the existing (own) message is not answered');
    r.setMsgs([{ id: 'm2', from: { id: '258' }, message: 'woah bc legend' }, { id: 'm1', from: { id: 'me' }, message: 'Hey Aditya!' }]);
    await r.dm.tick();
    assert.deepEqual(r.sent, [{ action: 'ig_dm_send', username: 'pandeyy.jr', text: 'Haha bc = batch crew? 😄 How is college?' }]);
    const sys = r.replies[0][0].content;
    assert.match(sys, /openly an AI assistant/); assert.match(sys, /Never share private info about Atharv/); assert.match(sys, /no romantic flirting/);
    assert.match(r.chat.listMessages(r.conv.id).at(-1).content, /@pandeyy\.jr:\*\* woah bc legend[\s\S]*\*\*Me:\*\* Haha/);
    await r.dm.tick();
    assert.equal(r.sent.length, 1, 'same message never answered twice');
    r.setMsgs([{ id: 'm3', from: { id: '258' }, message: 'lets meet tmrw?' }, { id: 'm2', from: { id: '258' }, message: 'woah' }]);
    await r.dm.tick();
    assert.equal(r.sent.length, 1, 'model chose not to reply');
    assert.ok(r.notifications.list().some((n) => /needs you/.test(n.title)), 'owner told when they need him');
    assert.equal(r.dm.list('active').length, 0, 'chat ended');
  } finally { r.done(); }
});

test('dm chat: time limit, stop, unknown usernames, failed laptop send is reported', async () => {
  const r = rig();
  try {
    assert.equal((await r.dm.start({ usernames: ['nobody'], conversationId: r.conv.id }))[0].error.includes('no 1:1'), true);
    await assert.rejects(() => r.dm.start({ usernames: ['bad name!'] }), /invalid username/);
    await r.dm.start({ usernames: ['pandeyy.jr'], minutes: 10, conversationId: r.conv.id, introText: 'Hi!' });
    assert.equal(r.sent[0].text, 'Hi!');
    r.fail(true);
    r.setMsgs([{ id: 'm9', from: { id: '258' }, message: 'yo' }]);
    await r.dm.tick();
    assert.match(r.chat.listMessages(r.conv.id).at(-1).content, /Couldn't send my reply[\s\S]*instagram_login_required/);
    r.advance(11 * 60_000); await r.dm.tick();
    assert.equal(r.dm.list('active').length, 0);
    assert.match(r.chat.listMessages(r.conv.id).at(-1).content, /time is up/);
    await r.dm.start({ usernames: ['pandeyy.jr'], conversationId: r.conv.id });
    assert.equal(r.dm.stop(), 1);
  } finally { r.done(); }
});
