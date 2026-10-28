// Regression tests for outreach bugs found in the Oct 2026 code review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Pipeline } from '../src/pipeline.mjs';

const DAY = 86_400_000;
const BODY = 'A specific, honest observation about your business and one question for you.';
function setup({ slowSend = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-review-pipe-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store);
  let t = Date.parse('2026-10-25T09:00:00Z');
  const sent = []; const inbox = [];
  const gmail = {
    ready: true,
    async send(m) { if (slowSend) await new Promise((r) => setTimeout(r, 30)); sent.push({ op: 'send', ...m }); return { sent: true, id: `m${sent.length}`, thread_id: `t${sent.length}` }; },
    async reply(m) { sent.push({ op: 'reply', ...m }); return { sent: true, id: `m${sent.length}`, thread_id: 't1' }; },
    async search({ query }) { return { messages: inbox.filter((m) => (query.includes('mailer-daemon') ? m.from.includes('mailer-daemon') : !m.from.includes('mailer-daemon'))) }; },
  };
  settings.set('outreach_window', { start: '00:00', end: '23:59', days: [1, 2, 3, 4, 5, 6, 7] }); settings.set('outreach_spacing_min', [0, 0]);
  const p = new Pipeline({ store, settings, gmail, notifications: { create() {} }, now: () => t, sleep: async () => {} });
  return { store, settings, p, sent, inbox, advance: (ms) => { t += ms; }, now: () => t, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('outbox: two overlapping flushes send a queued email once', async () => {
  const s = setup({ slowSend: true });
  try {
    const id = s.p.save({ company: 'Acme', contact_name: 'A', email: 'a@acme.com' }).id;
    s.store.db.prepare("INSERT INTO outbox (id,lead_id,to_addr,subject,body,follow_up,opt_out,scheduled_at,created_at) VALUES ('o1',?,?,?,?,0,1,?,?)")
      .run(id, 'a@acme.com', 'idea', BODY, new Date(s.now() - 1000).toISOString(), new Date(s.now()).toISOString());
    await Promise.all([s.p.flushOutbox(), s.p.flushOutbox()]);
    assert.deepEqual(s.sent.map((m) => m.to), ['a@acme.com']);
    // A row left 'sending' by a crash is never resent blindly.
    s.store.db.prepare("UPDATE outbox SET status='sending' WHERE id='o1'").run();
    s.p.start(); s.p.stop();
    assert.equal(s.store.db.prepare("SELECT status FROM outbox WHERE id='o1'").get().status, 'failed');
  } finally { s.close(); }
});

test('leads: re-saving a lead that replied or was lost cannot make it sendable again', async () => {
  const s = setup();
  try {
    const id = s.p.save({ company: 'Acme', contact_name: 'A', email: 'a@acme.com' }).id;
    s.store.db.prepare("UPDATE leads SET stage='replied' WHERE id=?").run(id);
    assert.equal(s.p.save({ company: 'Acme', email: 'a@acme.com', stage: 'researched', research: 'more notes' }).stage, 'replied');
    s.store.db.prepare("UPDATE leads SET stage='lost' WHERE id=?").run(id);
    assert.equal(s.p.save({ company: 'Acme', email: 'a@acme.com', stage: 'new' }).stage, 'lost');
    assert.equal(s.p.save({ company: 'Acme', email: 'a@acme.com', stage: 'won' }).stage, 'won', 'moving forward is still allowed');
  } finally { s.close(); }
});

test('replies: "No thanks" with a sign-off and HTML-escaped opt-outs put the sender on do-not-contact; "No problem" does not', async () => {
  const s = setup();
  try {
    const leads = ['a', 'b', 'c', 'd'].map((x) => s.p.save({ company: `Co ${x}`, contact_name: x.toUpperCase(), email: `${x}@co${x}.com` }).id);
    await s.p.send(leads.map((id) => ({ lead_id: id, subject: 'idea', body: BODY })));
    s.advance(DAY);
    const date = new Date(s.now()).toUTCString();
    s.inbox.push(
      { id: 'r1', from: 'a@coa.com', subject: 'Re: idea', date, snippet: 'No thanks Regards, John Smith CEO, Co A' },
      { id: 'r2', from: 'b@cob.com', subject: 'Re: idea', date, snippet: 'please don&#39;t email me again' },
      { id: 'r3', from: 'c@coc.com', subject: 'Re: idea', date, snippet: 'No problem, send the plan over' },
      { id: 'r4', from: 'd@cod.com', subject: 'Re: idea', date, snippet: 'Stop. Sent from my iPhone' });
    await s.p.tick();
    assert.ok(s.p.isSuppressed('a@coa.com'));
    assert.ok(s.p.isSuppressed('b@cob.com'));
    assert.ok(!s.p.isSuppressed('c@coc.com'));
    assert.equal(s.p.byEmail('c@coc.com').stage, 'replied');
    assert.ok(s.p.isSuppressed('d@cod.com'));
  } finally { s.close(); }
});

test('opt-out: a body that only mentions "opt out" still gets the footer; display names and subdomains are suppressed', async () => {
  const s = setup();
  try {
    const id = s.p.save({ company: 'Acme', contact_name: 'A', email: 'a@acme.com' }).id;
    const [m] = s.p.prepare([{ lead_id: id, subject: 'idea', body: 'Your site makes customers email you to opt out of reminders, which is manual work.' }]);
    assert.equal(m.opt_out, true);
    const [own] = s.p.prepare([{ lead_id: id, subject: 'idea', body: `${BODY} Not relevant? Reply "no" and I won't email again.` }]);
    assert.equal(own.opt_out, false, 'a body with its own opt-out line does not repeat it');
    assert.equal(s.p.suppress('John <john@beta.com>').suppressed, 'john@beta.com');
    assert.ok(s.p.isSuppressed('john@beta.com'));
    s.p.suppress('gamma.com');
    assert.ok(s.p.isSuppressed('x@mail.gamma.com'));
    assert.ok(!s.p.isSuppressed('x@notgamma.com'));
  } finally { s.close(); }
});

test('pause: the bounce breaker\'s indefinite stop replaces a running 24-hour pause', async () => {
  const s = setup();
  try {
    s.p.pause('Gmail refused', { hours: 24 });
    s.p.pause('too many bounces');
    s.advance(25 * 3600_000);
    assert.match(s.p.paused()?.reason ?? '', /bounces/);
    s.settings.set('outreach_paused', null);
    s.p.pause('too many bounces');
    s.p.pause('Gmail refused', { hours: 24 });
    assert.match(s.p.paused().reason, /bounces/, 'a timed pause never shortens an indefinite one');
  } finally { s.close(); }
});

test('follow-ups: no email after the sequence is finished', async () => {
  const s = setup();
  try {
    const id = s.p.save({ company: 'Acme', contact_name: 'A', email: 'a@acme.com' }).id;
    s.store.db.prepare("UPDATE leads SET stage='contacted', touches=4, last_message_id='m9' WHERE id=?").run(id);
    const [m] = s.p.prepare([{ lead_id: id, follow_up: true, body: BODY }]);
    assert.match(m.blocked ?? '', /sequence is finished/);
  } finally { s.close(); }
});

test('email tools: a reply with an explicit do-not-contact recipient and a draft to one are refused', async () => {
  const { buildFridayTools } = await import('../src/agent/friday-tools.mjs');
  const s = setup();
  try {
    const calls = [];
    const gmail = { async reply(a) { calls.push(['reply', a]); return { sent: true, id: 'x' }; }, async draft(a) { calls.push(['draft', a]); return { drafted: true }; }, async organize() { return {}; } };
    const tools = buildFridayTools({ memory: {}, store: s.store, tools: null, indexer: null, jobs: {}, proactive: {}, settings: s.settings, pipeline: s.p, files: { resolve: () => null }, gmail, gmailOutreach: gmail });
    s.p.suppress('stop@delta.dev');
    assert.match((await tools.get('email_send').run({ op: 'reply', message_id: 'm1', to: 'stop@delta.dev', body: 'hi' })).error, /do_not_contact/);
    assert.match((await tools.get('email_organize').run({ op: 'draft', to: 'Stop <stop@delta.dev>', subject: 's', body: 'b' })).error, /do_not_contact/);
    assert.equal(calls.length, 0);
    assert.equal((await tools.get('email_organize').run({ op: 'draft', to: 'ok@delta.dev', subject: 's', body: 'b' })).drafted, true);
  } finally { s.close(); }
});
