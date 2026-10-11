import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerAgent } from '../src/agent/computer-agent.mjs';
import { KindRouterAdapter } from '../src/adapters.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';
import { Policy } from '../src/policy.mjs';
import { Approvals } from '../src/approvals.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-comp-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const bus = new EventBus(); const settings = new Settings(store); const chat = new ChatStore(store);
  const notifications = new Notifications(store, bus);
  const policy = new Policy({ settings, bus });
  const approvals = new Approvals({ store, notifications, chat, bus });
  const sent = [];
  let online = true; let userActiveFor = 0;
  const nodes = { get online() { return online; }, setOnline: (v) => { online = v; }, dispatch: async ({ action, args, interactive }) => {
    if (interactive && userActiveFor > 0) { userActiveFor--; throw Object.assign(new Error('user_active'), { code: 'user_active', retryAfterMs: 10 }); }
    if (!(action === 'browser_snapshot' && args?.settleMs)) sent.push({ action, args }); // the loop's automatic post-action snapshot is not a model action
    if (action === 'browser_snapshot') return { ok: true, action, elements: [1, 5, 9].map((ref) => ({ ref, name: 'Send' })) };
    return { ok: true, action };
  } };
  const script = []; const ai = { hasProvider: true, execute: async () => script.shift(), run: async (role) => (role === 'computer' ? script.shift() : { content: 'a login form' }) };
  const call = (name, args, id = `c${Math.random()}`) => ({ id, name, args, argumentsText: JSON.stringify(args) });
  const agent = new ComputerAgent({ ai, nodes, policy, approvals, bus, sleep: async () => {} });
  return { dir, store, bus, policy, approvals, agent, nodes, sent, script, call, setActive: (n) => { userActiveFor = n; }, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const turn = (calls) => ({ content: '', toolCalls: calls, usage: { total_tokens: 10 } });
const end = (text) => ({ content: text, toolCalls: [], usage: { total_tokens: 5 } });

test('computer agent: approved-goal grant allows browsing/clicking, final report returned, trace emitted', async () => {
  const r = rig();
  try {
    r.script.push(turn([r.call('browser_open', { url: 'https://example.com', intent: 'navigate' })]), turn([r.call('browser_click', { ref: 3, intent: 'navigate' })]), end('Opened the page and clicked ref 3.'));
    const trace = [];
    const out = await r.agent.run({ taskId: 't', instruction: 'open example', meta: { grant: true }, onTrace: (k, d) => trace.push(k) });
    assert.deepEqual(out, { status: 'completed', output: 'Opened the page and clicked ref 3.' });
    assert.deepEqual(r.sent.map((s) => s.action), ['browser_open', 'browser_click']);
    assert.ok(!('intent' in r.sent[0].args), 'intent is policy metadata, not sent to the node');
    assert.ok(trace.includes('tool_call') && trace.includes('tool_result'));
  } finally { r.done(); }
});

test('computer agent: submit_external ALWAYS escalates to approval even with a grant; waits; approve then act', async () => {
  const r = rig();
  try {
    r.script.push(turn([r.call('browser_click', { ref: 9, intent: 'submit_external', expect: 'Send' })]), end('Sent.'));
    const p = r.agent.run({ taskId: 't', instruction: 'send it', meta: { grant: true } });
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(r.sent.length, 0, 'nothing sent before approval');
    const pending = r.approvals.list();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].category, 'messaging');
    await r.approvals.decide(pending[0].id, true, 'phone');
    assert.equal((await p).status, 'completed');
    assert.deepEqual(r.sent.map((s) => s.action), ['browser_click']);
  } finally { r.done(); }
});

test('computer agent: denial blocks the action; purchases need critical -> high; no grant means ask for desktop input', async () => {
  const r = rig();
  try {
    r.script.push(turn([r.call('browser_click', { ref: 1, intent: 'submit_external', expect: 'Send' })]), end('Could not send; user declined.'));
    const p = r.agent.run({ taskId: 't', instruction: 'x', meta: { grant: true } });
    await new Promise((res) => setTimeout(res, 30));
    await r.approvals.decide(r.approvals.list()[0].id, false);
    assert.equal((await p).status, 'completed');
    assert.equal(r.sent.length, 0);
    // pure decision matrix
    assert.equal(r.agent.decision('browser_click', { intent: 'purchase' }, true).decision, 'ask');
    assert.equal(r.agent.decision('ui_act', {}, false).decision, 'ask', 'desktop input without a grant at default level asks');
    assert.equal(r.agent.decision('ui_act', {}, true).decision, 'allow');
    assert.equal(r.agent.decision('browser_open', {}, false).decision, 'allow', 'browser is trusted by default');
    assert.equal(r.agent.decision('browser_upload', {}, false).decision, 'ask', 'uploads need approval without a grant');
    assert.equal(r.agent.decision('mystery_action', {}, true).decision, 'ask', 'unknown actions fail closed');
    r.policy.set('spending', 'high', { hours: 1 });
    assert.equal(r.agent.decision('browser_click', { intent: 'purchase' }, true).decision, 'allow');
  } finally { r.done(); }
});

