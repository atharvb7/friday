// Regression tests for bugs found in the Oct 2026 code review (core scheduling and stores).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watches } from '../src/watches.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';
import { Jobs } from '../src/jobs.mjs';

function base() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-review-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const bus = new EventBus(); const settings = new Settings(store); const chat = new ChatStore(store);
  const notifications = new Notifications(store, bus);
  return { dir, store, bus, settings, chat, notifications, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const watches = (b, extra = {}) => {
  const jobs = new Jobs({ store: b.store, notifications: b.notifications, chat: b.chat, bus: b.bus, settings: b.settings, now: () => new Date(extra.now?.() ?? Date.now()) });
  return new Watches({ store: b.store, jobs, notifications: b.notifications, chat: b.chat, bus: b.bus, settings: b.settings, ...extra });
};

test('watches: overlapping ticks fire a one-shot watch only once', async () => {
  const b = base();
  try {
    let now = Date.parse('2026-10-11T08:00:00Z'); let release; let page = 'v1';
    const fetchText = async () => { if (page === 'slow') { await new Promise((r) => { release = r; }); return 'v2'; } return page; };
    const w = watches(b, { now: () => now, fetchText, ai: { run: async () => ({ content: '{"met":true,"summary":"changed"}' }) } });
    const one = w.create({ title: 'Page', kind: 'web', target: 'https://example.com', condition: 'it changed', action: { kind: 'task', runtime: 'agent', instruction: 'do it' } });
    await w.tick(); // baseline (fires: condition met on first look) -> reset for the race
    b.store.db.prepare("UPDATE watches SET status='active', fired=0, last_hash='old' WHERE id=?").run(one.id);
    for (const t of b.store.listTasks()) b.store.transition(t.id, 'cancelled');
    now += 11 * 60_000; page = 'slow';
    const a = w.tick(); // stuck on the slow fetch
    await new Promise((r) => setTimeout(r, 10));
    now += 11 * 60_000;
    await w.tick(); // the next interval while the first is still running
    release(); await a;
    assert.equal(w.get(one.id).fired, 1);
    assert.equal(b.store.listTasks().filter((t) => t.kind === 'agent' && t.status === 'queued').length, 1);
  } finally { b.done(); }
});

test('watches: an email watch created on an empty inbox fires on the first matching email', async () => {
  const b = base();
  try {
    let now = Date.parse('2026-10-11T08:00:00Z'); let mails = [];
    const gmail = { ready: true, search: async () => ({ messages: mails }) };
    const w = watches(b, { now: () => now, gmail, ai: { run: async () => ({ content: '{"met":true,"summary":"boss wrote"}' }) } });
    const ew = w.create({ title: 'Boss', kind: 'email', target: 'from:boss@co.com', condition: 'boss emailed' });
    await w.tick();
    mails = [{ id: 'm1', from: 'boss@co.com', subject: 'Hi', snippet: 'x' }];
    now += 11 * 60_000; await w.tick();
    assert.equal(w.get(ew.id).fired, 1);
  } finally { b.done(); }
});

test('watches: a laptop check that was cancelled or interrupted does not stop the watch forever', async () => {
  const b = base();
  try {
    let now = Date.parse('2026-10-11T08:00:00Z');
    const w = watches(b, { now: () => now, ai: { run: async () => ({ content: '{}' }) } });
    const lw = w.create({ title: 'WA', kind: 'laptop', target: 'WhatsApp', condition: 'new message' });
    await w.tick();
    const first = w.get(lw.id).pending_task;
    b.store.transition(first, 'cancelled');
    now += 31 * 60_000; await w.tick();
    const second = w.get(lw.id).pending_task;
    assert.ok(second && second !== first, 'a new check was queued');
  } finally { b.done(); }
});

test('watches: cancel needs an unambiguous id prefix, never a pattern', () => {
  const b = base();
  try {
    const w = watches(b, { ai: {} });
    const a = w.create({ title: 'A', kind: 'web', target: 'https://a.example' });
    w.create({ title: 'B', kind: 'web', target: 'https://b.example' });
    assert.equal(w.cancel('%'), false);
    assert.equal(w.cancel(''), false);
    assert.equal(w.list().length, 2);
    assert.equal(w.cancel(a.id.slice(0, 8)), true);
    assert.deepEqual(w.list().map((x) => x.title), ['B']);
  } finally { b.done(); }
});

test('rules: a prefix trigger cannot cover a forbidden event or loop a task rule', async () => {
  const { Rules } = await import('../src/rules.mjs');
  const b = base();
  try {
    const rules = new Rules({ store: b.store, bus: b.bus, notifications: b.notifications });
    const task = { kind: 'task', title: 't', instruction: 'x' };
    assert.throws(() => rules.create({ name: 'a', event: 'job.', action: task }), /loop/);
    assert.throws(() => rules.create({ name: 'b', event: 'companion.', action: { kind: 'notify', title: 'x' } }), /event must/);
    assert.throws(() => rules.create({ name: 'c', event: 'approval.', action: task }), /loop/);
    assert.throws(() => rules.create({ name: 'd', event: 'memory.created', action: task }), /loop/);
    assert.ok(rules.create({ name: 'e', event: 'job.', action: { kind: 'notify', title: 'ok' } }));
    assert.ok(rules.create({ name: 'f', event: 'device.connected', action: task }));
  } finally { b.done(); }
});

test('research memory: one malformed claim or contradictions value does not drop the whole ingest', async () => {
  const { ResearchMemory } = await import('../src/research-memory.mjs');
  const b = base();
  try {
    const rm = new ResearchMemory({ store: b.store });
    const out = rm.ingest({ findings: { topic: 'T', summary: 'S', sources: [null, { url: 'https://a.example/x', title: 'A' }], claims: [null, 7, { claim: 'real claim', sourceUrl: 'https://a.example/x', topic: 'k' }], contradictions: 'none' } });
    assert.ok(out);
    assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM rm_claims').get().n, 1);
  } finally { b.done(); }
});

test('questions: waiting with an already-aborted signal rejects at once', async () => {
  const { Questions } = await import('../src/questions.mjs');
  const b = base();
  try {
    const q = new Questions({ store: b.store, chat: b.chat, notifications: b.notifications, bus: b.bus, profile: null });
    const asked = q.ask({ question: 'Which slot?' });
    const ctrl = new AbortController(); ctrl.abort(new Error('stopped'));
    const t0 = Date.now();
    await assert.rejects(() => q.wait(asked.id, ctrl.signal, 5_000), /stopped/);
    assert.ok(Date.now() - t0 < 1000);
  } finally { b.done(); }
});

test('context: the proactive briefing gets Friday\'s mood', async () => {
  const { createContext } = await import('../src/context.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'friday-review-ctx-'));
  const ctx = createContext({ appRoot: new URL('..', import.meta.url).pathname, env: { FRIDAY_DATA_DIR: dir } });
  try { assert.ok(ctx.mood); assert.equal(ctx.proactive.mood, ctx.mood); } finally { ctx.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('commitments: numbered to-dos stay separate; a refresh keeps priority and re-arms the nudge', async () => {
  const { Commitments } = await import('../src/commitments.mjs');
  const b = base();
  try {
    b.settings.set('timezone', 'Asia/Kolkata');
    const c = new Commitments({ store: b.store, settings: b.settings, now: () => new Date('2026-10-28T06:00:00Z') });
    const a2 = c.add({ title: 'DBMS assignment 2', due: '2026-10-29', priority: 'high' });
    const a3 = c.add({ title: 'DBMS assignment 3', due: '2026-11-05' });
    assert.ok(a3.created, 'a different to-do');
    assert.equal(c.get(a2.id).priority, 'high');
    assert.match(c.get(a2.id).due_at, /^2026-10-29/);
    b.store.db.prepare('UPDATE commitments SET nudged_at=? WHERE id=?').run('2026-10-28T07:00:00Z', a2.id);
    const again = c.add({ title: 'dbms assignment 2', due: '2026-10-31' });
    assert.ok(again.updated);
    assert.equal(c.get(a2.id).priority, 'high', 'priority not reset to normal');
    assert.equal(c.get(a2.id).nudged_at, null, 'new deadline is nudged again');
    assert.ok(c.add({ title: 'finish the lab manual' }).created);
    assert.ok(c.add({ title: 'lab manual' }).updated, 'same to-do in other words still dedupes');
  } finally { b.done(); }
});

test('policy: an expired or revoked high grant goes back to the previous level, not autonomous', async () => {
  const { Policy } = await import('../src/policy.mjs');
  const b = base();
  try {
    let t = 1_000_000;
    const p = new Policy({ settings: b.settings, now: () => t });
    p.set('spending', 'high', { hours: 1 });
    t += 2 * 3600_000;
    assert.equal(p.level('spending'), 'ask');
    assert.equal(p.decide({ category: 'spending', risk: 'consequential' }), 'ask');
    p.set('coding', 'autonomous'); p.set('coding', 'high', { hours: 2 }); p.set('coding', 'high', { hours: 3 });
    p.set('messaging', 'high', { hours: 2 });
    p.revokeHigh();
    assert.equal(p.level('coding'), 'autonomous', 'renewing high keeps the original level');
    assert.equal(p.level('messaging'), 'ask');
    // a grant stored before the previous level was recorded falls back to the category default
    b.settings.set('autonomy', { levels: { deletion: 'high' }, highUntil: { deletion: new Date(t - 1).toISOString() } });
    assert.equal(p.level('deletion'), 'ask');
  } finally { b.done(); }
});

test('tools: reminder_update cannot reschedule an approved agent task; task rules and scheduled tasks are consequential', async () => {
  const { buildFridayTools } = await import('../src/agent/friday-tools.mjs');
  const b = base();
  try {
    const jobs = new Jobs({ store: b.store, notifications: b.notifications, chat: b.chat, bus: b.bus, settings: b.settings });
    const t = buildFridayTools({ jobs, settings: b.settings });
    const task = jobs.create({ kind: 'task', title: 'report', body: 'write it', when: new Date(Date.now() + 3600_000).toISOString() });
    const r = t.get('reminder_update').run({ id: task.id.slice(0, 8), recurrence: { type: 'interval', minutes: 5 } });
    assert.equal(r.updated, false); assert.equal(r.reason, 'needs_approval');
    assert.equal(jobs.list()[0].recurrence, null);
    assert.equal(t.get('reminder_update').run({ id: task.id.slice(0, 8), text: 'weekly report' }).updated, true, 'the label may change');
    const rem = jobs.create({ kind: 'reminder', title: 'stretch', when: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(t.get('reminder_update').run({ id: rem.id.slice(0, 8), in_minutes: 30 }).updated, true);
    assert.equal(t.get('schedule_task').riskClass, 'consequential');
    assert.equal(t.get('rule_create').riskClass({ action: { kind: 'task' } }), 'consequential');
    assert.equal(t.get('rule_create').riskClass({ action: { kind: 'notify' } }), 'routine');
  } finally { b.done(); }
});

test('dsh: a multi-byte character split across output chunks survives', async () => {
  const { DshAdapter } = await import('../src/dsh.mjs');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'friday-review-dsh-'));
  try {
    const bin = join(dir, 'fake-dsh.mjs');
    // Writes one final event in two pipe writes, split inside "—" (3 bytes).
    writeFileSync(bin, `import { readFileSync } from 'node:fs'; readFileSync(0);
const ev = Buffer.from(JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }) + '\\n' + JSON.stringify({ type: 'final', text: 'Report — done' }) + '\\n');
const cut = ev.indexOf(Buffer.from('—')) + 1;
process.stdout.write(ev.subarray(0, cut), () => setTimeout(() => process.stdout.write(ev.subarray(cut)), 50));
`);
    const a = new DshAdapter({ homeDir: join(dir, 'home'), workRoot: join(dir, 'work'), bin, apiKey: 'nvapi-test-key', sandbox: 'off' });
    const r = await a.run({ taskId: 't-utf8', instruction: 'x' });
    assert.equal(r.status, 'completed');
    assert.equal(r.output, 'Report — done');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hermes: SSE frames separated by CRLF are parsed', async () => {
  const { HermesAdapter } = await import('../src/hermes.mjs');
  const enc = new TextEncoder();
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/runs')) return { ok: true, status: 200, json: async () => ({ run_id: 'r1' }) };
    return { ok: true, status: 200, body: (async function* () { yield enc.encode('data: {"event":"run.completed","output":"all done"}\r\n\r\n'); })() };
  };
  const h = new HermesAdapter({ url: 'http://hermes.test', key: 'k', fetchImpl });
  const r = await h.run({ taskId: 't1', instruction: 'x' });
  assert.equal(r.status, 'completed');
  assert.match(r.output, /all done/);
});
