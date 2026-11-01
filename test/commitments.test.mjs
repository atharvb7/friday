import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Commitments, commitmentTools } from '../src/commitments.mjs';
import { Jobs } from '../src/jobs.mjs';
import { AutoMemory } from '../src/agent/auto-memory.mjs';
import { Memory } from '../src/memory.mjs';

function rig(now = new Date('2026-10-26T02:00:00Z')) { // 07:30 IST
  const dir = mkdtempSync(join(tmpdir(), 'friday-commit-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store); settings.set('timezone', 'Asia/Kolkata');
  let t = now;
  const c = new Commitments({ store, settings, now: () => t });
  return { store, settings, c, set: (d) => { t = new Date(d); }, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('commitments: deadlines are tracked, de-duplicated, summarised (overdue first) and nudged once', () => {
  const r = rig();
  try {
    const lab = r.c.add({ title: 'Lab manual', due: '2026-10-26', priority: 'high' });
    r.c.add({ title: 'Hackathon prototype', due: '2026-10-30' });
    r.c.add({ title: 'Python proctoring mini project', due: '2026-10-28T18:00' });
    r.c.add({ title: 'CM assignment' });
    assert.equal(r.c.add({ title: 'lab manual', due: '2026-10-27' }).updated, true, 'same thing again updates, never duplicates');
    assert.equal(r.c.list().length, 4);
    r.set('2026-10-28T03:00:00Z'); // two days later, nothing done
    const lines = r.c.summaryLines({ hours: 72 });
    assert.match(lines[0], /Lab manual.*OVERDUE/);
    assert.ok(lines.some((l) => /Hackathon prototype/.test(l)) && lines.some((l) => /CM assignment \(no date\)/.test(l)));
    assert.equal(r.c.dueForNudge({ withinHours: 3 }).length, 0, '08:30: the 18:00 deadline is not close yet; overdue items are not re-nudged');
    r.set('2026-10-28T10:00:00Z'); // 15:30 IST
    const due = r.c.dueForNudge({ withinHours: 3 });
    assert.deepEqual(due.map((x) => x.title), ['Python proctoring mini project'], 'timed deadline within 3h -> one nudge');
    r.c.markNudged(due[0].id);
    assert.equal(r.c.dueForNudge({ withinHours: 3 }).length, 0);
    const [, list, update] = commitmentTools(r.c);
    assert.equal(update.run({ id: 'lab manual', status: 'done' }).status, 'done');
    assert.equal(list.run({}).todos.length, 3);
    assert.equal(update.run({ id: 'nonexistent thing' }).error, 'not_found_or_ambiguous');
    assert.equal(lab.all_day, 1);
  } finally { r.done(); }
});

test('auto-memory: "I have to finish X by the 30th" becomes tracked to-dos, other facts stay memories', async () => {
  const r = rig();
  try {
    const memory = new Memory(r.store);
    const ai = { hasProvider: true, run: async () => ({ content: JSON.stringify([
      { kind: 'project', content: 'User has a hackathon on 2026-10-30.', importance: 0.8 },
      { kind: 'todo', content: 'Lab manual', due: '2026-10-26', priority: 'high' },
      { kind: 'todo', content: 'Hackathon prototype', due: '2026-10-27' },
      { kind: 'todo', content: 'CM assignment', due: null },
    ]) }) };
    const am = new AutoMemory({ ai, memory, settings: r.settings, commitments: r.c, now: () => Date.parse('2026-10-26T02:00:00Z') });
    const out = await am.observe({ userText: 'today i have to complete the lab manual, CM assignment and the hackathon prototype by tomorrow' });
    assert.equal(out.todos, 3);
    assert.equal(out.saved, 1);
    assert.equal(r.c.list().length, 3);
  } finally { r.done(); }
});

test('jobs.update: a changed reminder moves in place (no second reminder left firing)', () => {
  const r = rig(new Date('2026-10-27T10:00:00Z'));
  try {
    const jobs = new Jobs({ store: r.store, notifications: { create() {} }, chat: null, bus: null, settings: r.settings, now: () => new Date('2026-10-27T10:00:00Z') });
    const j = jobs.create({ title: 'Call mom', when: '2026-10-28T09:00' });
    const u = jobs.update(j.id, { when: '2026-10-28T21:00' });
    assert.equal(u.due_at, '2026-10-28T15:30:00.000Z');
    assert.equal(jobs.list().length, 1);
    assert.equal(jobs.update(j.id, { title: 'Call mom and dad' }).title, 'Call mom and dad');
    assert.throws(() => jobs.update(j.id, { when: '2026-10-01T09:00' }), /past/);
  } finally { r.done(); }
});