test('computer agent: waits out an active user and retries; node offline fails; loops are broken; budget enforced', async () => {
  const r = rig();
  try {
    r.setActive(2);
    r.script.push(turn([r.call('open_target', { target: 'https://example.com' })]), end('done'));
    const out = await r.agent.run({ taskId: 't', instruction: 'x', meta: { grant: true } });
    assert.equal(out.status, 'completed');
    assert.equal(r.sent.length, 1, 'retried after the user went idle, acted once');
    r.setActive(5); r.sent.length = 0;
    r.script.push(turn([r.call('browser_click', { ref: 1, intent: 'navigate' })]), end('done'));
    await r.agent.run({ taskId: 't', instruction: 'x', meta: { grant: true } });
    assert.equal(r.sent.length, 1, 'browser clicks never wait for the user to stop using the mouse');

    const same = r.call('browser_snapshot', {}, 'a');
    r.script.push(turn([same, { ...same, id: 'b' }, { ...same, id: 'c' }, { ...same, id: 'd' }]), end('stopped'));
    const trace = [];
    await r.agent.run({ taskId: 't', instruction: 'x', meta: { grant: true }, onTrace: (k, d) => k === 'tool_result' && trace.push(d.result) });
    assert.ok(trace.length === 3, 'fourth identical call is refused without touching the node');

    r.nodes.setOnline(false);
    assert.equal((await r.agent.run({ taskId: 't', instruction: 'x' })).error, 'laptop_went_offline');
    assert.equal(r.agent.status().reason, 'laptop_offline');
  } finally { r.done(); }
});

