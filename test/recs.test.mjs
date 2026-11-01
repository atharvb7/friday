import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Recs, recTools } from '../src/recs.mjs';
import { ContextBuilder } from '../src/agent/context-builder.mjs';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-recs-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store); settings.set('timezone', 'Asia/Kolkata');
  let t = Date.parse('2026-11-01T06:00:00Z');
  const recs = new Recs({ store, settings, now: () => new Date(t) });
  const tools = Object.fromEntries(recTools(recs).map((x) => [x.name, x]));
  return { store, recs, tools, tick: (days) => { t += days * 86_400_000; }, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('recs: a suggestion needs evidence and an expected result; money needs something checkable; it is decided, then scored', () => {
  const r = rig();
  try {
    assert.match(r.tools.rec_add.run({ title: 'Pitch freight forwarders in Pune', because: '', expect: 'x' }).error, /because required/);
    assert.match(r.tools.rec_add.run({ title: 'Buy Hunter.io', because: 'it would help', expect: 'more emails found', cost: '$49/month' }).error, /evidence required/);
    const paid = r.tools.rec_add.run({ title: 'Buy Hunter.io', because: 'contact step failed for 9 of 14 audited companies this week', expect: 'contacts found for 70%+', cost: '$49/month', category: 'tools', review_on: '2026-11-20' });
    assert.equal(paid.review_on, '2026-11-20T03:30:00.000Z', 'a plain date is 09:00 local');
    const seg = r.tools.rec_add.run({ title: 'Pitch freight forwarders in Pune', because: '3 of 4 audited had manual quote forms', expect: '2 replies from 15 emails', category: 'sales', review_on: '10' });
    assert.equal(r.tools.rec_decide.run({ id: 'freight', status: 'accepted' }).status, 'accepted');
    assert.equal(r.tools.rec_decide.run({ id: paid.id, status: 'declined', note: 'too expensive for now' }).status, 'declined');
    assert.match(r.tools.rec_decide.run({ id: paid.id, status: 'accepted' }).error, /already_declined/);
    assert.match(r.tools.rec_score.run({ id: paid.id, outcome: 'failed', note: 'x' }).error, /declined: nothing to score/);
    assert.match(r.tools.rec_score.run({ id: seg.id, outcome: 'worked', note: '' }).error, /note required/);

    assert.equal(r.recs.dueForReview().length, 0);
    r.tick(11);
    assert.deepEqual(r.recs.dueForReview().map((x) => x.title), ['Pitch freight forwarders in Pune']);
    r.tools.rec_score.run({ id: seg.id, outcome: 'worked', note: '3 replies from 15, one call booked' });
    assert.equal(r.recs.dueForReview().length, 0);
    const s = r.tools.rec_list.run({}).stats;
    assert.equal(s.acceptance, 0.5); assert.equal(s.hit_rate, 1); assert.equal(s.by_category.sales.worked, 1);
  } finally { r.done(); }
});

test('recs: an open suggestion past its act-by date expires; due reviews reach the context', async () => {
  const r = rig();
  try {
    const x = r.recs.add({ title: 'Move follow-up to day 4', because: 'day-3 follow-ups got 0 of 12 replies', expect: 'follow-up replies above 10%', actBy: 2, reviewOn: 5 });
    r.tick(3);
    assert.equal(r.recs.get(x.id).status, 'open');
    r.recs.list();
    assert.equal(r.recs.get(x.id).status, 'expired');
    r.tick(3);
    const cb = new ContextBuilder({ memory: { pinned: () => [], searchHybrid: () => [], touch() {} }, store: r.store, recs: r.recs });
    const { text } = await cb.build({ text: 'hi' });
    assert.match(text, new RegExp(`suggestions due for review[\\s\\S]*\\[${x.id.slice(0, 8)}\\] "Move follow-up to day 4"`));
  } finally { r.done(); }
});
