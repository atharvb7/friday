import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextOccurrence, parseWhen, partsInTz, zonedToUtc, validateRecurrence, inQuietHours } from '../src/time.mjs';
import { Store } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';
import { Jobs } from '../src/jobs.mjs';
import { Policy, DEFAULT_LEVELS } from '../src/policy.mjs';
import { Approvals } from '../src/approvals.mjs';
import { Proactive } from '../src/proactive.mjs';
import { Brain } from '../src/agent/brain.mjs';
import { ContextBuilder } from '../src/agent/context-builder.mjs';
import { buildFridayTools } from '../src/agent/friday-tools.mjs';
import { ModelRouter } from '../src/ai/router.mjs';
import { OpenAICompatProvider } from '../src/ai/openai-compat.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-asst-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const bus = new EventBus();
  const settings = new Settings(store);
  const chat = new ChatStore(store);
  const notifications = new Notifications(store, bus);
  let clock = new Date('2026-10-12T03:00:00Z'); // 08:30 in Asia/Kolkata
  const now = () => clock;
  settings.set('timezone', 'Asia/Kolkata');
  const jobs = new Jobs({ store, notifications, chat, bus, settings, now });
  return { dir, store, bus, settings, chat, notifications, jobs, memory: new Memory(store), set: (d) => { clock = new Date(d); }, now, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('time: zone math across offsets and DST; recurrence validation', () => {
  assert.equal(zonedToUtc({ y: 2026, m: 10, d: 12, h: 9, mi: 30 }, 'Asia/Kolkata').toISOString(), '2026-10-12T04:00:00.000Z');
  // New York: EDT (-4) before the Nov 1 2026 change, EST (-5) after
  assert.equal(zonedToUtc({ y: 2026, m: 10, d: 31, h: 9 }, 'America/New_York').toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(zonedToUtc({ y: 2026, m: 11, d: 2, h: 9 }, 'America/New_York').toISOString(), '2026-11-02T14:00:00.000Z');
  // daily 09:00 NY stays 09:00 local across DST
  const a = nextOccurrence({ type: 'daily', time: '09:00' }, new Date('2026-10-31T14:00:00Z'), 'America/New_York');
  assert.equal(a.toISOString(), '2026-11-01T14:00:00.000Z'); // Nov 1: DST ended at 02:00 -> EST
  assert.equal(partsInTz(a, 'America/New_York').h, 9);
  // weekly Mon+Wed, weekdays, monthly day 31 skips short months
  assert.equal(partsInTz(nextOccurrence({ type: 'weekly', days: [1, 3], time: '08:00' }, new Date('2026-10-13T00:00:00Z'), 'UTC'), 'UTC').dow, 3);
  assert.equal(partsInTz(nextOccurrence({ type: 'weekdays', time: '08:00' }, new Date('2026-10-16T12:00:00Z'), 'UTC'), 'UTC').dow, 1); // Fri noon -> Mon
  assert.equal(partsInTz(nextOccurrence({ type: 'monthly', day: 31, time: '08:00' }, new Date('2026-10-31T12:00:00Z'), 'UTC'), 'UTC').m, 12); // Nov has 30 days
  assert.equal(parseWhen('2026-10-12T09:30', 'Asia/Kolkata').toISOString(), '2026-10-12T04:00:00.000Z');
  assert.equal(parseWhen('2026-10-12T09:30:00+05:30', 'UTC').toISOString(), '2026-10-12T04:00:00.000Z');
  assert.throws(() => parseWhen('tomorrow 9am', 'UTC'), /ISO 8601/);
  assert.throws(() => validateRecurrence({ type: 'interval', minutes: 1 }), /5\.\.43200/);
  assert.throws(() => validateRecurrence({ type: 'daily', time: '25:00' }), /HH:MM/);
  assert.equal(inQuietHours(new Date('2026-10-12T20:00:00Z'), 'Asia/Kolkata', { start: '22:00', end: '08:00' }), true); // 01:30 local
  assert.equal(inQuietHours(new Date('2026-10-12T06:00:00Z'), 'Asia/Kolkata'), false);
});

test('jobs: one-shot reminder fires once into notifications + chat; past times rejected', () => {
  const r = rig();
  try {
    const convo = r.chat.createConversation('c');
    const j = r.jobs.create({ title: 'Call mom', when: '2026-10-12T09:30', conversationId: convo.id });
    assert.equal(j.due_at, '2026-10-12T04:00:00.000Z');
    assert.equal(r.jobs.tick(), 0);
    r.set('2026-10-12T04:00:05Z');
    assert.equal(r.jobs.tick(), 1);
    assert.equal(r.jobs.tick(), 0, 'never fires twice');
    assert.match(r.notifications.list()[0].title, /Call mom/);
    assert.match(r.chat.listMessages(convo.id).at(-1).content, /Reminder: Call mom/);
    assert.equal(r.jobs.get(j.id).status, 'done');
    assert.throws(() => r.jobs.create({ title: 'x', when: '2026-10-11T09:30' }), /in the past/);
  } finally { r.done(); }
});

test('jobs: recurring task queues an agent task each time; missed fires collapse into one', () => {
  const r = rig();
  try {
    const j = r.jobs.create({ kind: 'task', title: 'Weekly research', body: 'research X', recurrence: { type: 'daily', time: '09:00' } });
    assert.equal(j.due_at, '2026-10-12T03:30:00.000Z');
    r.set('2026-10-15T10:00:00Z'); // server was off for 3 days
    assert.equal(r.jobs.tick(), 1);
    assert.equal(r.store.listTasks().length, 1, 'one catch-up task, not three');
    const next = r.jobs.get(j.id);
    assert.equal(next.status, 'active');
    assert.ok(Date.parse(next.due_at) > Date.parse('2026-10-15T10:00:00Z'));
    assert.equal(next.fire_count, 1);
    const capped = r.jobs.create({ title: 'limited', recurrence: { type: 'interval', minutes: 10 }, maxFires: 1 });
    r.set('2026-10-15T11:00:00Z'); r.jobs.tick();
    assert.equal(r.jobs.get(capped.id).status, 'done');
    assert.ok(r.jobs.snooze(j.id, 30));
  } finally { r.done(); }
});

test('policy: tier matrix, critical needs time-boxed high, expiry reverts, revoke, unknown fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-pol-'));
  const st = new Store(join(dir, 'db.sqlite'));
  const s = new Settings(st);
  let t = 1_000_000;
  const p = new Policy({ settings: s, now: () => t });
  assert.equal(DEFAULT_LEVELS.spending, 'ask');
  assert.equal(p.decide({ category: 'research', risk: 'routine' }), 'allow');
  assert.equal(p.decide({ category: 'computer', risk: 'routine' }), 'ask');
  assert.equal(p.decide({ category: 'coding', risk: 'consequential' }), 'ask'); // trusted < autonomous
  p.set('coding', 'autonomous');
  assert.equal(p.decide({ category: 'coding', risk: 'consequential' }), 'allow');
  assert.equal(p.decide({ category: 'coding', risk: 'critical' }), 'ask', 'critical never below high');
  p.set('spending', 'high', { hours: 1 });
  assert.equal(p.decide({ category: 'spending', risk: 'critical' }), 'allow');
  t += 2 * 3600_000;
  assert.equal(p.decide({ category: 'spending', risk: 'critical' }), 'ask', 'high auto-expires');
  p.set('messaging', 'high', { hours: 4 }); p.revokeHigh();
  assert.equal(p.decide({ category: 'messaging', risk: 'critical' }), 'ask');
  assert.equal(p.decide({ category: 'bogus', risk: 'routine' }), 'ask');
  assert.equal(p.decide({ category: 'research', risk: 'routine', forbidden: true }), 'deny');
  assert.throws(() => p.set('spending', 'high', { hours: 100 }), /at most/);
  assert.throws(() => p.set('nope', 'ask'), /unknown category/);
  st.close(); rmSync(dir, { recursive: true, force: true });
});

