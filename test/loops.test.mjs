import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { loops } from '../src/loops.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-loops-'));
  const store = new Store(join(dir, 'db.sqlite'));
  let t = Date.parse('2026-11-01T10:00:00Z');
  const notes = [];
  loops.reset();
  loops.attach({ db: store.db, notify: (n) => notes.push(n), now: () => t });
  return { store, notes, tick: (ms) => { t += ms; }, done: () => { loops.reset(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('loops: a failing streak alerts once after 3, recovery says so, state survives a restart', async () => {
  const r = rig();
  try {
    let fail = true;
    const run = loops.loop('pipeline', async () => { if (fail) throw new Error('imap timeout'); }, { everyMs: 60_000 });
    for (let i = 0; i < 2; i++) { await run(); r.tick(60_000); }
    assert.equal(r.notes.length, 0, 'two failures are not news yet');
    let l = loops.list().find((x) => x.name === 'pipeline');
    assert.equal(l.status, 'failing'); assert.equal(l.streak, 2); assert.equal(l.last_error, 'imap timeout');
    const since = l.failing_since;
    for (let i = 0; i < 3; i++) { await run(); r.tick(60_000); }
    assert.equal(r.notes.length, 1, 'one warning per streak, not one per run');
    assert.equal(r.notes[0].level, 'warning'); assert.match(r.notes[0].title, /Background job failing: pipeline/); assert.match(r.notes[0].body, /imap timeout/);
    assert.equal(loops.list()[0].status, 'down');

    // Restart: the saved row brings back the streak and when it started.
    loops.reset(); loops.attach({ db: r.store.db, notify: (n) => r.notes.push(n), now: () => Date.parse('2026-11-01T10:10:00Z') });
    l = loops.list().find((x) => x.name === 'pipeline');
    assert.equal(l.streak, 5); assert.equal(l.failing_since, since); assert.equal(l.status, 'down');

    fail = false;
    const again = loops.loop('pipeline', async () => {}, { everyMs: 60_000 });
    await again();
    assert.equal(loops.list()[0].status, 'ok');
    assert.equal(r.notes.at(-1).level, 'success'); assert.match(r.notes.at(-1).body, /after 5 failed runs/);
    assert.equal(loops.list()[0].failing_since, null);
  } finally { r.done(); }
});

test('loops: a sync throw is recorded, never thrown into the timer; stale and stuck loops are named', async () => {
  const r = rig();
  try {
    const sync = loops.loop('jobs', () => { throw new Error('bad row'); }, { everyMs: 10_000 });
    await assert.doesNotReject(sync());
    assert.equal(loops.list().find((x) => x.name === 'jobs').last_error, 'bad row');

    const quiet = loops.loop('watches', async () => {}, { everyMs: 60_000 });
    await quiet();
    r.tick(5 * 60_000);
    assert.equal(loops.list().find((x) => x.name === 'watches').status, 'stale', 'no run for 3+ intervals');

    let release;
    const hang = loops.loop('prospector', () => new Promise((res) => { release = res; }), { everyMs: 60_000 });
    const p = hang();
    r.tick(11 * 60_000);
    assert.equal(loops.list().find((x) => x.name === 'prospector').status, 'stuck');
    release(); await p;
    assert.equal(loops.list().find((x) => x.name === 'prospector').status, 'ok');
  } finally { r.done(); }
});

test('loops: after a restart an old saved run is not "stale" until the loop had its chance; loops with no timer are "off"', async () => {
  const r = rig();
  try {
    const run = loops.loop('dm_chat', async () => {}, { everyMs: 45_000 });
    await run();
    // Restart 10 minutes later: the saved row is old, and the new timer has not fired yet.
    let t = Date.parse('2026-11-01T10:10:00Z');
    loops.reset(); loops.attach({ db: r.store.db, now: () => t });
    assert.equal(loops.list().find((x) => x.name === 'dm_chat').status, 'off', 'no timer in this process yet');
    const again = loops.loop('dm_chat', async () => {}, { everyMs: 45_000 });
    t += 30_000;
    assert.equal(loops.list().find((x) => x.name === 'dm_chat').status, 'waiting');
    t += 4 * 60_000;
    assert.equal(loops.list().find((x) => x.name === 'dm_chat').status, 'stale', 'armed 4.5 min ago and never ran');
    await again();
    assert.equal(loops.list().find((x) => x.name === 'dm_chat').status, 'ok');
  } finally { r.done(); }
});