test('kind router: computer tasks stay queued while the laptop is offline; other kinds run', () => {
  const ready = { v: false };
  const a = new KindRouterAdapter({ byKind: { agent: { status: () => ({ ready: true }) }, computer: { status: () => ({ ready: ready.v }) } } });
  assert.deepEqual(a.readyKinds(), ['agent']);
  ready.v = true;
  assert.deepEqual(a.readyKinds().sort(), ['agent', 'computer']);
  const dir = mkdtempSync(join(tmpdir(), 'friday-kr-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const c = store.createTask({ title: 'c', instruction: 'x', kind: 'computer' });
    const g = store.createTask({ title: 'g', instruction: 'y' });
    assert.equal(store.claimNextQueuedTask(['agent']).id, g.id, 'skips the older computer task');
    assert.equal(store.claimNextQueuedTask(['agent']), null);
    assert.equal(store.claimNextQueuedTask([]), null);
    assert.equal(store.claimNextQueuedTask(['computer']).id, c.id);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('computer agent: risk is decided from the TARGET LABEL, not the model\'s self-declared intent; grants never cover uploads', async () => {
  const r = rig();
  try {
    const a = r.agent;
    assert.equal(a.decision('browser_click', { ref: 1 }, true, 'Send message button').decision, 'ask', 'a Send button needs approval even with intent omitted');
    assert.equal(a.decision('browser_click', { ref: 1, intent: 'navigate' }, true, 'Send').decision, 'ask', 'lying about intent does not help');
    assert.equal(a.decision('browser_click', { ref: 1 }, true, 'Buy now').cat, 'spending');
    assert.equal(a.decision('browser_click', { ref: 1 }, true, 'Buy now').decision, 'ask');
    assert.equal(a.decision('browser_click', { ref: 1 }, true, 'Delete account').cat, 'deletion');
    assert.equal(a.decision('browser_click', { ref: 1 }, true, 'Read more').decision, 'allow');
    assert.equal(a.decision('browser_type', { ref: 2, text: 'hi', submit: true }, true, 'Search').decision, 'ask', 'submit=true presses Enter -> escalates');
    assert.equal(a.decision('browser_upload', { ref: 3, path: '/x' }, true).decision, 'ask', 'an approved goal does not pre-approve uploads');
    // labels learned from the last snapshot drive the decision end to end
    r.nodes.dispatch = async ({ action }) => (action === 'browser_snapshot' ? { elements: [{ ref: 7, name: 'Send', role: 'button' }, { ref: 8, name: 'Read more' }] } : { ok: true });
    r.script.push(turn([r.call('browser_snapshot', {})]), turn([r.call('browser_click', { ref: 7 })]), end('x'));
    const p = r.agent.run({ taskId: 't', instruction: 'x', meta: { grant: true } });
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(r.approvals.list().length, 1, 'clicking the Send button asked for approval');
    assert.match(r.approvals.list()[0].summary, /on “Send/);
    await r.approvals.decide(r.approvals.list()[0].id, false); await p;
  } finally { r.done(); }
});

test('computer agent: repeated waits are cut off and the model is told to snapshot; click_text is risk-classified by its text', async () => {
  const r = rig();
  try {
    const w = (i) => r.call('browser_wait', { text: 'Select date', ms: 5000 }, `w${i}`);
    r.script.push(turn([w(1)]), turn([w(2)]), turn([w(3)]), turn([w(4)]), end('ok'));
    await r.agent.run({ taskId: 't', instruction: 'x', meta: { grant: true } });
    assert.equal(r.sent.filter((x) => x.action === 'browser_wait').length, 2, 'only two consecutive waits reach the browser; the rest are refused with a hint to snapshot');
    assert.equal(r.agent.decision('browser_click_text', { text: 'Confirm booking' }, true).cat, 'messaging');
    assert.equal(r.agent.decision('browser_click_text', { text: 'Buy now' }, true).cat, 'spending');
    assert.equal(r.agent.decision('browser_click_text', { text: '2:00 PM' }, true).decision, 'allow');
  } finally { r.done(); }
});

import { compactSnapshot } from '../src/agent/computer-agent.mjs';

test('computer agent: every state-changing browser action returns the fresh page automatically (compact, with current refs)', async () => {
  const r = rig();
  try {
    const seen = [];
    r.nodes.dispatch = async ({ action, args }) => {
      seen.push([action, args?.settleMs ?? null]);
      if (action === 'browser_snapshot') return { url: 'https://x.test/book', title: 'Book', headings: [{ level: 'h1', text: 'Select date and time' }], elements: [{ ref: 6, tag: 'button', name: 'Mon 12 Oct' }, { ref: 19, tag: 'button', name: '2:00 pm' }, { ref: 33, tag: 'button', name: 'Continue →' }], text: 'Select date and time Mon 12 Oct' };
      return { clicked: true };
    };
    const msgs = [];
    r.agent.ai.execute = undefined;
    r.agent.ai.run = async (role, opts) => { msgs.push({ ...opts.messages.at(-1) }); return r.script.shift(); };
    r.script.push(turn([r.call('browser_click', { ref: 3, intent: 'navigate' })]), turn([r.call('browser_snapshot', {})]), end('ok'));
    await r.agent.run({ taskId: 't', instruction: 'book', meta: { grant: true } });
    assert.deepEqual(seen.map((x) => x[0]), ['browser_click', 'browser_snapshot', 'browser_snapshot'], 'click -> automatic settle snapshot; explicit snapshot passes through');
    assert.equal(seen[1][1], 1500, 'the automatic snapshot waits (at most) for the SPA to settle');
    const toolMsg = msgs.find((m) => m.role === 'tool' && /Elements:/.test(m.content));
    const parsed = JSON.parse(msgs.find((m) => m.role === 'tool').content);
    assert.match(parsed.page, /Headings: h1:Select date and time/);
    assert.match(parsed.page, /\[19\] button: 2:00 pm/);
    assert.ok(toolMsg);
    assert.equal(compactSnapshot(null), '');
    const big = { url: 'u', title: 't', elements: Array.from({ length: 400 }, (_, i) => ({ ref: i + 1, tag: 'a', name: 'x'.repeat(60) })) };
    const out = compactSnapshot(big, 1500); assert.ok(out.length < 1800 && /more elements/.test(out), 'huge pages are summarised, never cut mid-structure');
  } finally { r.done(); }
});
