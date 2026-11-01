// Recommendations ledger: every suggestion Friday makes that the owner could act on ("pitch freight forwarders in
// Pune next", "move the follow-up to day 4") is filed with its evidence, what it should lead to, and a date to
// check. When that date comes it is scored worked / mixed / failed, so Friday's advice gets a track record instead
// of vanishing into chat. A suggestion that costs money must cite evidence the owner can check.
import { randomUUID } from 'node:crypto';
import { parseWhen } from './time.mjs';

const DAY = 86_400_000;
const STATUSES = ['open', 'accepted', 'declined', 'expired'];
const OUTCOMES = ['worked', 'mixed', 'failed'];
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export class Recs {
  constructor({ store, settings = null, bus = null, now = () => new Date() }) {
    Object.assign(this, { settings, bus, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS recs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, because TEXT NOT NULL, evidence TEXT, expect TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
      cost TEXT, confidence TEXT NOT NULL DEFAULT 'medium', act_by TEXT, review_on TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      decided_at TEXT, decision_note TEXT, outcome TEXT, outcome_note TEXT, scored_at TEXT, source TEXT NOT NULL DEFAULT 'chat',
      conversation_id TEXT, created_at TEXT NOT NULL
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS recs_review_idx ON recs (outcome, review_on)');
  }

  get timezone() { return this.settings?.get('timezone', null) ?? Intl.DateTimeFormat().resolvedOptions().timeZone; }
  #iso() { return this.now().toISOString(); }
  #date(v, name) {
    if (v === null || v === undefined || v === '') return null;
    if (/^\d+$/.test(String(v))) return new Date(this.now().getTime() + Number(v) * DAY).toISOString(); // "in N days"
    const s = String(v).trim();
    try { return parseWhen(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T09:00` : s, this.timezone).toISOString(); } // a plain date = 09:00 local that day
    catch { throw new TypeError(`${name}: use a date like 2026-11-20, a datetime, or a number of days`); }
  }

  add({ title, because, evidence = null, expect, category = 'other', cost = null, confidence = 'medium', actBy = null, reviewOn = 14, source = 'chat', conversationId = null }) {
    const t = clean(title, 200), b = clean(because, 1000), e = clean(expect, 500);
    if (!t) throw new TypeError('title required: the suggestion in one line');
    if (!b) throw new TypeError('because required: the evidence or reasoning behind it');
    if (!e) throw new TypeError('expect required: what should happen if he follows it (so it can be scored later)');
    const ev = Array.isArray(evidence) ? evidence.map((x) => clean(x, 300)).filter(Boolean).slice(0, 8) : (clean(evidence, 300) ? [clean(evidence, 300)] : []);
    if (clean(cost, 120) && !ev.length && !/https?:\/\/|\d/.test(b)) throw new TypeError('evidence required: a suggestion that costs money must cite something he can check (a link, a number, a quote)');
    if (!['low', 'medium', 'high'].includes(confidence)) throw new TypeError('confidence: low, medium or high');
    const id = randomUUID();
    this.db.prepare(`INSERT INTO recs (id, title, because, evidence, expect, category, cost, confidence, act_by, review_on, source, conversation_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, t, b, ev.length ? JSON.stringify(ev) : null, e, clean(category, 40) || 'other', clean(cost, 120) || null, confidence,
      this.#date(actBy, 'act_by'), this.#date(reviewOn, 'review_on') ?? new Date(this.now().getTime() + 14 * DAY).toISOString(), clean(source, 40) || 'chat', conversationId, this.#iso());
    this.bus?.publish('rec.created', { id, title: t });
    return this.get(id);
  }

  get(id) { const r = this.db.prepare('SELECT * FROM recs WHERE id=?').get(id); return r ? { ...r, evidence: r.evidence ? JSON.parse(r.evidence) : [] } : null; }
  find(ref) {
    const r = String(ref ?? '').trim(); if (!r) return null;
    const byId = this.get(r); if (byId) return byId;
    const hits = this.db.prepare('SELECT id FROM recs WHERE id LIKE ? OR lower(title) LIKE ? ORDER BY created_at DESC LIMIT 3').all(`${r.replace(/[%_]/g, '')}%`, `%${r.toLowerCase().replace(/[%_]/g, '')}%`);
    return hits.length === 1 ? this.get(hits[0].id) : null;
  }
  list({ status = null, limit = 50 } = {}) {
    this.#expire();
    const rows = status ? this.db.prepare('SELECT id FROM recs WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit) : this.db.prepare('SELECT id FROM recs ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map((r) => this.get(r.id));
  }

  // An open suggestion whose act-by date passed without a decision is expired (still scored if it was acted on).
  #expire() { this.db.prepare("UPDATE recs SET status='expired', decided_at=? WHERE status='open' AND act_by IS NOT NULL AND act_by < ?").run(this.#iso(), this.#iso()); }

  decide(id, { status, note = null }) {
    if (!['accepted', 'declined'].includes(status)) throw new TypeError('status: accepted or declined');
    const r = this.get(id); if (!r) throw new Error('not_found');
    if (r.status !== 'open') throw new Error(`already_${r.status}`);
    this.db.prepare('UPDATE recs SET status=?, decided_at=?, decision_note=? WHERE id=?').run(status, this.#iso(), clean(note, 500) || null, id);
    this.bus?.publish('rec.decided', { id, status });
    return this.get(id);
  }

  // Scored once its review date has come (or earlier when the result is already clear). Declined ones are not scored.
  score(id, { outcome, note }) {
    if (!OUTCOMES.includes(outcome)) throw new TypeError('outcome: worked, mixed or failed');
    const r = this.get(id); if (!r) throw new Error('not_found');
    if (r.status === 'declined') throw new Error('declined: nothing to score');
    const n = clean(note, 600); if (!n) throw new TypeError('note required: what actually happened, with numbers where you have them');
    this.db.prepare("UPDATE recs SET outcome=?, outcome_note=?, scored_at=?, status=CASE WHEN status='open' THEN 'accepted' ELSE status END WHERE id=?").run(outcome, n, this.#iso(), id);
    this.bus?.publish('rec.scored', { id, outcome });
    return this.get(id);
  }

  dueForReview({ max = 5 } = {}) {
    return this.db.prepare("SELECT id FROM recs WHERE outcome IS NULL AND status IN ('accepted','open','expired') AND review_on <= ? ORDER BY review_on ASC LIMIT ?").all(this.#iso(), max).map((r) => this.get(r.id));
  }

  // The track record: how often he takes Friday's advice, and how often it works.
  stats({ sinceDays = 90 } = {}) {
    const since = new Date(this.now().getTime() - sinceDays * DAY).toISOString();
    const rows = this.db.prepare('SELECT category, status, outcome FROM recs WHERE created_at >= ?').all(since);
    const sum = (list) => {
      const decided = list.filter((r) => r.status === 'accepted' || r.status === 'declined');
      const scored = list.filter((r) => r.outcome);
      return { total: list.length, accepted: list.filter((r) => r.status === 'accepted').length, declined: list.filter((r) => r.status === 'declined').length,
        acceptance: decided.length ? +(list.filter((r) => r.status === 'accepted').length / decided.length).toFixed(2) : null,
        scored: scored.length, worked: scored.filter((r) => r.outcome === 'worked').length, mixed: scored.filter((r) => r.outcome === 'mixed').length, failed: scored.filter((r) => r.outcome === 'failed').length,
        hit_rate: scored.length ? +((scored.filter((r) => r.outcome === 'worked').length + 0.5 * scored.filter((r) => r.outcome === 'mixed').length) / scored.length).toFixed(2) : null };
    };
    const byCategory = {};
    for (const c of [...new Set(rows.map((r) => r.category))]) byCategory[c] = sum(rows.filter((r) => r.category === c));
    return { since_days: sinceDays, ...sum(rows), by_category: byCategory };
  }

  summaryLines() {
    return this.dueForReview({ max: 3 }).map((r) => `- [${r.id.slice(0, 8)}] "${r.title}" (expected: ${clean(r.expect, 140)}; ${r.status})`);
  }
}

export function recTools(recs) {
  const view = (r) => ({ id: r.id.slice(0, 8), title: r.title, because: r.because, evidence: r.evidence, expect: r.expect, category: r.category, cost: r.cost, confidence: r.confidence,
    act_by: r.act_by, review_on: r.review_on, status: r.status, outcome: r.outcome, outcome_note: r.outcome_note });
  const missing = () => ({ error: 'not_found_or_ambiguous', recent: recs.list({ limit: 10 }).map(view) });
  const wrap = (fn) => { try { return fn(); } catch (e) { return { error: e.message }; } };
  return [
    {
      name: 'rec_add', risk: 'safe',
      description: "File a concrete suggestion YOU are making that he could act on (a segment to target, a price, a habit, a purchase, a change to how something runs), so it can be checked later. Not for things he asked you to do (just do them) or to-dos (todo_add). because = your evidence/reasoning; expect = what should happen if he follows it, measurable if possible; review_on = date or days until it can be judged (default 14); cost = what it costs if anything (money suggestions must cite evidence: a link, number or quote).",
      parameters: { type: 'object', properties: { title: { type: 'string' }, because: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, expect: { type: 'string' },
        category: { type: 'string', description: 'e.g. sales, money, health, work, learning, tools' }, cost: { type: 'string' }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        act_by: { type: 'string' }, review_on: { type: 'string' } }, required: ['title', 'because', 'expect'], additionalProperties: false },
      run: (a, { conversationId } = {}) => wrap(() => view(recs.add({ ...a, actBy: a.act_by, reviewOn: a.review_on ?? 14, conversationId, source: 'chat:model' }))),
    },
    {
      name: 'rec_decide', risk: 'safe',
      description: 'Record that he accepted or declined one of your suggestions (when he says so in chat).',
      parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['accepted', 'declined'] }, note: { type: 'string' } }, required: ['id', 'status'], additionalProperties: false },
      run: (a) => { const r = recs.find(a.id); return r ? wrap(() => view(recs.decide(r.id, a))) : missing(); },
    },
    {
      name: 'rec_score', risk: 'safe',
      description: 'Score a suggestion once its result is known: worked, mixed or failed, with a note of what actually happened (numbers over adjectives). Check the evidence first (replies, results, his words); ask him if you cannot tell.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, outcome: { type: 'string', enum: ['worked', 'mixed', 'failed'] }, note: { type: 'string' } }, required: ['id', 'outcome', 'note'], additionalProperties: false },
      run: (a) => { const r = recs.find(a.id); return r ? wrap(() => view(recs.score(r.id, a))) : missing(); },
    },
    {
      name: 'rec_list', risk: 'safe',
      description: "Your past suggestions and their track record (acceptance, hit rate, by category). Use before advising on something similar, or when he asks how your advice has worked out.",
      parameters: { type: 'object', properties: { status: { type: 'string', enum: STATUSES }, due_for_review: { type: 'boolean' } }, additionalProperties: false },
      run: (a) => ({ recs: (a.due_for_review ? recs.dueForReview({ max: 10 }) : recs.list({ status: a.status ?? null, limit: 20 })).map(view), stats: recs.stats() }),
    },
  ];
}
