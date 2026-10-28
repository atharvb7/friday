import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Prospector, WRITERS } from '../src/prospector.mjs';
import { SalesJudge, judgeOutreach, judgeQualifyFde, FDE_OUTREACH_QUESTIONS, OUTREACH_QUESTIONS } from '../src/sales-judge.mjs';
import { OpenAICompatProvider } from '../src/ai/openai-compat.mjs';
import { prospectingTools } from '../src/agent/friday-tools.mjs';

// A stubbed world (no SerpApi, no models, no network): every Google Maps page lists two companies; each company's site
// says which kind it is: GAP (two verified manual-process quotes), FDE (no gap, operations-heavy) or TECH (engineers).
const KINDS = { 'freight forwarders in Pune': ['GAP', 'TECH', 'FDE', 'GAP', 'TECH', 'TECH'], 'customs brokers in Pune': ['FDE', 'GAP', 'TECH', 'TECH'] };
const GAP_TEXT = 'Send your shipment details by email and our desk prepares every quote by hand. Bookings are confirmed by phone after our team checks the documents.';
const FDE_TEXT = 'We handle customs clearance for importers across western India, with a team of brokers for every port we serve.';

function world({ settings: preset = {}, writer = null, judge = null, now = null, maps = KINDS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-prun-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store);
  settings.set('timezone', 'Asia/Kolkata');
  settings.set('outreach_signature', 'Atharv Bhosale');
  settings.set('business_profile', { text: '# Profile\n## Proof and credibility\n- Friday: our own production agent.\n## Messaging\nWrite like the reference.' });
  for (const [k, v] of Object.entries(preset)) settings.set(k, v);
  const serp = []; const sites = {};
  const fetchImpl = async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams); serp.push(q);
    if (q.engine !== 'google_maps') return { ok: true, json: async () => ({ organic_results: [], reviews: [] }) };
    const kinds = (maps[q.q] ?? []).slice(Number(q.start) / 10, Number(q.start) / 10 + 2); // 2 per page (pages are 20 apart)
    const local = kinds.map((kind, i) => {
      const slug = `${q.q.split(' ')[0]}-${q.start}-${i}-${kind.toLowerCase()}`; const site = `https://${slug}.example/`;
      sites[site] = { kind, text: `${slug} ${kind === 'GAP' ? GAP_TEXT : kind === 'FDE' ? FDE_TEXT : 'We build AI agents and software.'}`, html: `<a href="mailto:info@${slug}.example">mail</a>` };
      return { title: `${kind} ${slug}`, website: site, data_id: slug, reviews: 3, type: 'Freight forwarding service' };
    });
    return { ok: true, json: async () => ({ local_results: local }) };
  };
  const fetchPage = async (url) => { const s = sites[url]; if (!s) throw new Error('404'); return { url, text: s.text, html: s.html }; };
  const calls = [];
  const ai = { async run(role, opts) {
    calls.push({ role, ...opts, messages: undefined, sys: opts.messages[0].content, user: opts.messages.at(-1).content, n: opts.messages.length });
    if (opts.messages[0].content.startsWith('You audit')) {
      const page = opts.messages[1].content; const url = /=== PAGE (\S+)/.exec(page)[1];
      const kind = sites[url].kind;
      if (kind === 'TECH') return { content: JSON.stringify({ what_they_do: 'software', gaps: [], has_engineering_team: true, best_offer: 'none' }) };
      if (kind === 'FDE') return { content: JSON.stringify({ what_they_do: 'Customs broker', about_quote: 'We handle customs clearance for importers across western India, with a team of brokers', about_url: url, operations_heavy: true, gaps: [], decision_makers: [], has_engineering_team: false, legal_form: 'company', best_offer: 'automation' }) };
      return { content: JSON.stringify({ what_they_do: 'Freight forwarder', operations_heavy: true, gaps: [
        { process: 'Quotes prepared by hand', evidence_quote: 'Send your shipment details by email and our desk prepares every quote by hand', evidence_url: url },
        { process: 'Phone confirmations', evidence_quote: 'Bookings are confirmed by phone after our team checks the documents', evidence_url: url }],
      decision_makers: [], has_engineering_team: false, legal_form: 'company', best_offer: 'automation', what_we_would_build: ['quote agent'] }) };
    }
    if (writer) return writer(role, opts);
    const company = /Company: (.+?) \(/.exec(opts.messages[1].content)[1];
    return { content: JSON.stringify({ subject: 'quotes at your desk', body: `Hi ${company} team,\n\nSaw how your desk works on your site.\n\n**I'm a forward-deployed AI engineer.**\n\nWant me to send the one-page architecture plan for ${company}?` }) };
  } };
  const notes = []; const approvals = []; const events = [];
  const pipeline = new Pipeline({ store, settings, notifications: { create: (n) => notes.push(n) } });
  const prospector = new Prospector({ store, settings, ai, judge, pipeline, serpKey: 'k', fetchImpl, fetchPage, mx: async () => [{ exchange: 'mx' }],
    approvals: { request: (a) => { approvals.push(a); return { id: `appr-${approvals.length}-xxxx` }; } }, notifications: { create: (n) => notes.push(n) },
    bus: { publish: (type, data) => events.push({ type, data }) }, ...(now ? { now } : {}) });
  const segs = Object.keys(maps).map((q) => ({ vertical: q.split(' in ')[0], location: 'Pune', timezone: 'Asia/Kolkata' }));
  prospector.setConfig({ enabled: true, segments: segs, serp_budget: 100, day_searches: 20 });
  return { dir, store, settings, pipeline, prospector, serp, calls, notes, approvals, events, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('run keeps searching (next page, next segment) until the daily target, with gap and FDE prospects', async () => {
  const w = world();
  try {
    w.prospector.setConfig({ daily_new: 4 });
    const r = await w.prospector.runOnce({ reason: 'test' });
    assert.equal(r.qualified.length, 4, JSON.stringify(r, null, 1));
    assert.equal(r.short, null);
    const maps = w.serp.filter((q) => q.engine === 'google_maps').map((q) => `${q.q}@${q.start}`);
    assert.deepEqual(maps, ['freight forwarders in Pune@0', 'customs brokers in Pune@0', 'freight forwarders in Pune@20'], 'segments rotate, then the next page');
    assert.deepEqual(r.qualified.map((q) => q.pitch).sort(), ['fde', 'fde', 'gap', 'gap']);
    assert.equal(r.drafts, 4); assert.equal(w.approvals.length, 1); assert.equal(w.approvals[0].payload.emails.length, 4);
    const fde = w.pipeline.find({ limit: 20 }).leads.map((l) => w.pipeline.get(l.id)).find((l) => l.pitch === 'fde');
    assert.equal(fde.fit, 'FDE'); assert.match(fde.signal, /^Seen on their site: "We handle customs clearance/);
    const fdePrompt = w.calls.find((c) => /INTRODUCTION/.test(c.user ?? ''));
    assert.ok(fdePrompt, 'FDE leads get the introduction brief'); assert.match(fdePrompt.user, /never say or imply they have a manual step/);
    assert.ok(w.calls.every((c) => !c.sys.startsWith('You write') || /Never write a number/.test(c.sys)), 'every draft is told not to invent numbers');
    assert.equal(w.store.db.prepare("SELECT status FROM prospect_runs").get().status, 'done');
    assert.match(w.notes.at(-1).title, /Outreach ready: 4 new/); assert.doesNotMatch(w.notes.at(-1).body, /Ran short/);
  } finally { w.close(); }
});

test('run says honestly when it ran short (today\'s search allowance), and FDE can be switched off', async () => {
  const w = world();
  try {
    w.prospector.setConfig({ daily_new: 5, day_searches: 1, fde_pitch: false });
    const r = await w.prospector.runOnce();
    assert.equal(r.short, 'search_allowance'); assert.equal(r.searches, 1);
    assert.deepEqual(r.qualified.map((q) => q.pitch), ['gap'], 'FDE off: only the evidenced gap qualifies');
    assert.match(w.notes.at(-1).body, /Ran short: today's share of the search budget is used/);
    assert.match(w.notes.at(-1).title, /1\/5 qualified/);
    assert.match(w.prospector.status().last_run, /qualified 1\/5.*Short: today's share/);
    assert.equal(w.prospector.searchAllowance(), 0);
    assert.deepEqual(await w.prospector.runOnce().then((x) => [x.short, x.searches]), ['search_allowance', 0], 'a re-run the same day spends nothing more');
  } finally { w.close(); }
});

test('search allowance spreads the month\'s remaining budget over the remaining run days', () => {
  const now = Date.parse('2026-10-28T06:00:00Z'); // Wednesday; run days left in October (Mon-Fri): 28, 29, 30
  const w = world({ now: () => now });
  try {
    w.prospector.setConfig({ serp_budget: 20, day_searches: 12 });
    w.settings.set('serp_usage', { month: '2026-10', n: 14 });
    assert.equal(w.prospector.searchAllowance(), 2, '6 left / 3 days');
    w.prospector.setConfig({ serp_budget: 150 });
    assert.equal(w.prospector.searchAllowance(), 12, 'capped by day_searches');
    w.settings.set('serp_day', { day: '2026-10-28', n: 12 });
    assert.equal(w.prospector.searchAllowance(), 0, 'today already used its share');
    // configs saved before v2 carried max_audits 12 as a default; it is dropped so the new default applies
    w.settings.set('prospecting', { ...w.settings.get('prospecting'), v: undefined, max_audits: 12 });
    assert.equal(w.prospector.config().max_audits, 30);
  } finally { w.close(); }
});

test('writer fallback chain: thinking room on the reasoning chain, then the fast chain without thinking', async () => {
  const seen = [];
  const w = world({ writer: (role, opts) => {
    seen.push({ role, maxTokens: opts.maxTokens, thinking: opts.thinking, timeoutMs: opts.timeoutMs });
    if (role === 'reason') throw new Error('all_models_failed(reason): nvidia:ultra=nvidia: timeout; nvidia:super=empty reply (finish=length)');
    const company = /Company: (.+?) \(/.exec(opts.messages[1].content)[1];
    return { content: JSON.stringify({ subject: 'quotes at your desk', body: `Hi ${company} team,\n\nSaw how your desk works on your site.\n\nWant me to send the one-page architecture plan for ${company}?` }) };
  } });
  try {
    assert.deepEqual(WRITERS.map((x) => x.role), ['reason', 'chat']);
    assert.ok(WRITERS[0].maxTokens >= 6000, 'room for the thinking pass and the JSON');
    w.prospector.setConfig({ daily_new: 1 });
    const r = await w.prospector.runOnce();
    assert.equal(r.drafts, 1, JSON.stringify(r.not_drafted));
    assert.deepEqual(seen.map((x) => x.role), ['reason', 'chat']);
    assert.equal(seen[1].thinking, false); assert.equal(seen[0].maxTokens, 8000); assert.ok(seen[0].timeoutMs <= 120_000);
  } finally { w.close(); }
});

test('writer down: qualified leads are kept, later ones skip drafting, the next run retries them', async () => {
  let down = true; let writes = 0;
  const w = world({ writer: (role, opts) => {
    writes++;
    if (down) { const e = new Error('all_models_failed'); throw e; }
    const company = /Company: (.+?) \(/.exec(opts.messages[1].content)[1];
    return { content: JSON.stringify({ subject: 'quotes at your desk', body: `Hi ${company} team,\n\nSaw how your desk works.\n\nWant me to send the one-page architecture plan for ${company}?` }) };
  } });
  try {
    w.prospector.setConfig({ daily_new: 2 });
    const r1 = await w.prospector.runOnce();
    assert.equal(r1.qualified.length, 2); assert.equal(r1.drafts, 0); assert.equal(r1.writer_down, true);
    assert.equal(writes, 2, 'one draft attempt walks the chain once (2 writers); the next lead is not tried while the writer is down');
    assert.match(r1.not_drafted[0].why, /writer model unavailable/); assert.equal(r1.not_drafted[0].retry, true);
    assert.equal(w.store.db.prepare("SELECT COUNT(*) n FROM prospects WHERE status='draft_failed'").get().n, 2);
    assert.equal(w.approvals.length, 0);
    down = false;
    w.prospector.setConfig({ daily_new: 1 });
    const r2 = await w.prospector.runOnce();
    assert.equal(r2.retried, 2, 'earlier leads drafted first, at no search cost');
    assert.equal(w.approvals.at(-1).payload.emails.length, 3);
  } finally { w.close(); }
});

test('rewrites are bounded: the same objection twice stops drafting (invented numbers caught in code)', async () => {
  let writes = 0;
  const w = world({ writer: (role, opts) => {
    writes++;
    const company = /Company: (.+?) \(/.exec(opts.messages[1].content)[1];
    return { content: JSON.stringify({ subject: 'quotes at your desk', body: `Hi ${company} team,\n\nYour desk spends ${writes + 2} hours a day on quotes.\n\nWant me to send the one-page architecture plan for ${company}?` }) };
  } });
  try {
    w.prospector.setConfig({ daily_new: 1 });
    const r = await w.prospector.runOnce();
    assert.equal(r.drafts, 0); assert.equal(writes, 2, 'draft + one rewrite, then stop (not 4+ rounds)');
    assert.match(r.not_drafted[0].why, /same review problem after a rewrite: numbers that are not in the evidence/);
    const lead = w.pipeline.find({ limit: 5 }).leads[0];
    assert.match(w.pipeline.lint({ lead_id: lead.id, body: 'Hi team,\n\nNoticed the desk. Cut 3 days to 4 hours, 80% faster.\n\nWant the plan?', subject: 'x' }).join(' '), /"3", "4", "80%"/);
    assert.equal(w.pipeline.lint({ lead_id: lead.id, body: 'Hi team,\n\nYour agent can run 24/7.\n\nWant the plan?', subject: 'x' }).filter((x) => /numbers/.test(x)).length, 0);
  } finally { w.close(); }
});

test('one run at a time: run_now during a run reports progress; a restart marks the cut-off run interrupted', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const w = world();
  try {
    w.prospector.setConfig({ daily_new: 1 });
    const orig = w.prospector.fetchPage;
    w.prospector.fetchPage = async (u) => { await gate; return orig(u); };
    const first = w.prospector.runOnce({ reason: 'manual' });
    assert.equal(w.prospector.running, true, 'locked before the first await');
    while (w.prospector.progress()?.phase !== 'auditing') await new Promise((r) => setImmediate(r));
    const second = await w.prospector.runOnce({ reason: 'manual' });
    assert.equal(second.error, 'already_running'); assert.equal(second.progress.qualified, '0/1');
    const tools = Object.fromEntries(prospectingTools(w.prospector).map((t) => [t.name, t]));
    const again = await tools.prospecting_run_now.run({});
    assert.equal(again.already_running, true); assert.match(again.note, /Not started again/);
    const st = await tools.prospecting_status.run({});
    assert.ok(st.running); assert.match(st.note, /No need to check again/);
    assert.ok(JSON.stringify(st).length < 900, `compact status (${JSON.stringify(st).length} chars)`);
    assert.equal(w.prospector.runs().running.phase, 'auditing');
    release(); await first;
    assert.equal(w.prospector.running, false);
    const done = await tools.prospecting_run_now.run({});
    assert.equal(done.not_started, true, 'target already reached today: no silent re-run');
    w.prospector.setConfig({ run_at: '00:00', days: [1, 2, 3, 4, 5, 6, 7] });
    assert.equal(await w.prospector.tick(), null, 'the scheduled run is skipped too');
    assert.ok(w.events.some((e) => e.type === 'prospecting.progress'));
    const runs = w.prospector.runs();
    assert.equal(runs.runs[0].status, 'done'); assert.match(runs.runs[0].summary, /qualified 1\/1/); assert.match(runs.runs[0].report, /Qualified 1 of 1/);
    // a run left unfinished by a restart
    w.store.db.prepare("INSERT INTO prospect_runs (id, started_at, status, report) VALUES ('stale-run', ?, 'running', ?)").run(new Date().toISOString(), JSON.stringify({ progress: { phase: 'auditing', qualified: '2/5' } }));
    const p2 = new Prospector({ store: w.store, settings: w.settings, pipeline: w.pipeline, ai: {} });
    const stale = p2.runs().runs.find((x) => x.id === 'stale-run');
    assert.equal(stale.status, 'interrupted'); assert.match(stale.summary, /interrupted by a restart \(had qualified 2\/5\)/);
    const detail = w.prospector.status({ detail: true });
    assert.ok(detail.config && detail.last_7_days !== undefined && detail.last_report.qualified.length === 1);
  } finally { w.close(); }
});

test('sales judge: FDE introductions skip the gap questions but may not claim an unseen problem', async () => {
  assert.ok(!('gap_specific' in FDE_OUTREACH_QUESTIONS) && !('offer_fits_gap' in FDE_OUTREACH_QUESTIONS) && 'claims_unseen_problem' in FDE_OUTREACH_QUESTIONS);
  assert.ok(!('claims_unseen_problem' in OUTREACH_QUESTIONS), 'gap pitches are about a seen problem');
  const clean = { sells_software: { noul: 0.05 }, opener_specific: { noul: 0.9 }, asks_one_easy_thing: { noul: 0.9 } };
  assert.equal(judgeOutreach({ ...clean, gap_specific: { score: 0 } }, { pitch: 'fde' }).ok, true, 'no gap is fine for FDE');
  assert.equal(judgeOutreach({ ...clean, gap_specific: { score: 0 } }).problems[0].block, true, 'but blocks a gap pitch');
  const claim = judgeOutreach({ ...clean, claims_unseen_problem: { noul: 0.9 }, unsupported_claims: { noul: 0.9 } }, { pitch: 'fde' });
  assert.equal(claim.ok, false); assert.match(claim.problems.map((p) => p.why).join(' '), /nobody saw/); assert.ok(!claim.problems.some((p) => p.block));
  assert.equal(judgeQualifyFde({ sells_software: { noul: 0.1 }, operations_heavy: { noul: 0.9 } }).verdict, 'qualify');
  assert.equal(judgeQualifyFde({ sells_software: { noul: 0.9 }, operations_heavy: { noul: 0.9 } }).verdict, 'skip');
  assert.equal(judgeQualifyFde({ sells_software: { noul: 0.1 }, operations_heavy: { noul: 0.5 } }).verdict, 'hold');
  const asked = [];
  const judge = new SalesJudge({ jev: { configured: true, decide: async ({ state, questions }) => { asked.push({ state, keys: Object.keys(questions) }); return { answers: clean }; } } });
  await judge.reviewOutreach([{ to: 'a@b.example', lead: { company: 'B', pitch: 'fde', signal: 'Seen on their site: "x" (https://b.example)' }, offer: 'o', proof: 'p', subject: 's', body: 'b' }]);
  assert.ok(asked[0].keys.includes('claims_unseen_problem') && !asked[0].keys.includes('gap_specific'));
  assert.match(asked[0].state.lead.gap, /None observed/);
});

test('FDE qualification goes through the judge; a competitor is still skipped', async () => {
  const judge = { ready: true, qualify: async () => ({ verdict: 'qualify' }), qualifyFde: async ({ lead }) => (/customs/i.test(lead.what_they_do) ? { verdict: 'skip', why: 'sells software/AI/automation itself' } : { verdict: 'qualify' }) };
  const w = world({ judge, maps: { 'customs brokers in Pune': ['FDE', 'GAP'] } });
  try {
    w.prospector.setConfig({ daily_new: 2 });
    const r = await w.prospector.runOnce();
    assert.deepEqual(r.qualified.map((q) => q.pitch), ['gap']);
    assert.match(r.skipped[0].why, /sells software/);
  } finally { w.close(); }
});

test('provider: a per-call timeout ends a stuck request early so the next writer can answer', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const p = new OpenAICompatProvider({ name: 'nvidia', baseUrl: 'https://x.example/v1', apiKey: 'test-key-123456', fetchImpl, timeoutMs: 120_000 });
  const t0 = Date.now(); const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers do not hold the loop open
  try {
    await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 50 }), (e) => e.kind === 'timeout');
    assert.ok(Date.now() - t0 < 2000);
  } finally { clearInterval(keepAlive); }
});
