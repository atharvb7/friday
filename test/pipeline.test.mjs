import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Pipeline, DEFAULT_OPT_OUT } from '../src/pipeline.mjs';
import { Skills } from '../src/skills.mjs';
import { buildFridayTools } from '../src/agent/friday-tools.mjs';

const DAY = 86_400_000;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-pipe-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store);
  let t = Date.parse('2026-10-25T09:00:00Z');
  const sent = []; const inbox = [];
  const gmail = {
    ready: true,
    async send(m) { sent.push({ op: 'send', ...m }); return { sent: true, id: `m${sent.length}`, thread_id: `t${sent.length}` }; },
    async reply(m) { sent.push({ op: 'reply', ...m }); return { sent: true, id: `m${sent.length}`, thread_id: 't1' }; },
    async search({ query }) { return { messages: inbox.filter((m) => (query.includes('mailer-daemon') ? m.from.includes('mailer-daemon') : !m.from.includes('mailer-daemon'))) }; },
  };
  const notes = [];
  const p = new Pipeline({ store, settings, gmail, notifications: { create: (n) => notes.push(n) }, now: () => t, sleep: async () => {} });
  return { dir, store, settings, p, sent, inbox, notes, advance: (ms) => { t += ms; }, now: () => t, close: () => { store.db.close?.(); rmSync(dir, { recursive: true, force: true }); } };
}

test('pipeline: leads upsert, outreach batch adds opt-out, schedules follow-ups and threads them', async () => {
  const s = setup();
  try {
    const a = s.p.save({ company: 'Acme Dental', website: 'https://www.acmedental.in', contact_name: 'Dr Rao', email: 'Rao@AcmeDental.in', offer: 'voice agent', signal: 'phone-only booking' });
    assert.equal(a.created, true); assert.equal(a.email, 'rao@acmedental.in'); assert.equal(a.domain, 'acmedental.in'); assert.equal(a.stage, 'new');
    assert.equal(s.p.save({ company: 'Acme Dental', email: 'rao@acmedental.in', research: 'Two branches, one number.' }).updated, true);
    assert.equal(s.p.find({}).count, 1);
    assert.throws(() => s.p.save({ company: 'X', email: 'not-an-email' }), /invalid email/);

    const body = 'Saw you only take bookings by phone. Most clinics lose evening calls; we answer them with a voice agent. Worth a look?';
    assert.match(s.p.summarize([{ lead_id: a.id, subject: 'evening calls', body }]), /Send 1 outreach email/);
    const r = await s.p.send([{ lead_id: a.id, subject: 'evening calls', body }]);
    assert.equal(r.sent, 1);
    assert.ok(s.sent[0].body.endsWith(DEFAULT_OPT_OUT));
    let l = s.p.get(a.id);
    assert.equal(l.stage, 'contacted'); assert.equal(l.touches, 1); assert.equal(l.last_message_id, 'm1');
    assert.equal(Date.parse(l.next_at) - s.now(), 3 * DAY);

    // nothing due yet; after 3 days the follow-up is due, nudged once per day, and goes into the same thread
    assert.equal(s.p.find({ due: true }).count, 0);
    s.advance(3 * DAY + 1000);
    assert.equal(s.p.find({ due: true }).count, 1);
    await s.p.tick(); await s.p.tick();
    assert.equal(s.notes.filter((n) => /follow-up/.test(n.title)).length, 1);
    await s.p.send([{ lead_id: a.id, follow_up: true, body: 'One idea: forward after-hours calls to the agent, keep your staff for the day. Want the 2-minute demo? Reply no and I won\'t follow up.' }]);
    assert.equal(s.sent[1].op, 'reply'); assert.equal(s.sent[1].message_id, 'm1'); assert.equal(s.sent[1].to, 'rao@acmedental.in');
    assert.ok(!s.sent[1].body.includes(DEFAULT_OPT_OUT), 'existing opt-out wording is kept, not duplicated');
    l = s.p.get(a.id); assert.equal(l.touches, 2); assert.equal(Date.parse(l.next_at) - s.now(), 4 * DAY);
  } finally { s.close(); }
});

test('pipeline: do-not-contact, cap and batch validation are enforced in code', async () => {
  const s = setup();
  try {
    const a = s.p.save({ company: 'Beta', email: 'ceo@beta.io' });
    s.p.suppress('beta.io', 'competitor');
    assert.equal(s.p.get(a.id).stage, 'dnc');
    assert.ok(s.p.isSuppressed('anyone@beta.io'));
    assert.deepEqual(s.p.blockedRecipients('X <ceo@beta.io>, ok@gamma.io'), ['ceo@beta.io']);
    const body = 'A specific, honest observation about your business and one question for you.';
    const r = await s.p.send([{ to: 'ceo@beta.io', subject: 'hi', body }]);
    assert.equal(r.sent, 0); assert.equal(r.results[0].skipped, 'do-not-contact'); assert.equal(s.sent.length, 0);
    assert.equal(s.p.save({ company: 'Beta again', email: 'cto@beta.io' }).stage, 'dnc');
    assert.throws(() => s.p.update(a.id, { stage: 'contacted' }), /do-not-contact/);

    s.p.save({ company: 'X', email: 'a@x.io' });
    assert.throws(() => s.p.prepare([{ to: 'a@x.io', subject: 's', body }, { to: 'A@x.io', subject: 's', body }]), /twice/);
    assert.throws(() => s.p.prepare(Array.from({ length: 16 }, () => ({ to: 'a@x.io', subject: 's', body }))), /at most 15/);
    assert.throws(() => s.p.prepare([{ to: 'a@x.io', body }]), /subject required/);

    s.settings.set('outreach_daily_cap', 2);
    assert.throws(() => s.p.prepare([{ to: 'stranger@gamma.io', subject: 'quick idea', body }]), /not in the pipeline/);
    for (const i of [1, 2, 3]) s.p.save({ company: `G${i}`, email: `q${i}@gamma.io` });
    const out2 = await s.p.send([1, 2, 3].map((i) => ({ to: `q${i}@gamma.io`, subject: 'quick idea', body })));
    assert.equal(out2.sent, 2); assert.match(out2.results[2].skipped, /daily cap/);
  } finally { s.close(); }
});

