import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Prospector } from '../src/prospector.mjs';

// A small simulated world: Google Maps returns three businesses; their websites say what they say.
const SITES = {
  'https://falcon.example/': { html: '<a href="/contact">Contact</a> <a href="/about-us">About</a>', text: 'Falcon Cargo. Freight forwarding from Dubai to the world. Request a quote by email and our team will get back to you within 48 hours.' },
  'https://falcon.example/contact': { html: '<a href="mailto:omar.khan@falcon.example">Email Omar</a>', text: 'Contact us. For every shipment quote, email your cargo details and our team will prepare a quote manually. Omar Khan, Operations Director' },
  'https://falcon.example/about-us': { html: '', text: 'About Falcon. Founded 2009, 40 staff across two offices.' },
  'https://agentai.example/': { html: '<a href="mailto:hi@agentai.example">x</a>', text: 'AgentAI builds AI agents for logistics companies. Our engineering team ships agentic workflows.' },
  'https://quiet.example/': { html: '', text: 'Quiet Movers. Book a move by phone: we confirm every booking with a call back from our office.' },
};
const MAPS = { local_results: [
  { title: 'Falcon Cargo', website: 'https://falcon.example/', data_id: 'd1', rating: 3.9, reviews: 40, type: 'Freight forwarding service' },
  { title: 'AgentAI', website: 'https://agentai.example/', data_id: 'd2', rating: 4.8, reviews: 12, type: 'Logistics service' },
  { title: 'CodeShop', website: 'https://codeshop.example/', data_id: 'd5', type: 'Software company' },
  { title: 'Quiet Movers', website: 'https://quiet.example/', data_id: 'd3', rating: 4.1, reviews: 2, type: 'Moving company' },
  { title: 'Only Facebook', website: 'https://facebook.com/onlyfb', data_id: 'd4' },
] };

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-prospect-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store);
  settings.set('timezone', 'Asia/Kolkata');
  settings.set('outreach_signature', 'Atharv Bhosale\nAI Engineer');
  settings.set('business_profile', { text: '# Profile\n## Proof and credibility\n- Friday: our own production agent.\n- Worked on Sorch.\n## Messaging\nWrite like the reference.\n## Gives\n- plan' });
  const serpCalls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url); serpCalls.push(Object.fromEntries(u.searchParams));
    const body = u.searchParams.get('engine') === 'google_maps' ? (u.searchParams.get('start') === '0' ? MAPS : { local_results: [] })
      : { reviews: [{ rating: 1, snippet: 'Waited three days for a quote, nobody answered the phone.' }], place_info: { place_id: 'p1' } };
    return { ok: true, json: async () => body };
  };
  const fetchPage = async (url) => { const s = SITES[url]; if (!s) throw new Error('404'); return { url, text: s.text, html: s.html }; };
  const mx = async (domain) => (domain === 'falcon.example' || domain === 'quiet.example' ? [{ exchange: 'mx' }] : []);
  // The "models": an auditor that also tries to sneak in a fake quote, and a writer whose first draft breaks the rules.
  const writes = [];
  const ai = { async run(role, { messages }) {
    const sys = messages[0].content;
    if (sys.startsWith('You audit')) {
      const page = messages[1].content;
      if (page.includes('Falcon')) return { content: JSON.stringify({ what_they_do: 'Freight forwarder in Dubai', size_hint: '40 staff', customer_entry: ['email quote requests'],
        gaps: [{ process: 'Quote requests handled manually by email', evidence_quote: 'email your cargo details and our team will prepare a quote manually', evidence_url: 'https://falcon.example/contact', why_it_costs_them: 'slow quotes lose shipments' },
          { process: 'Slow quote replies', evidence_quote: 'Request a quote by email and our team will get back to you within 48 hours', evidence_url: 'https://falcon.example/', why_it_costs_them: 'two days is long for a quote' },
          { process: 'Invented gap', evidence_quote: 'we process 500 quotes a day in excel', evidence_url: 'https://falcon.example/', why_it_costs_them: 'made up' }],
        decision_makers: [{ name: 'Omar Khan', role: 'Operations Director', quote: 'Omar Khan, Operations Director', url: 'https://falcon.example/contact' }, { name: 'Priya Fake', role: 'CEO' }],
        has_engineering_team: false, best_offer: 'automation', what_we_would_build: ['quote agent', 'approval step', 'live view'] }) };
      if (page.includes('AgentAI')) return { content: JSON.stringify({ what_they_do: 'AI agents', gaps: [], has_engineering_team: true, best_offer: 'none' }) };
      return { content: JSON.stringify({ what_they_do: 'Movers', gaps: [{ process: 'Phone-only booking', evidence_quote: 'we confirm every booking with a call back from our office', evidence_url: 'https://quiet.example/' }], decision_makers: [], has_engineering_team: false, best_offer: 'automation', what_we_would_build: ['booking agent'] }) };
    }
    writes.push(messages.length);
    const body = messages.length === 2
      ? 'Hi Omar,\n\nI\'m reaching out because your team prepares every quote manually → slow. Worth a 15-min call?'
      : 'Hi Omar,\n\nNoticed Falcon asks customers to email cargo details so the team can prepare each quote manually.\n\n**I design and ship production agentic systems.**\n\n### What I\'d build for Falcon Cargo\n- An agent that drafts each quote\n- Approval before anything goes out\n\nWant me to send the one-page architecture plan for Falcon Cargo?';
    return { content: JSON.stringify({ subject: 'quote requests at falcon', body }) };
  } };
  const approvals = []; const notes = [];
  const pipeline = new Pipeline({ store, settings, notifications: { create: (n) => notes.push(n) } });
  const judge = { ready: true, qualify: async ({ lead }) => (/Phone-only/.test(lead.gap) ? { verdict: 'hold', why: 'possible fit, evidence not strong enough yet' } : { verdict: 'qualify', why: 'ok' }) };
  const prospector = new Prospector({ store, settings, ai, judge, pipeline, approvals: { request: (a) => { approvals.push(a); return { id: 'appr-1234567' }; } }, notifications: { create: (n) => notes.push(n) }, serpKey: 'k', fetchImpl, fetchPage, mx });
  return { dir, store, settings, prospector, pipeline, serpCalls, approvals, notes, writes, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('prospector: source -> audit with verified evidence -> qualify -> contact -> draft/review/rewrite -> one approval', async () => {
  const w = world();
  try {
    assert.throws(() => w.prospector.setConfig({ enabled: true }), /at least one segment/);
    assert.throws(() => w.prospector.setConfig({ segments: [{ vertical: 'freight forwarders', location: 'Dubai', timezone: 'Mars/Base' }] }), /IANA/);
    w.prospector.setConfig({ enabled: true, segments: [{ vertical: 'freight forwarders', location: 'Mumbai', timezone: 'Asia/Kolkata' }], daily_new: 2, serp_budget: 20 });
    const r = await w.prospector.runOnce({ reason: 'test' });

    assert.equal(r.found, 3, 'social-only listing ignored');
    assert.equal(w.serpCalls[0].engine, 'google_maps'); assert.equal(w.serpCalls[0].q, 'freight forwarders in Mumbai');
    assert.deepEqual(r.skipped.map((s) => s.company), ['AgentAI']);
    assert.match(r.skipped[0].why, /engineering team/);
    assert.deepEqual(r.hold.map((s) => s.company), ['Quiet Movers']);
    assert.deepEqual(r.qualified.map((q) => q.company), ['Falcon Cargo']);

    const lead = w.pipeline.byEmail('omar.khan@falcon.example');
    assert.equal(lead.contact_name, 'Omar Khan', 'personal email matched to a verified name');
    assert.equal(lead.timezone, 'Asia/Kolkata'); assert.equal(lead.stage, 'researched');
    assert.match(w.pipeline.render({ lead_id: lead.id, body: 'Hi Omar,\n\nx', follow_up: false }).text, /P\.S\. I found your address on falcon\.example\/contact\. Not relevant/);
    assert.doesNotMatch(w.pipeline.render({ lead_id: lead.id, body: 'x', follow_up: true }).text, /found your address/, 'not repeated in follow-ups');
    assert.match(lead.signal, /prepare a quote manually" \(https:\/\/falcon\.example\/contact\)/);
    assert.doesNotMatch(lead.signal, /500 quotes/, 'a quote that is not on the page never reaches the lead');
    const audit = JSON.parse(w.store.db.prepare("SELECT audit FROM prospects WHERE company='Falcon Cargo'").get().audit);
    assert.equal(audit.dropped, 1); assert.deepEqual(audit.decision_makers.map((d) => d.name), ['Omar Khan'], 'unverified names dropped');

    assert.equal(r.drafts, 1); assert.deepEqual(w.writes, [2, 4], 'first draft failed review, the rewrite passed');
    assert.equal(w.approvals.length, 1); assert.equal(w.approvals[0].tool, 'outreach_send');
    assert.equal(w.approvals[0].payload.emails[0].lead_id, lead.id); assert.match(w.approvals[0].payload.emails[0].body, /one-page architecture plan/);
    assert.match(w.notes.at(-1).title, /Outreach ready: 1 new/); assert.match(w.notes.at(-1).body, /Skipped: AgentAI/);
    assert.equal(w.prospector.serpUsed(), w.serpCalls.length);
    assert.equal(w.serpCalls.filter((c) => c.engine === 'google_maps_reviews').length, 1, 'reviews only for the listing with enough reviews');

    // one piece of evidence is a "maybe", not a pitch
    w.prospector.setConfig({ min_evidence: 3 });
    const again = w.store.db.prepare("SELECT * FROM prospects WHERE company='Falcon Cargo'").get();
    w.store.db.prepare("UPDATE prospects SET status='new' WHERE id=?").run(again.id); w.store.db.prepare('DELETE FROM leads').run();
    const held = await w.prospector.audit({ ...again, status: 'new' });
    assert.equal(held.status, 'hold'); assert.match(held.reason, /only 2 piece/);
    w.prospector.setConfig({ min_evidence: 2 });

    // budget: once spent, no more searches
    w.prospector.setConfig({ serp_budget: w.prospector.serpUsed() });
    assert.equal(await w.prospector.source(5), 0);
  } finally { w.close(); }
});

test('prospector: schedule fires once per chosen day after run_at, in the user time zone', async () => {
  const w = world();
  try {
    let now = Date.parse('2026-10-26T02:00:00Z'); // Monday 07:30 IST
    const p = new Prospector({ store: w.store, settings: w.settings, ai: { run: async () => ({ content: '{}' }) }, pipeline: w.pipeline, notifications: { create() {} }, now: () => now });
    p.setConfig({ enabled: true, segments: [{ vertical: 'x', location: 'y', timezone: 'Asia/Kolkata' }], run_at: '08:30', days: [1, 2, 3, 4, 5] });
    assert.equal(await p.tick(), null, 'before 08:30');
    now = Date.parse('2026-10-26T03:05:00Z'); // 08:35 IST
    assert.ok(await p.tick(), 'runs');
    assert.equal(await p.tick(), null, 'only once that day');
    now = Date.parse('2026-11-01T04:00:00Z'); // Sunday
    assert.equal(await p.tick(), null, 'not on Sunday');
  } finally { w.close(); }
});

test('prospector: market rules (Germany refused, Gulf = role addresses only, US needs a postal address)', async () => {
  const w = world();
  try {
    assert.throws(() => w.prospector.setConfig({ segments: [{ vertical: 'logistics', location: 'Berlin', timezone: 'Europe/Berlin' }] }), /consent/);
    // Gulf: Falcon only publishes a personal address -> not used; no role address anywhere -> no_contact
    w.prospector.setConfig({ segments: [{ vertical: 'freight forwarders', location: 'Dubai', timezone: 'Asia/Dubai' }], daily_new: 1, serp_budget: 50 });
    await w.prospector.source(5);
    const falcon = w.store.db.prepare("SELECT * FROM prospects WHERE company='Falcon Cargo'").get();
    const r = await w.prospector.audit(falcon);
    assert.equal(r.status, 'no_contact');
    assert.equal(w.pipeline.byEmail('omar.khan@falcon.example'), null);
    // US: the house-style lint requires the sender's postal address, and the footer carries it
    const us = w.pipeline.save({ company: 'Oak PM', email: 'dana@oak.example', timezone: 'America/Chicago', signal: 'maintenance requests by phone (https://oak.example/contact)' });
    const body = 'Hi Dana,\n\nNoticed Oak takes maintenance requests by phone only.\n\nWant me to send the one-page plan for Oak?';
    let rev = await w.pipeline.review([{ lead_id: us.id, subject: 'maintenance at oak', body }]);
    assert.match(rev.emails[0].fix.join(' '), /CAN-SPAM requires your postal address/);
    w.prospector.setConfig({ postal_address: 'Atharv Bhosale, 1 Example Road, Pune 411001, India' });
    rev = await w.pipeline.review([{ lead_id: us.id, subject: 'maintenance at oak', body }]);
    assert.equal(rev.ok, true);
    assert.match(w.pipeline.render({ lead_id: us.id, body, follow_up: false }).text, /Pune 411001, India$/);
  } finally { w.close(); }
});
