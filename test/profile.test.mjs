import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerAgent } from '../src/agent/computer-agent.mjs';
import { Profile } from '../src/profile.mjs';
import { Questions } from '../src/questions.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';
import { Policy } from '../src/policy.mjs';
import { Approvals } from '../src/approvals.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-prof-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const bus = new EventBus(); const settings = new Settings(store); const chat = new ChatStore(store);
  const notifications = new Notifications(store, bus);
  const policy = new Policy({ settings, bus });
  const approvals = new Approvals({ store, notifications, chat, bus });
  const profile = new Profile({ settings });
  const questions = new Questions({ store, chat, notifications, bus, profile });
  const sent = [];
  const nodes = { online: true, dispatch: async ({ action, args }) => { if (!(action === 'browser_snapshot' && args?.settleMs)) sent.push({ action, args }); return { ok: true, echo: args?.text ?? null }; } };
  const script = []; const ai = { hasProvider: true, run: async () => script.shift() };
  const call = (name, args) => ({ id: `c${Math.random()}`, name, args, argumentsText: JSON.stringify(args) });
  const agent = new ComputerAgent({ ai, nodes, policy, approvals, bus, profile, questions, sleep: async () => {} });
  return { store, profile, questions, approvals, agent, sent, script, call, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const turn = (calls) => ({ content: '', toolCalls: calls, usage: { total_tokens: 1 } });
const end = (t) => ({ content: t, toolCalls: [], usage: { total_tokens: 1 } });

test('profile: validates, stores, substitutes, redacts, name falls back to user_name', () => {
  const r = rig();
  try {
    r.profile.settings.set('user_name', 'Atharv');
    assert.equal(r.profile.all().name, 'Atharv');
    assert.throws(() => r.profile.set('phone', 'abc'));
    r.profile.set('phone', '+91 98765 43210');
    assert.deepEqual(r.profile.substitute('{{profile.name}} {{profile.phone}}'), { text: 'Atharv +919876543210', missing: [] });
    assert.deepEqual(r.profile.substitute('{{profile.email}}').missing, ['email']);
    assert.ok(!r.profile.redact('call +919876543210').includes('9876543210'));
    assert.equal(r.profile.knownFields().phone, 'known');
  } finally { r.done(); }
});

test('computer agent asks for an unknown phone, pauses, saves the answer, then types the real value without the model seeing it', async () => {
  const r = rig();
  try {
    r.profile.set('name', 'Atharv');
    r.script.push(
      turn([r.call('ask_user', { question: 'What number should I use?', field: 'phone' })]),
      turn([r.call('browser_type', { ref: 4, text: '{{profile.phone}}', intent: 'navigate' })]),
      end('Filled it.'));
    const p = r.agent.run({ taskId: 't', instruction: 'book', meta: { grant: true } });
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(r.sent.length, 0, 'paused before typing');
    const [q] = r.questions.pending();
    assert.equal(q.field, 'phone');
    r.questions.answer(q.id, '9876543210');
    assert.equal((await p).status, 'completed');
    assert.equal(r.sent[0].args.text, '9876543210', 'real value typed');
    assert.equal(r.profile.all().phone, '9876543210', 'remembered');
    assert.equal(r.questions.pending().length, 0);
  } finally { r.done(); }
});

test('typing an unknown placeholder is refused; ask_user for a known field is short-circuited', async () => {
  const r = rig();
  try {
    r.script.push(turn([r.call('browser_type', { ref: 1, text: '{{profile.phone}}', intent: 'navigate' })]), end('x'));
    await r.agent.run({ taskId: 't', instruction: 'x', meta: { grant: true } });
    assert.equal(r.sent.length, 0);
    r.profile.set('phone', '9876543210');
    r.script.push(turn([r.call('ask_user', { question: 'number?', field: 'phone' })]), end('ok'));
    await r.agent.run({ taskId: 't2', instruction: 'x', meta: { grant: true } });
    assert.equal(r.questions.pending().length, 0);
  } finally { r.done(); }
});

test('autoSubmit lets the final confirm through; purchases still ask', () => {
  const r = rig();
  try {
    assert.equal(r.agent.decision('browser_click', { intent: 'submit_external' }, true, '', false).decision, 'ask');
    assert.equal(r.agent.decision('browser_click', { intent: 'submit_external' }, true, '', true).decision, 'allow');
    assert.equal(r.agent.decision('browser_click', { intent: 'purchase' }, true, '', true).decision, 'ask');
  } finally { r.done(); }
});

test('mustShow blocks a final submit on the wrong business, allows the right one', async () => {
  const r = rig();
  let page = 'Adhunik Hair Salon';
  r.agent.nodes.dispatch = async ({ action }) => (action === 'browser_snapshot' ? { url: 'https://x', title: 't', headings: [{ level: 'h2', text: page }], elements: [{ ref: 5, name: 'Send' }] } : { ok: true });
  try {
    r.script.push(turn([r.call('browser_click', { ref: 5, intent: 'submit_external', expect: 'Send' })]), end('stopped'));
    const out = await r.agent.run({ taskId: 't', instruction: 'book demo salon', meta: { grant: true, mustShow: ['Demo Salon'] } });
    assert.equal(out.status, 'completed');
    assert.equal(r.approvals.list().length, 0, 'never even reached approval on the wrong page');
    page = 'Demo Salon';
    r.script.push(turn([r.call('browser_click', { ref: 5, intent: 'submit_external', expect: 'Send' })]), end('asked'));
    const p = r.agent.run({ taskId: 't2', instruction: 'book demo salon', meta: { grant: true, mustShow: ['demo salon'] } });
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(r.approvals.list().length, 1, 'right page reaches approval');
    await r.approvals.decide(r.approvals.list()[0].id, false); await p;
  } finally { r.done(); }
});

test('final-submit click must name its button and the live element must match (Confirm booking vs Change time)', async () => {
  const r = rig();
  r.agent.nodes.dispatch = async ({ action, args }) => { if (action === 'browser_snapshot') return { url: 'u', title: 't', elements: [{ ref: 52, name: 'Confirm booking' }, { ref: 53, name: 'Change time' }] }; r.sent.push({ action, args }); return { ok: true }; };
  try {
    r.script.push(turn([r.call('browser_click', { ref: 53, intent: 'submit_external' })]), turn([r.call('browser_click', { ref: 53, intent: 'submit_external', expect: 'Confirm booking' })]), end('stopped'));
    await r.agent.run({ taskId: 't', instruction: 'confirm', meta: { grant: true, autoSubmit: true } });
    assert.equal(r.sent.length, 0, 'neither the unlabeled nor the wrong-button click went through');
    r.script.push(turn([r.call('browser_click', { ref: 52, intent: 'submit_external', expect: 'Confirm booking' })]), end('ok'));
    await r.agent.run({ taskId: 't2', instruction: 'confirm', meta: { grant: true, autoSubmit: true } });
    assert.deepEqual(r.sent.map((s) => s.args.ref), [52], 'right button goes through');
  } finally { r.done(); }
});

test('one approval: an approved task confirms on its own; under-declared final buttons are redirected to the guarded path; payments still ask', async () => {
  const r = rig();
  r.agent.nodes.dispatch = async ({ action, args }) => { if (action === 'browser_snapshot') return { url: 'u', title: 't', elements: [{ ref: 3, name: 'Salex Now Please confirm your appointment at Demo Salon. Service: Beard Trim' }, { ref: 52, name: 'Confirm booking' }] }; r.sent.push({ action, args }); return { ok: true }; };
  try {
    r.script.push(turn([r.call('browser_snapshot', {})]),
      turn([r.call('browser_click', { ref: 3, intent: 'navigate' })]),
      turn([r.call('browser_click', { ref: 52, intent: 'navigate' })]),
      turn([r.call('browser_click', { ref: 52, intent: 'submit_external', expect: 'Confirm booking' })]), end('Booking confirmed.'));
    const out = await r.agent.run({ taskId: 't', instruction: 'confirm on whatsapp', meta: { grant: true, autoSubmit: true, mustShow: ['Demo Salon'] } });
    assert.equal(out.status, 'completed');
    assert.deepEqual(r.sent.map((s) => s.args.ref), [3, 52], 'chat row opened, then only the declared confirm went through');
    assert.equal(r.approvals.list().length, 0, 'no extra approvals');
    assert.equal(r.agent.decision('browser_click', { intent: 'purchase' }, true, '', true).decision, 'ask');
  } finally { r.done(); }
});