test('pipeline: replies stop the sequence; unsubscribe, out-of-office and bounces are handled', async () => {
  const s = setup();
  try {
    const body = 'A specific, honest observation about your business and one question for you.';
    const ids = ['a', 'b', 'c', 'd'].map((x) => s.p.save({ company: `Co ${x}`, contact_name: x.toUpperCase(), email: `${x}@co${x}.com` }).id);
    await s.p.send(ids.map((id) => ({ lead_id: id, subject: 'idea', body })));
    s.advance(DAY);
    const date = new Date(s.now()).toUTCString();
    s.inbox.push(
      { id: 'r1', from: 'A <a@coa.com>', subject: 'Re: idea', date, snippet: 'Sounds interesting, can you share pricing? On Sun, 25 Oct 2026 Atharv wrote: A specific...' },
      { id: 'r2', from: 'b@cob.com', subject: 'Re: idea', date, snippet: 'no On Sun, 25 Oct 2026 Atharv <x@y.z> wrote: Not relevant? Just reply "no"' },
      { id: 'r3', from: 'c@coc.com', subject: 'Automatic reply: idea', date, snippet: 'I am out of office until Monday.' },
      { id: 'r4', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification', date, snippet: 'Address not found. Your message wasn\'t delivered to d@cod.com because the address couldn\'t be found' },
    );
    const t = await s.p.tick();
    assert.equal(t.replies, 3); assert.equal(t.bounces, 1);
    const [a, b, c, d] = ids.map((id) => s.p.get(id));
    assert.equal(a.stage, 'replied'); assert.equal(a.next_at, null);
    assert.ok(s.notes.some((n) => /A \(Co a\) replied/.test(n.title)));
    assert.equal(b.stage, 'dnc'); assert.ok(s.p.isSuppressed('b@cob.com'));
    assert.equal(c.stage, 'contacted'); assert.equal(Date.parse(c.next_at) - s.now(), 7 * DAY);
    assert.equal(d.stage, 'lost');
    // the same reply is not processed twice; replied leads are skipped by outreach
    assert.equal((await s.p.tick()).replies, 0);
    assert.match(s.p.prepare([{ lead_id: a.id, subject: 'x', body }])[0].blocked, /replied/);
    assert.deepEqual(s.p.stats().by_stage, { replied: 1, dnc: 1, contacted: 1, lost: 1 });
  } finally { s.close(); }
});

test('business tools: email_send refuses do-not-contact and logs touches; outreach is gated; skills expose references', async () => {
  const s = setup();
  try {
    const sends = [];
    const ctx = { memory: {}, store: s.store, tools: null, indexer: null, jobs: {}, proactive: {}, settings: s.settings, researchMemory: null, nodes: null, pipeline: s.p,
      skills: new Skills({ roots: [new URL('../skills', import.meta.url).pathname] }), files: { resolve: () => null },
      gmail: { async send(a) { sends.push(a); return { sent: true, id: 'g1', thread_id: 'gt1' }; } } };
    const tools = buildFridayTools(ctx);
    assert.equal(tools.get('outreach_send').risk, 'gated');
    for (const n of ['business_profile', 'lead_save', 'lead_find', 'lead_update', 'do_not_contact']) assert.equal(tools.get(n).risk, 'safe', n);

    assert.equal((await tools.get('lead_save').run({ leads: [{ company: 'Delta', email: 'cto@delta.dev' }, { company: 'Bad', email: 'nope' }] })).saved, 1);
    await tools.get('do_not_contact').run({ value: 'stop@delta.dev' });
    const refused = await tools.get('email_send').run({ op: 'send', to: 'stop@delta.dev', subject: 's', body: 'b' });
    assert.match(refused.error, /do_not_contact/); assert.equal(sends.length, 0);
    await tools.get('email_send').run({ op: 'send', to: 'cto@delta.dev', subject: 'hello', body: 'b' });
    assert.equal(s.p.byEmail('cto@delta.dev').touches, 1);

    assert.match(tools.get('business_profile').run({ op: 'get' }).note, /No business profile/);
    tools.get('business_profile').run({ op: 'set', text: '# Us\nWe build AI voice agents and automations.' });
    assert.match(tools.get('business_profile').run({ op: 'get' }).profile, /voice agents/);

    const bd = tools.get('skill_load').run({ name: 'business-development' });
    assert.ok(bd.references.includes('plays.md'));
    assert.match(tools.get('skill_load').run({ name: 'business-development', reference: 'plays.md' }).text, /Voice agents/);
    assert.equal(tools.get('skill_load').run({ name: 'cold-email', reference: '../SKILL.md' }).error, 'reference_not_found');
    assert.match(tools.get('skill_load').run({ name: 'cold-email', reference: 'reply-handling.md' }).text, /Unsubscribe/);
  } finally { s.close(); }
});
