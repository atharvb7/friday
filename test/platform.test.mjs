import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Skills, parseSkill } from '../src/skills.mjs';
import { validateMcpConfig, renderOverlay, envToForward } from '../src/mcp-config.mjs';
import { Store } from '../src/store.mjs';
import { Notifications } from '../src/notifications.mjs';
import { EventBus } from '../src/events.mjs';
import { WorkerLoop } from '../src/worker.mjs';
import { ResourceGovernor, PROFILES } from '../src/resource-governor.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('skills: shipped set parses, index is compact, install rejects symlinks and bad frontmatter', () => {
  const shipped = new Skills({ roots: [new URL('../skills', import.meta.url).pathname] });
  const names = shipped.list().map((s) => s.name);
  for (const n of ['research', 'coding', 'report-writing', 'daily-briefing', 'competitive-analysis']) assert.ok(names.includes(n), n);
  assert.ok(shipped.index().length < 5000);
  assert.equal(shipped.index().split('\n').length, names.length, 'every shipped skill is visible in the index');
  assert.match(shipped.load('research').instructions, /contradictions/i);
  assert.equal(shipped.load('nope'), null);
  assert.equal(parseSkill('no frontmatter'), null);

  const dir = tmp('friday-skill-');
  try {
    mkdirSync(join(dir, 'ok')); writeFileSync(join(dir, 'ok', 'SKILL.md'), '---\nname: my-skill\ndescription: does a thing\n---\nBody');
    const sk = new Skills({ roots: [join(dir, 'installed')] });
    assert.equal(sk.install(join(dir, 'ok'), join(dir, 'installed')).name, 'my-skill');
    assert.equal(sk.load('my-skill').instructions, 'Body');
    mkdirSync(join(dir, 'evil')); writeFileSync(join(dir, 'evil', 'SKILL.md'), '---\nname: evil\ndescription: x\n---\nx'); symlinkSync('/etc/passwd', join(dir, 'evil', 'link'));
    assert.throws(() => sk.install(join(dir, 'evil'), join(dir, 'installed')), /symlinks/);
    mkdirSync(join(dir, 'bad')); writeFileSync(join(dir, 'bad', 'SKILL.md'), 'nothing');
    assert.throws(() => sk.install(join(dir, 'bad'), join(dir, 'installed')), /invalid SKILL.md/);
    // mirrored into the agent's own home
    sk.syncTo(join(dir, 'dsh-skills'));
    assert.ok(existsSync(join(dir, 'dsh-skills', 'my-skill', 'SKILL.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mcp config: validated, secrets only by env name, overlay never contains values', () => {
  const cfg = validateMcpConfig({ servers: {
    github: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], envPassthrough: ['GITHUB_TOKEN'] },
    web: { transport: 'streamable-http', url: 'https://example.com/mcp' },
    off: { transport: 'stdio', command: 'x', enabled: false },
  } });
  process.env.GITHUB_TOKEN = 'ghp_supersecret';
  const y = renderOverlay(cfg);
  assert.match(y, /serverName: github/);
  assert.match(y, /GITHUB_TOKEN: !!js process\.env\.GITHUB_TOKEN/);
  assert.ok(!y.includes('ghp_supersecret') && !y.includes('serverName: off'));
  assert.deepEqual(envToForward(cfg), ['GITHUB_TOKEN']);
  delete process.env.GITHUB_TOKEN;
  assert.throws(() => validateMcpConfig({ servers: { 'bad name': { transport: 'stdio', command: 'x' } } }), /invalid server name/);
  assert.throws(() => validateMcpConfig({ servers: { a: { transport: 'streamable-http', url: 'http://evil.example/mcp' } } }), /https/);
  assert.throws(() => validateMcpConfig({ servers: { a: { transport: 'stdio', command: 'x', envPassthrough: ['lower'] } } }), /bad env name/);
  assert.match(renderOverlay({ servers: {} }), /no MCP servers/);
});

test('notifications: durable inbox + bus event, unread tracking', () => {
  const dir = tmp('friday-notif-');
  try {
    const store = new Store(join(dir, 'db.sqlite')); const bus = new EventBus(); const seen = [];
    bus.subscribe((e) => seen.push(e.type));
    const n = new Notifications(store, bus);
    const a = n.create({ title: 'Done: research', level: 'success', body: 'ok' });
    n.create({ title: 'Failed: x', level: 'error' });
    assert.equal(n.unreadCount(), 2);
    assert.ok(n.markRead(a.id) && !n.markRead(a.id));
    assert.equal(n.list({ unreadOnly: true }).length, 1);
    assert.equal(n.markAllRead(), 1);
    assert.deepEqual(seen, ['notification.created', 'notification.created']);
    assert.throws(() => n.create({ title: '', level: 'info' }), /title required/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('worker pool: runs up to maxConcurrent tasks in parallel, emergency cancels all, traces recorded', async () => {
  const dir = tmp('friday-pool-');
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const ids = ['a', 'b', 'c'].map((t) => store.createTask({ title: t, instruction: t }).id);
    const gov = new ResourceGovernor({ readSnapshot: () => ({ mode: 'normal', availableBytes: 8e9, pressureSomeAvg10: 0, pressureFullAvg10: 0 }), thresholds: { concurrency: { background: 2 } } });
    let active = 0, peak = 0;
    const release = [];
    const adapter = { status: () => ({ ready: true }), run: ({ onTrace, signal }) => new Promise((res, rej) => {
      active++; peak = Math.max(peak, active); onTrace('step', { n: 1 });
      signal.addEventListener('abort', () => { active--; rej(Object.assign(new Error('x'), { name: 'AbortError' })); });
      release.push(() => { active--; res({ status: 'completed', output: 'ok' }); });
    }) };
    const w = new WorkerLoop({ store, governor: gov, adapter, maxConcurrent: 2 });
    await w.tick();
    assert.equal(w.running.size, 2); assert.equal(peak, 2);
    assert.equal(store.getTask(ids[2]).status, 'queued', 'third task waits its turn');
    assert.ok(store.listEvents(ids[0]).some((e) => e.kind === 'trace.step'));
    release.shift()(); await new Promise((r) => setTimeout(r, 20));
    await w.tick();
    assert.equal(w.running.size, 2);
    w.cancelAll('Memory emergency'); await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.running.size, 0);
    assert.ok(ids.every((id) => ['completed', 'blocked', 'queued', 'running'].includes(store.getTask(id).status)));
    assert.equal(store.getTask(ids[1]).status, 'blocked');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('governor server6g profile scales thresholds for a 6 GB host', () => {
  const idle6g = { availableBytes: 4.2 * 1024 ** 3, pressureSomeAvg10: 0, pressureFullAvg10: 0 };
  const laptop = new ResourceGovernor({ readSnapshot: () => idle6g });
  const server = new ResourceGovernor({ readSnapshot: () => idle6g, thresholds: PROFILES.server6g });
  assert.equal(laptop.sample().mode, 'normal');
  assert.equal(server.sample().mode, 'normal');
  assert.equal(server.canAdmit('subagent').allowed, true, 'subagents admissible on 6 GB when 1.2 GB free');
  const tight = new ResourceGovernor({ readSnapshot: () => ({ ...idle6g, availableBytes: 0.8 * 1024 ** 3 }), thresholds: PROFILES.server6g });
  assert.equal(tight.sample().mode, 'paused');
});
