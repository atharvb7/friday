import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Goals, goalTools } from '../src/goals.mjs';
import { ContextBuilder } from '../src/agent/context-builder.mjs';
import { ToolRouter } from '../src/agent/toolsets.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-goals-'));
  const store = new Store(join(dir, 'db.sqlite'));
  let t = Date.parse('2026-11-01T10:00:00Z');
  const goals = new Goals({ store, now: () => new Date(t) });
  const tools = Object.fromEntries(goalTools(goals).map((x) => [x.name, x]));
  return { store, goals, tools, tick: (ms) => { t += ms; }, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('goals: a note always rewrites the digest; notes stay as history; find by id prefix or title words; close', () => {
  const r = rig();
  try {
    const g = r.tools.goal_add.run({ title: '3 FDE clients by December', why: 'replace freelance income' });
    assert.equal(r.tools.goal_add.run({ title: '3 fde clients by december' }).id, g.id, 'same title is not a second goal');
    assert.match(JSON.stringify(r.tools.goal_note.run({ id: g.id, note: 'Call with Acme went well', digest: '' })), /digest required/);
    r.tools.goal_note.run({ id: 'FDE clients', note: 'Acme: discovery call done, proposal due Nov 5', digest: '0 of 3 signed. Acme proposal due 5 Nov; 2 more leads in talks.' });
    r.tick(3600_000);
    const after = r.tools.goal_note.run({ id: g.id, note: 'Acme signed ₹1.2L/month', digest: '1 of 3 signed (Acme, ₹1.2L/month from Dec). 2 leads in talks.' });
    assert.equal(after.where_it_stands, '1 of 3 signed (Acme, ₹1.2L/month from Dec). 2 leads in talks.');
    const listed = r.tools.goal_list.run({}).goals[0];
    assert.equal(listed.recent_notes.length, 2);
    assert.match(listed.recent_notes[0].text, /Acme signed/);
    assert.equal(r.tools.goal_note.run({ id: 'nope', note: 'x', digest: 'y' }).error, 'not_found_or_ambiguous');
    r.tools.goal_update.run({ id: g.id, status: 'done' });
    assert.equal(r.goals.list().length, 0);
    assert.equal(r.goals.list({ status: 'done' })[0].closed_at, '2026-11-01T11:00:00.000Z');
  } finally { r.done(); }
});

test('goals: active goals reach the context as one short line each; goal words load the goal tools', async () => {
  const r = rig();
  try {
    const g = r.goals.add({ title: 'Run a half marathon', digest: 'Long run up to 14 km; race on 15 Dec. ' + 'x'.repeat(400) });
    const memory = { pinned: () => [], searchHybrid: () => [], search: () => [] };
    const cb = new ContextBuilder({ memory, store: r.store, goals: r.goals });
    const { text } = await cb.build({ text: 'hello' });
    assert.match(text, new RegExp(`\\[${g.id.slice(0, 8)}\\] Run a half marathon: Long run up to 14 km`));
    assert.ok(text.length < 600, 'the digest is clipped in context');
    const sel = new ToolRouter({ enabled: true }).select({ text: 'how am I doing on my goals?' });
    assert.ok(sel.has('goals'), 'the goals tool group is loaded for that turn');
  } finally { r.done(); }
});