test('approvals: binds exact payload, executes once, expires, tamper detected', async () => {
  const r = rig();
  try {
    const ap = new Approvals({ store: r.store, notifications: r.notifications, chat: r.chat, bus: r.bus, now: r.now });
    const ran = [];
    ap.register('send_message', async (payload) => { ran.push(payload); return { sent: true }; });
    const convo = r.chat.createConversation('c');
    const a = ap.request({ category: 'messaging', risk: 'consequential', tool: 'send_message', summary: 'Send hi to Rohan', payload: { to: 'Rohan', text: 'hi' }, conversationId: convo.id });
    assert.equal(r.notifications.list()[0].level, 'warning');
    assert.equal(ran.length, 0, 'nothing runs before approval');
    await ap.decide(a.id, true, 'phone');
    assert.deepEqual(ran, [{ to: 'Rohan', text: 'hi' }]);
    await assert.rejects(() => ap.decide(a.id, true), /already_approved/);
    assert.equal(ran.length, 1, 'double approval cannot double-execute');
    assert.match(r.chat.listMessages(convo.id).at(-1).content, /Done after your approval/);

    const b = ap.request({ category: 'messaging', risk: 'consequential', tool: 'send_message', summary: 's', payload: { to: 'X', text: 'y' } });
    r.store.db.prepare("UPDATE approvals SET payload=? WHERE id=?").run(JSON.stringify({ to: 'EVIL', text: 'y' }), b.id);
    await assert.rejects(() => ap.decide(b.id, true), /payload_tampered/);
    assert.equal(ran.length, 1);

    const c = ap.request({ category: 'messaging', risk: 'consequential', tool: 'send_message', summary: 's', payload: {} });
    assert.equal((await ap.decide(c.id, false)).status, 'denied');
    const d = ap.request({ category: 'messaging', risk: 'consequential', tool: 'send_message', summary: 's', payload: {} });
    r.set('2026-10-14T04:00:00Z');
    await assert.rejects(() => ap.decide(d.id, true), /already_expired/);
  } finally { r.done(); }
});

