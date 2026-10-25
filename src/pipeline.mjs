// Business development: Friday's own small CRM for finding and working clients.
//  - leads + their history (lead_events), a do-not-contact list (suppressions) and the business profile
//    (what we sell, to whom, proof, voice) that every sales skill reads first.
//  - Outreach goes out only through the gated outreach_send tool (one approval per batch); suppressed
//    addresses/domains are refused in code, a daily cap protects the Gmail account, and every cold email
//    carries an opt-out line.
//  - tick(): replies from contacted leads stop their follow-ups (unsubscribe -> do-not-contact, out-of-office
//    -> pause, bounce -> lost), and once a day due follow-ups become one nudge. Friday drafts; the user approves.
//  - With JEV configured (sales-judge.mjs), batches are quality-reviewed before approval and replies are classified
//    (interest, question, objection, not now, referral, stop, out of office); fixed rules still run first.
import { randomUUID } from 'node:crypto';
import { renderEmail, DEFAULT_BRAND } from './email-template.mjs';
import { partsInTz, zonedToUtc, isValidTimezone, formatLocal } from './time.mjs';

export const STAGES = ['new', 'researched', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost', 'nurture', 'dnc'];
const OPEN = new Set(['new', 'researched', 'contacted', 'nurture']);
// Set only by what really happened (a send, a reply), never by lead_save: a lead marked contacted without an email
// would get follow-ups to someone who never heard from us.
const EVENT_STAGES = new Set(['contacted', 'replied']);
// "Operations Head" is a role, not a person; greeting a placeholder reads as a mail merge.
const ROLE_ONLY_RE = /^(the\s+)?((head|director|manager|owner|founder|partner|ceo|coo|cto|team|admin|admissions|operations|ops|hr|sales|marketing|accounts|managing|general)\b[\s&,/-]*(of\s+)?)+$/i;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const FOLLOW_UP_DAYS = [3, 4, 7]; // after touch 1, 2, 3; touch 4 is the breakup, then the sequence ends
const MAX_TOUCHES = 4;
const MAX_BATCH = 15;
const DEFAULT_CAP = 25;
export const DEFAULT_OPT_OUT = 'P.S. Not relevant for you? Just reply "no" and I won\'t follow up.';
const OPT_OUT_RE = /unsubscribe|opt[ -]?out|reply\s+["“']?(no|stop|remove)|won['’]t (follow up|email|reach out)|not relevant\?/i;
const UNSUB_RE = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (contact|email)|don['’]t (contact|email) me|opt me out)\b|^\s*(no|stop)[.!]?\s*$/i;
const OOO_RE = /\b(out of (the )?office|on (annual |parental |sick )?leave|on vacation|automatic reply|auto-?reply|away until|currently away)\b/i;
const DAY = 86_400_000;
// House style, enforced in code (the model skips written rules when in a hurry). Extra phrases: setting outreach_banned.
const BANNED = ['whatsapp', 'spreadsheet', 'n8n', 'zapier', 'chatbot', 'no vendor lock-in', 'recent work:', 'take off your plate', "take off people's plates",
  "i'm reaching out", 'i am reaching out', 'reaching out because', 'quick intro', 'typical things', 'no pitch',
  'hope this finds you', 'hope this email finds you', 'just checking in', 'circling back', 'leverage', 'synergy', 'game-changer',
  'game changer', 'revolutionize', 'revolutionise', 'drowning', 'i help companies', 'i help businesses', 'cutting-edge', 'seamless'];
const CALL_ASK_RE = /\b(\d{2})\s*-?\s*min(ute)?s?\b|\bquick call\b|\bhop on a call\b|\bjump on a call\b/i;
// "I recently helped a CA firm cut X by 80%" - a past-result claim with a number; only real, listed proof may be used.
const RESULT_CLAIM_RE = /\b(i|we)\s+(recently\s+|just\s+)?(helped|enabled|saved|got|took|grew|cut|reduced|increased|doubled|tripled)\b[^.!?\n]*\d/i;
// "- Built an AI scheduling agent for a recruiting firm ..." - client work stated as done; only listed proof may be used.
const CLIENT_CLAIM_RE = /\b(built|deployed|automated|delivered|shipped|implemented)\b[^.!?\n]*\bfor\s+(a|an)\s+[^.!?\n]*(firm|company|client|startup|agency|forwarder|brand|business|group|institute)\b/i;
const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
// The reply's own words: Gmail snippets carry the quoted earlier mail after "On <date> <x> wrote:".
const ownWords = (snippet) => String(snippet ?? '').split(/\s+On\s.{4,120}?wrote:|-{3,}\s*Original Message|\n>/i)[0].trim();

const clean = (v, max = 500) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);
const lower = (v) => String(v ?? '').trim().toLowerCase();
const domainOf = (v) => { const s = lower(v); if (s.includes('@')) return s.split('@')[1]; try { return new URL(/^https?:/.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, ''); } catch { return null; } };
const addrs = (v) => String(v ?? '').split(/[,;]/).map((x) => lower(/<([^>]+)>/.exec(x)?.[1] ?? x)).filter(Boolean);

export class Pipeline {
  #timer = null;
  constructor({ store, settings, gmail = null, notifications = null, bus = null, judge = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { store, settings, gmail, notifications, bus, judge, now, sleep });
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY, company TEXT NOT NULL, domain TEXT, website TEXT, contact_name TEXT, role TEXT, email TEXT,
        offer TEXT, source TEXT, signal TEXT, fit TEXT, stage TEXT NOT NULL DEFAULT 'new', research TEXT, next_action TEXT,
        next_at TEXT, touches INTEGER NOT NULL DEFAULT 0, last_touch_at TEXT, last_message_id TEXT, thread_id TEXT,
        last_reply_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS leads_email ON leads(email) WHERE email IS NOT NULL;
      CREATE INDEX IF NOT EXISTS leads_stage ON leads(stage, next_at);
      CREATE TABLE IF NOT EXISTS lead_events (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lead_events_lead ON lead_events(lead_id, at);
      CREATE TABLE IF NOT EXISTS suppressions (value TEXT PRIMARY KEY, reason TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, follow_up INTEGER NOT NULL DEFAULT 0,
        opt_out INTEGER NOT NULL DEFAULT 1, scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT, error TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, scheduled_at);`);
    // The prospect's own time zone decides when their email goes out (added after the first release).
    if (!this.db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'timezone')) this.db.exec('ALTER TABLE leads ADD COLUMN timezone TEXT');
  }

  #iso(t = this.now()) { return new Date(t).toISOString(); }
  #event(leadId, kind, summary) { this.db.prepare('INSERT INTO lead_events (id,lead_id,kind,summary,at) VALUES (?,?,?,?,?)').run(randomUUID(), leadId, kind, clean(summary, 1000), this.#iso()); }

  // ---- business profile (markdown: offers, ICP, proof, pricing, voice, signature) ----
  profile() { const p = this.settings.get('business_profile', null); return p ? { profile: p.text, updated_at: p.updated_at } : { profile: null, note: 'No business profile yet. Interview the user (product-marketing skill) and save it with op set.' }; }
  setProfile(text) {
    if (typeof text !== 'string' || text.trim().length < 20) throw new TypeError('profile text required (markdown, >= 20 chars)');
    if (text.length > 30_000) throw new TypeError('profile too long (max 30000 chars)');
    this.settings.set('business_profile', { text: text.trim(), updated_at: this.#iso() });
    return { saved: true, chars: text.trim().length };
  }

  // ---- do-not-contact ----
  suppress(value, reason = 'user request') {
    const v = lower(value).replace(/^mailto:/, '');
    const key = EMAIL_RE.test(v) ? v : domainOf(v);
    if (!key || !/\./.test(key)) throw new TypeError('value must be an email address or a domain');
    this.db.prepare('INSERT OR REPLACE INTO suppressions (value,reason,at) VALUES (?,?,?)').run(key, clean(reason, 200), this.#iso());
    const hit = key.includes('@') ? this.db.prepare('SELECT id FROM leads WHERE email=?').all(key) : this.db.prepare('SELECT id FROM leads WHERE domain=? OR email LIKE ?').all(key, `%@${key}`);
    for (const l of hit) { this.db.prepare("UPDATE leads SET stage='dnc', next_at=NULL, next_action=NULL, updated_at=? WHERE id=?").run(this.#iso(), l.id); this.#event(l.id, 'dnc', `do not contact: ${reason}`); this.cancelQueued(l.id, 'do not contact'); }
    return { suppressed: key, leads_updated: hit.length };
  }
  isSuppressed(email) {
    const e = lower(email); const d = domainOf(e);
    return Boolean(this.db.prepare('SELECT 1 FROM suppressions WHERE value=? OR value=?').get(e, d));
  }
  // For any outgoing mail (email_send included): which recipients are on the do-not-contact list.
  blockedRecipients(...fields) { return fields.flatMap(addrs).filter((a) => this.isSuppressed(a)); }

  // ---- leads ----
  #row(r) { return r ? { ...r } : null; }
  get(id) { return this.#row(this.db.prepare('SELECT * FROM leads WHERE id=? OR id LIKE ?').get(String(id), `${String(id)}%`)); }
  byEmail(email) { return this.#row(this.db.prepare('SELECT * FROM leads WHERE email=?').get(lower(email))); }

  save(input) {
    const company = clean(input?.company, 200);
    if (!company) throw new TypeError('company required');
    const email = input.email ? lower(input.email) : null;
    if (email && !EMAIL_RE.test(email)) throw new TypeError(`invalid email: ${input.email}`);
    const domain = domainOf(input.website ?? email ?? '') ?? null;
    if (input.stage && !STAGES.includes(input.stage)) throw new TypeError(`stage must be one of ${STAGES.join(', ')}`);
    if (EVENT_STAGES.has(input.stage)) throw new TypeError(`stage ${input.stage} is set automatically when an email is really sent or a reply arrives; save the lead as new or researched`);
    let contactName = clean(input.contact_name, 120); let role = clean(input.role, 160);
    if (contactName && ROLE_ONLY_RE.test(contactName)) { role = role ?? contactName; contactName = null; }
    const fields = { company, domain, website: clean(input.website, 300), contact_name: contactName, role, email,
      offer: clean(input.offer, 160), source: clean(input.source, 300), signal: clean(input.signal, 600), fit: clean(input.fit, 20), research: clean(input.research, 4000), next_action: clean(input.next_action, 300),
      timezone: input.timezone && isValidTimezone(String(input.timezone)) ? String(input.timezone) : null };
    const existing = (email && this.byEmail(email)) ?? (input.id ? this.get(input.id) : null)
      ?? (!email && domain && fields.contact_name ? this.#row(this.db.prepare('SELECT * FROM leads WHERE domain=? AND contact_name=?').get(domain, fields.contact_name)) : null)
      ?? (!email && domain && !fields.contact_name ? this.#row(this.db.prepare('SELECT * FROM leads WHERE domain=? AND email IS NULL AND contact_name IS NULL').get(domain)) : null);
    const suppressed = (email && this.isSuppressed(email)) || (domain && this.isSuppressed(`x@${domain}`));
    const now = this.#iso();
    if (existing) {
      const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
      if (input.stage) set.stage = input.stage;
      if (suppressed) set.stage = 'dnc';
      const cols = Object.keys(set);
      this.db.prepare(`UPDATE leads SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...cols.map((c) => set[c]), now, existing.id);
      return { ...this.get(existing.id), updated: true, ...(suppressed ? { warning: 'on the do-not-contact list' } : {}) };
    }
    const id = randomUUID();
    const stage = suppressed ? 'dnc' : (input.stage ?? (fields.research ? 'researched' : 'new'));
    this.db.prepare(`INSERT INTO leads (id,company,domain,website,contact_name,role,email,offer,source,signal,fit,stage,research,next_action,timezone,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, company, domain, fields.website, fields.contact_name, fields.role, email, fields.offer, fields.source, fields.signal, fields.fit, stage, fields.research, fields.next_action, fields.timezone, now, now);
    this.#event(id, 'created', `${company}${fields.source ? ` (source: ${fields.source})` : ''}`);
    this.bus?.publish('lead.created', { id });
    return { ...this.get(id), created: true, ...(suppressed ? { warning: 'on the do-not-contact list' } : {}) };
  }

  update(id, { stage, note, fit, next_action, next_at, offer, research } = {}) {
    const l = this.get(id); if (!l) throw new TypeError('lead not found');
    if (stage && !STAGES.includes(stage)) throw new TypeError(`stage must be one of ${STAGES.join(', ')}`);
    if (l.stage === 'dnc' && stage && stage !== 'dnc') throw new TypeError('lead is on the do-not-contact list');
    if (stage === 'contacted' && !l.touches) throw new TypeError('stage contacted is set automatically when an email is really sent');
    const set = {};
    if (stage) set.stage = stage;
    if (fit) set.fit = clean(fit, 20);
    if (offer) set.offer = clean(offer, 160);
    if (research) set.research = clean(research, 4000);
    if (next_action !== undefined) set.next_action = clean(next_action, 300);
    if (next_at !== undefined) { if (next_at === null || next_at === '') set.next_at = null; else { const t = Date.parse(next_at); if (Number.isNaN(t)) throw new TypeError('next_at must be an ISO date'); set.next_at = new Date(t).toISOString(); } }
    if (stage && !OPEN.has(stage)) set.next_at = set.next_at ?? null; // replied/meeting/won/lost: the automatic sequence stops
    const cols = Object.keys(set);
    if (cols.length) this.db.prepare(`UPDATE leads SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...cols.map((c) => set[c]), this.#iso(), l.id);
    if (stage && stage !== l.stage) this.#event(l.id, 'stage', `${l.stage} -> ${stage}${note ? `: ${note}` : ''}`);
    else if (note) this.#event(l.id, 'note', note);
    return this.get(l.id);
  }

  find({ stage = null, due = false, q = null, limit = 25 } = {}) {
    const where = []; const args = [];
    if (stage) { where.push('stage=?'); args.push(stage); }
    if (due) { where.push("next_at IS NOT NULL AND next_at <= ? AND stage IN ('new','researched','contacted','nurture')"); args.push(this.#iso()); }
    if (q) { where.push('(company LIKE ? OR contact_name LIKE ? OR email LIKE ? OR domain LIKE ? OR offer LIKE ?)'); const p = `%${String(q).slice(0, 80)}%`; args.push(p, p, p, p, p); }
    const rows = this.db.prepare(`SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(next_at, updated_at) ASC LIMIT ?`).all(...args, Math.min(Math.max(1, Number(limit) || 25), 100));
    return { count: rows.length, leads: rows.map((r) => ({ id: r.id.slice(0, 8), company: r.company, contact: r.contact_name, role: r.role, email: r.email, offer: r.offer, stage: r.stage, fit: r.fit, touches: r.touches, last_touch_at: r.last_touch_at, next_at: r.next_at, next_action: r.next_action, signal: r.signal })) };
  }
  history(id) { const l = this.get(id); if (!l) return null; return { lead: l, events: this.db.prepare('SELECT kind, summary, at FROM lead_events WHERE lead_id=? ORDER BY at DESC LIMIT 40').all(l.id) }; }
  stats() {
    const by = Object.fromEntries(this.db.prepare('SELECT stage, COUNT(*) n FROM leads GROUP BY stage').all().map((r) => [r.stage, r.n]));
    return { paused: this.paused(), by_stage: by, due_follow_ups: this.find({ due: true, limit: 100 }).count, sent_today: this.sentToday(), daily_cap: this.cap(), queued: this.outbox({ limit: 15 }), suppressed: this.db.prepare('SELECT COUNT(*) n FROM suppressions').get().n };
  }

  // ---- outreach ----
  cap() { return Math.max(1, Math.min(200, Number(this.settings.get('outreach_daily_cap', DEFAULT_CAP)) || DEFAULT_CAP)); }
  sentToday() { return this.db.prepare("SELECT COUNT(*) n FROM lead_events WHERE kind='sent' AND at >= ?").get(this.#iso(this.now() - DAY)).n; }
  optOutLine() { return String(this.settings.get('outreach_opt_out_line', DEFAULT_OPT_OUT) ?? DEFAULT_OPT_OUT); }

  // Validate a batch before it is staged for approval and again before it runs. Returns the exact mails that will go out.
  prepare(emails) {
    if (!Array.isArray(emails) || !emails.length) throw new TypeError('emails must be a non-empty list');
    if (emails.length > MAX_BATCH) throw new TypeError(`at most ${MAX_BATCH} emails per batch`);
    const out = []; const seen = new Set();
    for (const [i, e] of emails.entries()) {
      const lead = e.lead_id ? this.get(e.lead_id) : null;
      if (e.lead_id && !lead) throw new TypeError(`email ${i + 1}: lead ${e.lead_id} not found`);
      const to = lower(e.to ?? lead?.email);
      if (!EMAIL_RE.test(to)) throw new TypeError(`email ${i + 1}: needs a valid recipient (to, or a lead with an email)`);
      if (seen.has(to)) throw new TypeError(`email ${i + 1}: ${to} appears twice in this batch`);
      seen.add(to);
      const body = this.stripSignoff(String(e.body ?? '').trim());
      if (body.length < 20 || body.length > 5000) throw new TypeError(`email ${i + 1}: body must be 20-5000 chars`);
      const followUp = Boolean(e.follow_up && lead?.last_message_id);
      const subject = clean(e.subject, 200);
      if (!followUp && !subject) throw new TypeError(`email ${i + 1}: subject required (or follow_up on a lead already contacted)`);
      const lead2 = lead ?? this.byEmail(to);
      if (!lead2) throw new TypeError(`email ${i + 1}: ${to} is not in the pipeline; save it with lead_save first`);
      out.push({ to, lead_id: lead2.id, company: lead2.company, subject: followUp ? null : subject, follow_up: followUp,
        body, opt_out: !OPT_OUT_RE.test(body),
        blocked: this.isSuppressed(to) ? 'do-not-contact' : ['dnc', 'won', 'lost', 'replied', 'meeting', 'proposal'].includes(lead2.stage) ? `lead stage is ${lead2.stage}` : null });
    }
    return out;
  }

  // Quality gate before a batch is staged for approval: deterministic checks, then JEV's review of each email against
  // its lead (competitor? evidenced gap? offer fits? specific opener? no service lists, prices or mixed offers?).
  // Deterministic house-style checks for one prepared email (no model involved).
  lint(m) {
    const lead = this.get(m.lead_id); const out = [];
    const text = m.body;
    const low = text.toLowerCase();
    if (CLIENT_CLAIM_RE.test(text)) out.push(`it claims client work ("${CLIENT_CLAIM_RE.exec(text)[0].slice(0, 80)}"): only projects listed in the profile's Proof section may be mentioned`);
    if (RESULT_CLAIM_RE.test(text)) out.push(`it claims a past result ("${RESULT_CLAIM_RE.exec(text)[0].slice(0, 80)}"): only results listed in the profile's Proof section may be used, never invented ones`);
    if (/→|->|=>/.test(text)) out.push('no arrow chains (a → b → c): describe the end result in one plain sentence');
    if (/[—–]/.test(text) || /[—–]/.test(m.subject ?? '')) out.push('no em/en dashes: use a full stop or comma');
    const extra = Array.isArray(this.settings.get('outreach_banned', null)) ? this.settings.get('outreach_banned') : [];
    const hits = [...BANNED, ...extra.map((x) => String(x).toLowerCase())].filter((p) => p && low.includes(p));
    if (hits.length) out.push(`remove banned phrases: ${hits.map((h) => `"${h}"`).join(', ')}`);
    const greet = /^\s*(hi|hello|dear|hey)\s+([^,\n]+)[,\n]/i.exec(text);
    if (greet && ROLE_ONLY_RE.test(greet[2].trim())) out.push(`greeting "${greet[2].trim()}" is a role, not a name: use the person's first name, or "Hi ${lead?.company ?? 'there'} team"`);
    if (!m.follow_up) {
      if (m.subject && words(m.subject) > 6) out.push('subject too long: 2-5 words, lowercase, about their business');
      if (CALL_ASK_RE.test(text)) out.push('a first email asks for one easy yes (e.g. "Want me to send the one-page plan?"), not a call');
      if (words(text.replace(/[#*-]/g, ' ')) > 200) out.push(`too long (${words(text)} words): keep the body to 120-180 words`);
      const bullets = text.split('\n').filter((l) => /^\s*[-•*]\s+/.test(l)).length;
      if (bullets > 4) out.push(`${bullets} bullets: keep to at most 3-4, about their business`);
      if (text.split('\n').filter((l) => /^\s*#{2,3}\s/.test(l)).length > 2) out.push('at most two section headings');
      if (lead && !/https?:\/\//.test(`${lead.signal ?? ''} ${lead.research ?? ''} ${lead.source ?? ''}`)) out.push('no evidence link saved for this lead: study the company, then lead_save the gap with the URL where you saw it (signal)');
    }
    return out;
  }

  // Quality gate before a batch is staged for approval: the house-style lint (always), then JEV's review of each email
  // against its lead when available (competitor? evidenced gap? offer fits? specific opener? invented claims?).
  async review(emails, { skipJudge = false } = {}) {
    const list = this.prepare(emails); // throws TypeError on invalid batches
    if (skipJudge) return { ok: true, reviewed: false, note: 'quality review skipped at your request' };
    const live = list.filter((m) => !m.blocked);
    const issues = new Map(live.map((m) => [m.to, { to: m.to, company: m.company, drop_lead: false, fix: this.lint(m) }]));
    let note = null; let judged = false;
    if (this.judge?.ready && this.settings.get('outreach_review', true) !== false) {
      const offerOf = (l) => l?.offer ?? 'AI agents and automation that run a whole workflow end to end';
      try {
        const proof = this.proof();
        const verdicts = await this.judge.reviewOutreach(live.map((m) => { const lead = this.get(m.lead_id); return { to: m.to, lead, offer: offerOf(lead), proof, subject: m.subject ?? '(follow-up)', body: this.render(m).text }; }));
        for (const v of verdicts) { const it = issues.get(v.to); it.fix.push(...v.problems.map((p) => p.why)); if (v.problems.some((p) => p.block)) it.drop_lead = true; }
        judged = true;
      } catch (e) { note = `quality review unavailable (${String(e.message ?? e).slice(0, 60)})`; }
    }
    const bad = [...issues.values()].filter((v) => v.fix.length);
    if (!bad.length) return { ok: true, reviewed: judged, ...(note ? { note } : {}) };
    return { ok: false, emails: bad };
  }

  // The designed email (header + body + signature + opt-out) and its plain-text twin. Follow-ups/replies: no header.
  render(m) {
    const brand = { ...DEFAULT_BRAND, ...(this.settings.get('outreach_brand', null) ?? {}) };
    return renderEmail({ body: m.body, signature: String(this.settings.get('outreach_signature', '') ?? '').trim(), optOut: m.opt_out === false ? '' : this.optOutLine(), brand, header: !m.follow_up });
  }
  // Friday sometimes signs off itself ("Best,\nAtharv ..."); the template adds the real signature, so drop hers.
  stripSignoff(body) {
    const brand = { ...DEFAULT_BRAND, ...(this.settings.get('outreach_brand', null) ?? {}) };
    const first = brand.name.toLowerCase().split(' ')[0];
    const lines = body.split('\n');
    // Cut only a trailing block that STARTS with a sign-off word or the sender's name, and whose lines are all short.
    for (let k = Math.max(0, lines.length - 7); k < lines.length; k++) {
      const t = lines[k].trim().replace(/^[—–-]+\s*/, '');
      const starts = /^(best|regards|best regards|kind regards|warm regards|thanks|thank you|cheers|sincerely)[,!.]?$/i.test(t) || t.toLowerCase().startsWith(first);
      if (starts && lines.slice(k).every((l) => l.trim().length <= 70)) return lines.slice(0, k).join('\n').trim();
    }
    return body;
  }

  proof() { return /## Proof[^\n]*\n([\s\S]*?)(\n## |$)/.exec(String(this.settings.get('business_profile', null)?.text ?? ''))?.[1]?.trim() ?? 'No proof listed.'; }

  // Any email from the outreach inbox that is not an outreach_send batch (a test to the user, a reply, a forward):
  // the same house-style lint and JEV proof/positioning review, so nothing leaves that inbox unchecked.
  async reviewMessage({ to, subject = null, body, reply = false }) {
    const lead = addrs(to).map((a) => this.byEmail(a)).find(Boolean) ?? null;
    const m = { to: lower(to), lead_id: lead?.id ?? null, subject, follow_up: reply, body: this.stripSignoff(String(body ?? '').trim()) };
    const fix = this.lint(m);
    if (this.judge?.ready && this.settings.get('outreach_review', true) !== false) {
      try { const v = await this.judge.reviewMessage({ subject: subject ?? '', body: m.body, proof: this.proof(), firstTouch: !reply }); fix.push(...v.problems.map((p) => p.why)); } catch { /* JEV down: lint only */ }
    }
    return fix.length ? { ok: false, fix } : { ok: true };
  }

  summarize(emails) {
    let list; try { list = this.prepare(emails); } catch (e) { return `Outreach batch (invalid: ${e.message})`; }
    const ok = list.filter((m) => !m.blocked).length;
    const left = Math.max(0, this.cap() - this.sentToday());
    return `Send ${ok} outreach email${ok === 1 ? '' : 's'} from Gmail (${left} left in today's cap of ${this.cap()})${list.length - ok ? `, skip ${list.length - ok} blocked` : ''}: ${list.map((m) => `${m.company ?? m.to}${m.follow_up ? ' (follow-up)' : ''}${m.blocked ? ' [blocked]' : ''}`).join(', ')}`;
  }

  // ---- send queue ----
  // An approved batch is queued, not blasted: each email gets a slot inside the PROSPECT's business hours, spaced
  // minutes apart, within the daily cap. The queue lives in the database, so a restart never cuts a batch in half.
  window() { const w = this.settings.get('outreach_window', null) ?? {}; return { start: w.start ?? '09:30', end: w.end ?? '16:30', days: Array.isArray(w.days) && w.days.length ? w.days : [1, 2, 3, 4, 5] }; }
  spacing() { const s = this.settings.get('outreach_spacing_min', null); return Array.isArray(s) && s.length === 2 ? s.map(Number) : [6, 14]; }
  #tzOf(lead) { return lead?.timezone ?? this.settings.get('timezone', null) ?? 'Asia/Kolkata'; }

  // First instant >= t that is inside the sending window in tz (jittered a little after the window opens).
  #slot(t, tz) {
    const w = this.window(); const [sh, sm] = w.start.split(':').map(Number); const [eh, em] = w.end.split(':').map(Number);
    let at = t;
    for (let i = 0; i < 15; i++) {
      const p = partsInTz(new Date(at), tz); const mins = p.h * 60 + p.mi;
      if (w.days.includes(p.dow) && mins >= sh * 60 + sm && mins < eh * 60 + em) return at;
      const day = w.days.includes(p.dow) && mins < sh * 60 + sm ? p.d : p.d + 1;
      at = zonedToUtc({ y: p.y, m: p.m, d: day, h: sh, mi: sm }, tz).getTime() + Math.floor(Math.random() * 25) * 60_000;
    }
    return at;
  }

  async send(emails) {
    if (!this.gmail?.ready) return { error: 'outreach_gmail_not_connected: connect Gmail (outreach) in Settings → Connected apps; nothing was sent' };
    const list = this.prepare(emails);
    const [lo, hi] = this.spacing();
    const gap = () => (lo + Math.random() * Math.max(0, hi - lo)) * 60_000;
    const last = this.db.prepare("SELECT MAX(scheduled_at) t FROM outbox WHERE status='queued'").get().t;
    let cursor = Math.max(this.now(), last ? Date.parse(last) + gap() : this.now());
    const queued = []; const skipped = [];
    for (const m of list) {
      if (m.blocked) { skipped.push({ to: m.to, skipped: m.blocked }); continue; }
      if (this.db.prepare("SELECT 1 FROM outbox WHERE lead_id=? AND status='queued'").get(m.lead_id)) { skipped.push({ to: m.to, skipped: 'already queued' }); continue; }
      const lead = this.get(m.lead_id); const tz = this.#tzOf(lead);
      let at = this.#slot(cursor, tz);
      for (let i = 0; i < 30 && this.#scheduledOn(at, tz) >= this.cap(); i++) at = this.#slot(at + DAY, tz); // daily cap per local day
      const id = randomUUID();
      this.db.prepare('INSERT INTO outbox (id,lead_id,to_addr,subject,body,follow_up,opt_out,scheduled_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, m.lead_id, m.to, m.subject, m.body, m.follow_up ? 1 : 0, m.opt_out === false ? 0 : 1, this.#iso(at), this.#iso());
      this.#event(m.lead_id, 'queued', `${m.follow_up ? 'follow-up' : 'first email'} scheduled ${formatLocal(new Date(at), tz)} (${tz})`);
      queued.push({ to: m.to, company: m.company, at_local: formatLocal(new Date(at), tz), timezone: tz });
      cursor = at + gap();
    }
    if (queued.length) await this.flushOutbox();
    return { queued: queued.length, schedule: queued, skipped, note: 'Emails go out one by one inside each prospect\'s business hours; replies cancel anything still queued for that lead.' };
  }

  // Emails (sent + queued) on the local calendar day of instant t in tz.
  #scheduledOn(t, tz) {
    const p = partsInTz(new Date(t), tz);
    const from = zonedToUtc({ y: p.y, m: p.m, d: p.d, h: 0, mi: 0 }, tz).toISOString(); const to = zonedToUtc({ y: p.y, m: p.m, d: p.d + 1, h: 0, mi: 0 }, tz).toISOString();
    return this.db.prepare("SELECT COUNT(*) n FROM outbox WHERE status IN ('queued','sent') AND COALESCE(sent_at, scheduled_at) >= ? AND COALESCE(sent_at, scheduled_at) < ?").get(from, to).n;
  }

  cancelQueued(leadId, reason) {
    const n = this.db.prepare("UPDATE outbox SET status='cancelled', error=? WHERE lead_id=? AND status='queued'").run(clean(reason, 200), leadId).changes;
    if (n) this.#event(leadId, 'cancelled', `${n} queued email(s) cancelled: ${reason}`);
    return n;
  }
  outbox({ status = 'queued', limit = 30 } = {}) {
    return this.db.prepare('SELECT o.id, o.to_addr, o.subject, o.follow_up, o.scheduled_at, o.status, o.error, l.company, l.timezone FROM outbox o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.status=? ORDER BY o.scheduled_at LIMIT ?').all(status, limit)
      .map((r) => ({ id: r.id.slice(0, 8), company: r.company, to: r.to_addr, subject: r.subject, follow_up: Boolean(r.follow_up), at_local: formatLocal(new Date(r.scheduled_at), r.timezone ?? this.#tzOf(null)), status: r.status, ...(r.error ? { note: r.error } : {}) }));
  }

  // Send every queued email whose slot has come (normally one per minute-tick, because slots are spaced).
  async flushOutbox() {
    if (!this.gmail?.ready || this.paused()) return 0;
    let sent = 0;
    for (const row of this.db.prepare("SELECT * FROM outbox WHERE status='queued' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 5").all(this.#iso())) {
      const lead = this.get(row.lead_id);
      const stop = !lead ? 'lead deleted' : this.isSuppressed(row.to_addr) ? 'do-not-contact' : ['dnc', 'won', 'lost', 'replied', 'meeting', 'proposal'].includes(lead.stage) ? `lead is ${lead.stage}` : row.follow_up && !lead.last_message_id ? 'no thread to follow up in' : null;
      if (stop) { this.db.prepare("UPDATE outbox SET status='cancelled', error=? WHERE id=?").run(stop, row.id); continue; }
      if (this.sentToday() >= this.cap()) { this.db.prepare('UPDATE outbox SET scheduled_at=? WHERE id=?').run(this.#iso(this.#slot(this.now() + 6 * 3600_000, this.#tzOf(lead))), row.id); continue; }
      const m = { to: row.to_addr, subject: row.subject, body: row.body, follow_up: Boolean(row.follow_up), opt_out: Boolean(row.opt_out), lead_id: row.lead_id };
      try {
        const { text, html } = this.render(m);
        const r = m.follow_up ? await this.gmail.reply({ message_id: lead.last_message_id, to: m.to, body: text, html }) : await this.gmail.send({ to: m.to, subject: m.subject, body: text, html });
        if (r?.error) throw new Error(r.error);
        this.db.prepare("UPDATE outbox SET status='sent', sent_at=? WHERE id=?").run(this.#iso(), row.id);
        this.recordSend({ to: m.to, subject: m.subject ?? '(follow-up)', message_id: r.id, thread_id: r.thread_id, leadId: row.lead_id });
        sent++;
      } catch (e) {
        const attempts = row.attempts + 1; const err = String(e.message ?? e).slice(0, 200);
        if (attempts >= 3) { this.db.prepare("UPDATE outbox SET status='failed', attempts=?, error=? WHERE id=?").run(attempts, err, row.id); this.notifications?.create({ level: 'warning', title: `Outreach email to ${lead.company} failed`, body: err }); }
        else this.db.prepare('UPDATE outbox SET attempts=?, error=?, scheduled_at=? WHERE id=?').run(attempts, err, this.#iso(this.now() + 30 * 60_000), row.id);
      }
    }
    return sent;
  }

  // Any email that reached a lead (outreach_send or a normal email_send) advances the sequence.
  recordSend({ to, subject = '', message_id = null, thread_id = null, leadId = null }) {
    const lead = leadId ? this.get(leadId) : addrs(to).map((a) => this.byEmail(a)).find(Boolean);
    if (!lead) return null;
    const touches = lead.touches + 1;
    const gap = FOLLOW_UP_DAYS[touches - 1];
    const next = touches >= MAX_TOUCHES || !gap ? null : this.#iso(this.now() + gap * DAY);
    const stage = ['new', 'researched', 'nurture'].includes(lead.stage) ? 'contacted' : lead.stage;
    this.db.prepare('UPDATE leads SET touches=?, last_touch_at=?, last_message_id=COALESCE(?, last_message_id), thread_id=COALESCE(?, thread_id), stage=?, next_at=?, next_action=?, updated_at=? WHERE id=?')
      .run(touches, this.#iso(), message_id, thread_id, stage, stage === 'contacted' ? next : lead.next_at, stage === 'contacted' ? (next ? `follow-up ${touches + 1}${touches + 1 === MAX_TOUCHES ? ' (breakup)' : ''}` : 'sequence finished — nurture or close') : lead.next_action, this.#iso(), lead.id);
    this.#event(lead.id, 'sent', `touch ${touches}: ${subject}`);
    return this.get(lead.id);
  }

  // ---- background: replies, bounces, due follow-ups ----
  #outboxTimer = null;
  start(intervalMs = 10 * 60_000) {
    if (!this.#timer) { this.#timer = setInterval(() => void this.tick().catch(() => {}), intervalMs); this.#timer.unref?.(); }
    if (!this.#outboxTimer) { this.#outboxTimer = setInterval(() => void this.flushOutbox().catch(() => {}), 60_000); this.#outboxTimer.unref?.(); }
  }
  stop() { clearInterval(this.#timer); clearInterval(this.#outboxTimer); this.#timer = null; this.#outboxTimer = null; }

  async tick() {
    const out = { replies: 0, bounces: 0, nudged: false };
    if (this.gmail?.ready) {
      out.replies = await this.#checkReplies();
      out.bounces = await this.#checkBounces();
    }
    out.nudged = this.#nudgeDue();
    return out;
  }

  async #checkReplies() {
    const active = this.db.prepare("SELECT * FROM leads WHERE email IS NOT NULL AND touches > 0 AND stage IN ('contacted','nurture') AND last_touch_at >= ?").all(this.#iso(this.now() - 45 * DAY));
    let n = 0;
    for (let i = 0; i < active.length; i += 15) {
      const chunk = active.slice(i, i + 15);
      const { messages = [] } = await this.gmail.search({ query: `from:(${chunk.map((l) => l.email).join(' OR ')}) newer_than:7d`, max: 25 });
      for (const m of messages) {
        const from = addrs(m.from)[0];
        const lead = chunk.find((l) => l.email === from);
        if (!lead || lead.last_reply_id === m.id) continue;
        if (Date.parse(m.date ?? '') < Date.parse(lead.last_touch_at)) continue; // older than our last email
        this.db.prepare('UPDATE leads SET last_reply_id=? WHERE id=?').run(m.id, lead.id);
        await this.#onReply(lead, m); n++;
      }
    }
    return n;
  }

  async #onReply(lead, m) {
    const text = `${m.subject ?? ''}\n${m.snippet ?? ''}`;
    const who = `${lead.contact_name ?? lead.email} (${lead.company})`;
    // Fixed rule first: an explicit opt-out never depends on a model.
    let verdict = UNSUB_RE.test(ownWords(m.snippet)) ? { action: 'stop' } : null;
    if (!verdict && this.judge?.ready) {
      try {
        const full = await this.gmail.open?.(m.id).catch(() => null);
        verdict = await this.judge.classifyReply({ ourSubject: m.subject ?? '', replyText: ownWords(full?.body ?? m.snippet) || m.snippet });
      } catch { verdict = null; } // fall back to the rules below
    }
    if (!verdict) verdict = OOO_RE.test(text) ? { action: 'pause' } : { action: 'human' };
    this.cancelQueued(lead.id, 'they replied');
    if (verdict.action === 'stop') {
      this.suppress(lead.email, 'replied asking not to be contacted');
      this.notifications?.create({ level: 'info', title: `🚫 ${who} opted out`, body: 'Added to do-not-contact. No more emails will go to them.' });
      return;
    }
    if (verdict.action === 'pause') {
      this.db.prepare('UPDATE leads SET next_at=?, updated_at=? WHERE id=?').run(this.#iso(this.now() + 7 * DAY), this.#iso(), lead.id);
      this.#event(lead.id, 'ooo', `out of office: ${clean(m.snippet, 200)}`);
      return;
    }
    const LABEL = { positive: 'interested', question: 'has a question', objection: 'pushed back', not_now: 'said not now', referral: 'referred you to someone' };
    const kind = LABEL[verdict.category] ?? 'replied';
    this.db.prepare("UPDATE leads SET stage='replied', next_at=NULL, next_action=?, updated_at=? WHERE id=?").run(`answer their reply${verdict.category ? ` (${verdict.category})` : ''}`, this.#iso(), lead.id);
    this.#event(lead.id, 'reply', `${verdict.category ? `[${verdict.category}${verdict.meeting ? ', wants a meeting' : ''}] ` : ''}${clean(m.snippet, 480)}`);
    this.bus?.publish('lead.replied', { id: lead.id, category: verdict.category ?? null });
    this.notifications?.create({ level: 'warning', title: `${verdict.category === 'positive' || verdict.meeting ? '🔥' : '💬'} ${who} ${kind}${verdict.meeting ? ' and wants a call' : ''}`, body: `“${clean(m.snippet, 300)}”\nFollow-ups stopped. Ask me to draft the answer (outreach inbox, lead ${lead.id.slice(0, 8)}, message ${m.id}).` });
  }

  async #checkBounces() {
    const { messages = [] } = await this.gmail.search({ query: 'from:(mailer-daemon OR postmaster) newer_than:3d', max: 15 });
    const seen = new Set(this.settings.get('pipeline_bounces_seen', []));
    let n = 0;
    for (const m of messages) {
      if (seen.has(m.id)) continue; seen.add(m.id);
      const hit = (String(m.snippet ?? '').match(/[^\s<>()"',;:]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map(lower).map((a) => this.byEmail(a)).find((l) => l && l.touches > 0);
      if (!hit) continue;
      this.db.prepare("UPDATE leads SET stage='lost', next_at=NULL, next_action='bounced — find a current address or contact', updated_at=? WHERE id=?").run(this.#iso(), hit.id);
      this.#event(hit.id, 'bounce', clean(m.snippet, 300)); n++;
    }
    this.settings.set('pipeline_bounces_seen', [...seen].slice(-200));
    if (n) this.#bounceBreaker();
    return n;
  }

  // ---- circuit breaker: protect the sending account ----
  // More than 2% of the last 100 first-touch sends bounced (with at least 20 sent): stop sending until the user resumes.
  #bounceBreaker() {
    const sent = this.db.prepare("SELECT lead_id FROM lead_events WHERE kind='sent' ORDER BY at DESC LIMIT 100").all();
    if (sent.length < 20) return;
    const ids = new Set(sent.map((r) => r.lead_id));
    const bounced = this.db.prepare("SELECT DISTINCT lead_id FROM lead_events WHERE kind='bounce'").all().filter((r) => ids.has(r.lead_id)).length;
    if (bounced / sent.length > 0.02) this.pause(`${bounced} of the last ${sent.length} emails bounced (over 2%): the list needs checking before the account gets flagged`);
  }
  paused() { return this.settings.get('outreach_paused', null); }
  pause(reason) {
    if (this.paused()) return this.paused();
    const p = { reason: clean(reason, 300), at: this.#iso() };
    this.settings.set('outreach_paused', p);
    this.notifications?.create({ level: 'warning', title: '⏸ Outreach paused', body: `${p.reason}\nQueued emails are held. Ask me to resume outreach when it is fixed.` });
    return p;
  }
  resume() { this.settings.set('outreach_paused', null); return { resumed: true }; }

  #nudgeDue() {
    const day = this.#iso().slice(0, 10);
    if (this.settings.get('pipeline_nudge_day', null) === day) return false;
    const due = this.find({ due: true, limit: 100 });
    if (!due.count) return false;
    this.settings.set('pipeline_nudge_day', day);
    this.notifications?.create({ level: 'info', title: `📬 ${due.count} follow-up${due.count === 1 ? '' : 's'} due`, body: `${due.leads.slice(0, 5).map((l) => l.company).join(', ')}${due.count > 5 ? '…' : ''}\nSay "do my follow-ups" and I'll draft them for one approval.` });
    return true;
  }
}
