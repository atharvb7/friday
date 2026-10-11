import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesAdapter } from '../src/hermes.mjs';
import { TeamOrchestrator, validatePlan } from '../src/agent/team.mjs';
import { Learner } from '../src/agent/learning.mjs';
import { Watches } from '../src/watches.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { EventBus } from '../src/events.mjs';
import { Notifications } from '../src/notifications.mjs';
import { Approvals } from '../src/approvals.mjs';
import { Profile } from '../src/profile.mjs';
import { Skills } from '../src/skills.mjs';
import { Jobs } from '../src/jobs.mjs';

function base() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-next-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const bus = new EventBus(); const settings = new Settings(store); const chat = new ChatStore(store);
  const notifications = new Notifications(store, bus);
  const approvals = new Approvals({ store, notifications, chat, bus });
  return { dir, store, bus, settings, chat, notifications, approvals, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// Minimal fake of Hermes' API server Runs API.
function fakeHermes({ approval = false } = {}) {
  const seen = { auth: [], runs: [], approvals: [] };
  const srv = http.createServer(async (req, res) => {
    seen.auth.push(req.headers.authorization);
    let body = ''; for await (const c of req) body += c;
    if (req.url === '/health') return res.end('{"status":"ok"}');
    if (req.method === 'POST' && req.url === '/v1/runs') { seen.runs.push(JSON.parse(body)); res.writeHead(202, { 'Content-Type': 'application/json' }); return res.end('{"run_id":"run_1","status":"started"}'); }
    if (req.method === 'POST' && req.url === '/v1/runs/run_1/approval') { seen.approvals.push(JSON.parse(body)); srv.emit('approved', JSON.parse(body).choice); return res.end('{}'); }
    if (req.url === '/v1/runs/run_1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ event: 'tool.started', tool: 'terminal', preview: 'ls' });
      send({ event: 'tool.completed', tool: 'terminal', duration: 0.2 });
      if (approval) { send({ event: 'approval.request', command: 'rm -rf build', description: 'recursive delete' }); const choice = await new Promise((r) => srv.once('approved', r)); send({ event: 'run.completed', output: `done (${choice})` }); }
      else send({ event: 'run.completed', output: 'All done: 3 files listed.' });
      return res.end(': stream closed\n\n');
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('hermes: run streams traces, returns the report, sends the key; flagged commands go through Friday approvals', async () => {
  const b = base(); const h = await fakeHermes(); const h2 = await fakeHermes({ approval: true });
  try {
    const a = new HermesAdapter({ url: h.url, key: 'k1', approvals: b.approvals });
    assert.equal(a.status().ready, false);
    await a.probe(); assert.equal(a.status().ready, true);
    const trace = [];
    const out = await a.run({ taskId: 't1', instruction: 'list files', onTrace: (k, d) => trace.push([k, d]) });
    assert.deepEqual(out, { status: 'completed', output: 'All done: 3 files listed.' });
    assert.ok(h.seen.auth.every((x) => x === 'Bearer k1'));
    assert.equal(h.seen.runs[0].input, 'list files'); assert.equal(h.seen.runs[0].session_id, 'friday-t1');
    assert.ok(trace.some(([k, d]) => k === 'tool_call' && d.tool === 'hermes:terminal'));

    const a2 = new HermesAdapter({ url: h2.url, key: 'k2', approvals: b.approvals });
    const p = a2.run({ taskId: 't2', instruction: 'clean' });
    for (let i = 0; i < 50 && !b.approvals.list().length; i++) await new Promise((r) => setTimeout(r, 20));
    const [ap] = b.approvals.list();
    assert.match(ap.summary, /rm -rf build/); assert.equal(ap.category, 'system');
    await b.approvals.decide(ap.id, false);
    assert.deepEqual(await p, { status: 'completed', output: 'done (deny)' });
    assert.equal(new HermesAdapter({}).status().reason, 'hermes_not_configured');
  } finally { h.srv.close(); h2.srv.close(); b.done(); }
});

test('team: plan validation, parallel + dependency results flow, failures skip dependents, merged report', async () => {
  assert.throws(() => validatePlan([{ id: 'a', runtime: 'research', instruction: 'x' }]), /2-8/);
  assert.throws(() => validatePlan([{ id: 'a', runtime: 'research', instruction: 'x', dependsOn: ['b'] }, { id: 'b', runtime: 'coding', instruction: 'y', dependsOn: ['a'] }]), /cycle/);
  assert.throws(() => validatePlan([{ id: 'a', runtime: 'nope', instruction: 'x' }, { id: 'b', runtime: 'coding', instruction: 'y' }]), /runtime/);
  const b = base();
  try {
    const calls = []; let concurrent = 0, peak = 0;
    const mk = (fn) => ({ status: () => ({ ready: true }), run: async (o) => { concurrent++; peak = Math.max(peak, concurrent); calls.push(o); await new Promise((r) => setTimeout(r, 30)); concurrent--; return fn(o); } });
    const router = { byKind: { research: mk(() => ({ status: 'completed', output: 'prices: A=10, B=12' })), hermes: mk(() => ({ status: 'failed', error: 'boom' })), coding: mk((o) => ({ status: 'completed', output: `built using ${/prices: A=10/.test(o.instruction) ? 'research' : 'nothing'}` })), agent: mk(() => ({ status: 'completed', output: 'never' })) } };
    router.run = (o) => router.byKind[o.kind].run(o);
    const ai = { hasProvider: true, run: async (_r, { messages }) => ({ content: `MERGED: ${messages[1].content.includes('built using research') ? 'ok' : 'bad'}` }) };
    const parent = b.store.createTask({ title: 'Team: compare', kind: 'team', instruction: 'compare and build' });
    const team = new TeamOrchestrator({ store: b.store, router, ai, sleep: async () => {} });
    const plan = validatePlan([
      { id: 'res', runtime: 'research', instruction: 'find prices' },
      { id: 'herm', runtime: 'hermes', instruction: 'side job' },
      { id: 'build', runtime: 'coding', instruction: 'build table', dependsOn: ['res'] },
      { id: 'after', runtime: 'agent', instruction: 'needs herm', dependsOn: ['herm'] },
    ]);
    const out = await team.run({ taskId: parent.id, instruction: 'compare and build', meta: { plan } });
    assert.equal(out.status, 'completed');
    assert.match(out.output, /MERGED: ok/); assert.match(out.output, /2\/4 steps succeeded/);
    assert.ok(peak >= 2, 'independent steps ran in parallel');
    assert.ok(!calls.some((c) => c.kind === 'agent'), 'dependent of a failed step is skipped');
    assert.ok(calls.every((c) => c.meta.grant === true));
    const subs = b.store.listTasks().filter((t) => t.kind.startsWith('sub:'));
    assert.equal(subs.length, 3); assert.ok(subs.every((t) => ['completed', 'failed'].includes(t.status)));
  } finally { b.done(); }
});

test('learning: a successful laptop run becomes a playbook without personal data, is reused as hints, and improves in place', async () => {
  const b = base();
  try {
    const profile = new Profile({ settings: b.settings }); profile.set('phone', '9876543210');
    const skillsDir = join(b.dir, 'skills');
    let reply = { worth_saving: true, name: 'salexnow-booking', description: 'Book a salon slot on salexnow.com and confirm on WhatsApp', hosts: ['salexnow.com'], body: '1. Open https://salexnow.com\n2. Pick the salon by name\n3. Type {{profile.phone}} — never 9876543210\n4. Confirm on WhatsApp' };
    let seenPrompt = '';
    const ai = { hasProvider: true, run: async (_r, { messages }) => { seenPrompt = messages[1].content; return { content: JSON.stringify(reply) }; } };
    const learner = new Learner({ ai, store: b.store, skills: new Skills({ roots: [skillsDir] }), dir: skillsDir, profile, bus: b.bus, settings: b.settings });
    const t = b.store.createTask({ title: 'Laptop: book', kind: 'computer', instruction: 'Book beard trim at Demo Salon on salexnow.com' });
    b.store.transition(t.id, 'running');
    for (let i = 0; i < 6; i++) { b.store.addEvent(t.id, 'trace.tool_call', { tool: 'browser_click', input: `{"ref":${i}}` }); b.store.addEvent(t.id, 'trace.tool_result', { status: 'ok', result: 'typed 9876543210' }); }
    b.store.transition(t.id, 'completed', { result: 'Booked.' });
    const r = await learner.learnFrom(t.id);
    assert.deepEqual(r, { saved: true, name: 'salexnow-booking', updated: false });
    assert.ok(!seenPrompt.includes('9876543210'), 'the model never sees the phone number');
    const md = readFileSync(join(skillsDir, 'salexnow-booking', 'SKILL.md'), 'utf8');
    assert.ok(!md.includes('9876543210') && md.includes('{{profile.phone}}'));
    assert.match(learner.hintsFor('book a haircut on salexnow.com tomorrow'), /PLAYBOOKS LEARNED[\s\S]*salexnow-booking/);
    assert.equal(learner.hintsFor('write a python script'), '');
    reply = { ...reply, name: 'something-else', body: '1. Open https://salexnow.com\n2. Use the search box — the salon list is long\n3. Confirm on WhatsApp' };
    const t2 = b.store.createTask({ title: 'Laptop: book again', kind: 'computer', instruction: 'Book at Demo Salon via salexnow.com' });
    b.store.transition(t2.id, 'running'); for (let i = 0; i < 6; i++) b.store.addEvent(t2.id, 'trace.tool_call', { tool: 'browser_click', input: '{}' }); b.store.transition(t2.id, 'completed', { result: 'Booked.' });
    assert.deepEqual(await learner.learnFrom(t2.id), { saved: true, name: 'salexnow-booking', updated: true });
    assert.match(readFileSync(join(skillsDir, 'salexnow-booking', 'SKILL.md'), 'utf8'), /runs: 2[\s\S]*search box/);
    const short = b.store.createTask({ title: 'x', kind: 'computer', instruction: 'x' }); b.store.transition(short.id, 'running'); b.store.transition(short.id, 'completed', { result: 'ok' });
    assert.equal((await learner.learnFrom(short.id)).reason, 'too_short');
    assert.ok(learner.forget('salexnow-booking')); assert.ok(!existsSync(join(skillsDir, 'salexnow-booking')));
  } finally { b.done(); }
});

test('watches: web change + condition fires notify or a follow-up task; laptop checks are read-only tasks; follow-ups create reminders', async () => {
  const b = base();
  try {
    let page = 'Slots: none'; let met = false;
    const ai = { hasProvider: true, run: async (_r, { messages }) => {
      if (/watched condition/.test(messages[0].content)) return { content: JSON.stringify({ met, summary: met ? 'A 2pm slot opened' : 'still none' }) };
      return { content: JSON.stringify({ appointments: [{ title: 'Beard trim at Demo Salon', at: '2026-10-13T14:00' }], needsUser: ['Bring cash'] }) };
    } };
    let now = Date.parse('2026-10-11T08:00:00Z');
    const jobs = new Jobs({ store: b.store, notifications: b.notifications, chat: b.chat, bus: b.bus, settings: b.settings, now: () => new Date(now) });
    const w = new Watches({ store: b.store, ai, jobs, notifications: b.notifications, chat: b.chat, bus: b.bus, settings: b.settings, fetchText: async () => page, now: () => now });
    assert.throws(() => w.create({ title: 'x', kind: 'web', target: 'ftp://x' }));
    const web = w.create({ title: 'Salon slots', kind: 'web', target: 'https://example.com/slots', condition: 'a 2pm slot is available', everyMin: 1, action: { kind: 'task', runtime: 'computer', instruction: 'book the 2pm slot' } });
    assert.equal(web.every_min, 5, 'minimum interval enforced');
    await w.tick(); // baseline + judged not met
    now += 6 * 60_000; page = 'Slots: 2:00 pm'; met = true;
    await w.tick();
    assert.equal(w.get(web.id).status, 'done');
    const follow = b.store.listTasks().find((t) => t.kind === 'computer');
    assert.match(follow.instruction, /book the 2pm slot[\s\S]*A 2pm slot opened/); assert.equal(JSON.parse(follow.meta).grant, true);

    const lap = w.create({ title: 'Salex WhatsApp', kind: 'laptop', target: 'WhatsApp chat with Salex Now', condition: 'new confirm message', everyMin: 1 });
    assert.equal(lap.every_min, 15);
    now += 16 * 60_000; await w.tick();
    const check = b.store.listTasks().find((t) => t.kind === 'watch');
    assert.equal(JSON.parse(check.meta).readOnly, true); assert.match(check.instruction, /READ-ONLY/);
    b.store.transition(check.id, 'running'); b.store.transition(check.id, 'completed', { result: 'TRIGGERED\nNew message: Confirm appointment at Demo Salon' });
    await w.onTaskFinished(check.id, 'task.completed');
    assert.equal(w.get(lap.id).status, 'done');
    assert.ok(b.notifications.list().some((n) => /Salex WhatsApp/.test(n.title)));

    const done = b.store.createTask({ title: 'Laptop: book', kind: 'computer', instruction: 'book' });
    b.store.transition(done.id, 'running'); b.store.transition(done.id, 'completed', { result: 'Booked Beard Trim at Demo Salon for Tue 13 Oct, 2:00 pm. Confirmed on WhatsApp.' });
    const f = await w.followUp(b.store.getTask(done.id));
    assert.equal(f.reminders, 2); assert.equal(f.needs, 1);
    assert.deepEqual(await w.followUp(b.store.getTask(done.id)), { skipped: true }, 'once per task');
  } finally { b.done(); }
});

test('watches: email watch baselines, then fires only on new matching mail', async () => {
  const b = base();
  try {
    let mails = [{ messageId: 'a1', sender: 'hr@co.com', subject: 'Old', preview: { body: 'x' } }];
    const composio = { configured: true, execute: async (tk, action, args) => { assert.equal(tk, 'gmail'); assert.equal(action, 'FETCH_EMAILS'); assert.equal(args.query, 'from:hr@co.com'); return { data: { messages: mails } }; } };
    const ai = { hasProvider: true, run: async () => ({ content: JSON.stringify({ met: true, summary: 'HR replied about the offer' }) }) };
    let now = Date.parse('2026-10-11T08:00:00Z');
    const jobs = new Jobs({ store: b.store, notifications: b.notifications, chat: b.chat, bus: b.bus, settings: b.settings, now: () => new Date(now) });
    const w = new Watches({ store: b.store, ai, jobs, notifications: b.notifications, chat: b.chat, bus: b.bus, settings: b.settings, composio, now: () => now });
    const ew = w.create({ title: 'HR reply', kind: 'email', target: 'from:hr@co.com', condition: 'a reply about my offer' });
    await w.tick();
    assert.equal(w.get(ew.id).status, 'active'); assert.match(w.get(ew.id).last_note, /baseline/);
    now += 6 * 60_000; await w.tick();
    assert.equal(w.get(ew.id).fired, 0, 'nothing new');
    mails = [{ messageId: 'a2', sender: 'hr@co.com', subject: 'Your offer', preview: { body: 'Congrats' } }, ...mails];
    now += 6 * 60_000; await w.tick();
    assert.equal(w.get(ew.id).status, 'done');
    assert.ok(b.notifications.list().some((n) => /HR reply/.test(n.title) && /Your offer/.test(n.body)));
  } finally { b.done(); }
});