test('proactive: quiet hours, per-topic dedupe, daily cap, briefing exactly once per day', async () => {
  const r = rig();
  try {
    r.set('2026-10-12T04:00:00Z'); // 09:30 IST -> past 09:00 briefing time, outside quiet hours
    r.store.createTask({ title: 'old', instruction: 'x' });
    r.store.db.prepare("UPDATE tasks SET created_at='2026-10-12T02:00:00.000Z'").run();
    const ai = new ModelRouter({ chains: { chat: [] } });
    let ready = false;
    const p = new Proactive({ store: r.store, notifications: r.notifications, jobs: r.jobs, ai, memory: r.memory, settings: r.settings, bus: r.bus, agentReady: () => ready, dataDir: r.dir, now: r.now });
    r.set('2026-10-12T09:00:00Z'); // 14:30 IST: too late for a morning briefing
    await p.tick();
    assert.ok(!r.notifications.list().some((n) => /briefing/.test(n.title)), 'late start skips the briefing');
    r.set('2026-10-12T04:00:00Z');
    await p.tick();
    const titles = () => r.notifications.list().map((n) => n.title);
    assert.ok(titles().some((t) => /agent runtime is down/.test(t)));
    assert.ok(titles().some((t) => /briefing/.test(t)));
    const count = r.notifications.list().length;
    await p.tick();
    assert.equal(r.notifications.list().length, count, 'deduped + one briefing per day');
    // next day, quiet hours: nothing volunteered
    r.set('2026-10-12T20:00:00Z');
    r.settings.set('last_briefing_date', null);
    await p.tick();
    assert.equal(r.notifications.list().length, count);
    // cap
    p.setConfig({ maxPerDay: 1 });
    assert.equal(p.config().maxPerDay, 1);
    assert.throws(() => p.setConfig({ briefing: { time: '9am' } }), /HH:MM/);
    p.setConfig({ enabled: false });
    r.set('2026-10-13T04:00:00Z'); r.settings.set('last_briefing_date', null);
    await p.tick();
    assert.equal(r.notifications.list().length, count, 'disabled means silent');
  } finally { r.done(); }
});

test('brain: gated tool is staged for approval, never executed; allowed tier executes; forbidden denied', async () => {
  const r = rig();
  try {
    const approvals = new Approvals({ store: r.store, notifications: r.notifications, chat: r.chat, bus: r.bus, now: r.now });
    const policy = new Policy({ settings: r.settings });
    const sent = [];
    const ctx = { memory: r.memory, store: r.store, tools: null, indexer: null, worker: { cancel() {} }, jobs: r.jobs, settings: r.settings, proactive: {}, skills: null };
    const ft = buildFridayTools(ctx);
    const tool = { name: 'send_message', risk: 'gated', category: 'messaging', riskClass: 'consequential', description: 'send', parameters: { type: 'object', properties: {}, additionalProperties: true }, summarize: (a) => `Send “${a.text}” to ${a.to}`, run: async (a) => { sent.push(a); return { sent: true }; } };
    ft.register(tool); approvals.register(tool.name, tool.run);
    const convo = r.chat.createConversation('t'); r.chat.addMessage(convo.id, 'user', 'send hi to Rohan');
    let step = 0;
    const prov = new OpenAICompatProvider({ name: 'p', baseUrl: 'http://x', apiKey: 'k'.repeat(12), fetchImpl: async (u, { body }) => {
      step++;
      const msgs = JSON.parse(body).messages;
      const toolMsg = msgs.filter((m) => m.role === 'tool').at(-1)?.content ?? '';
      const resp = step % 2 === 1
        ? { choices: [{ message: { content: null, tool_calls: [{ id: 'c', function: { name: 'send_message', arguments: '{"to":"Rohan","text":"hi"}' } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { content: toolMsg.includes('requires_approval') ? 'Waiting on your approval.' : 'Sent it.' }, finish_reason: 'stop' }] };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => resp, text: async () => '' };
    } });
    const ai = new ModelRouter({ chains: { execute: [{ provider: 'p', model: 'm' }] } }).register(prov);
    const brain = new Brain({ ai, fridayTools: ft, settings: r.settings, chat: r.chat, bus: r.bus, contextBuilder: new ContextBuilder({ memory: r.memory, store: r.store }), policy, approvals });

    let out = await brain.respond({ conversationId: convo.id, text: 'send hi to Rohan' });
    assert.equal(out.reply, 'Waiting on your approval.');
    assert.equal(sent.length, 0, 'default tier: staged, NOT executed');
    assert.equal(approvals.list().length, 1);
    assert.equal(approvals.list()[0].payload.to, 'Rohan');

    policy.set('messaging', 'autonomous');
    out = await brain.respond({ conversationId: convo.id, text: 'again' });
    assert.equal(out.reply, 'Sent it.');
    assert.equal(sent.length, 1, 'autonomous tier executes directly');

    tool.forbidden = true;
    out = await brain.respond({ conversationId: convo.id, text: 'again' });
    assert.equal(sent.length, 1, 'forbidden never runs');
  } finally { r.done(); }
});

test('context: built-in gated tools (computer_task) have their approved-execution path registered', async () => {
  const { createContext } = await import('../src/context.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'friday-ctx-'));
  const appRoot = new URL('..', import.meta.url).pathname;
  const ctx = createContext({ appRoot, env: { FRIDAY_DATA_DIR: dir } });
  try {
    const convo = ctx.chat.createConversation('t');
    const tool = ctx.fridayTools.get('computer_task');
    assert.equal(tool.risk, 'gated');
    const a = ctx.approvals.request({ category: 'computer', risk: 'consequential', tool: 'computer_task', summary: 's', payload: { goal: 'open example.com' }, conversationId: convo.id });
    const done = await ctx.approvals.decide(a.id, true, 'owner');
    assert.ok(!JSON.parse(done.result).error, done.result);
    const t = ctx.store.listTasks().find((x) => x.kind === 'computer');
    assert.ok(t, 'approval created the computer task');
    assert.equal(JSON.parse(t.meta).grant, true);
  } finally { ctx.stop(); rmSync(dir, { recursive: true, force: true }); }
});
