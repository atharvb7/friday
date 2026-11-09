// Goals: what the owner is working toward ("3 FDE clients by December"), each with an append-only trail of notes
// and one short "where this stands" digest. The digest, not the notes, goes into Fridayy's context, so a goal costs
// a couple of lines per turn however long its history gets; every note must come with the rewritten digest.
import { randomUUID } from 'node:crypto';

const MAX_ACTIVE = 12;
const DIGEST_MAX = 600;
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export class Goals {
  constructor({ store, bus = null, now = () => new Date() }) {
    Object.assign(this, { bus, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT, status TEXT NOT NULL DEFAULT 'active', digest TEXT, digest_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS goal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL REFERENCES goals(id), ts TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'chat'
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS goal_notes_goal_idx ON goal_notes (goal_id, ts)');
  }

  #iso() { return this.now().toISOString(); }

  add({ title, why = null, digest = null }) {
    const t = clean(title, 200); if (!t) throw new TypeError('title required');
    if (this.list({ status: 'active' }).length >= MAX_ACTIVE) throw new Error(`too_many_goals: ${MAX_ACTIVE} active already; finish or drop one first`);
    const dup = this.list({ status: 'active' }).find((g) => g.title.toLowerCase() === t.toLowerCase());
    if (dup) return dup;
    const id = randomUUID(); const now = this.#iso(); const d = clean(digest, DIGEST_MAX) || null;
    this.db.prepare('INSERT INTO goals (id, title, why, digest, digest_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, t, clean(why, 500) || null, d, d ? now : null, now, now);
    this.bus?.publish('goal.created', { id, title: t });
    return this.get(id);
  }

  get(id) { return this.db.prepare('SELECT * FROM goals WHERE id=?').get(id) ?? null; }
  list({ status = 'active' } = {}) { return this.db.prepare('SELECT * FROM goals WHERE status=? ORDER BY created_at ASC LIMIT 50').all(status); }
  notes(id, limit = 10) { return this.db.prepare('SELECT ts, text, source FROM goal_notes WHERE goal_id=? ORDER BY id DESC LIMIT ?').all(id, limit); }

  // id: full id, its first 8 characters, or words unique to one active goal's title.
  find(ref) {
    const r = String(ref ?? '').trim(); if (!r) return null;
    const exact = this.get(r) ?? this.db.prepare('SELECT * FROM goals WHERE id LIKE ?').all(`${r.replace(/[%_]/g, '')}%`);
    if (exact && !Array.isArray(exact)) return exact;
    if (Array.isArray(exact) && exact.length === 1 && r.length >= 6) return exact[0];
    const hits = this.list({ status: 'active' }).filter((g) => g.title.toLowerCase().includes(r.toLowerCase()));
    return hits.length === 1 ? hits[0] : null;
  }

  // A note (progress, evidence, a setback) always comes with the rewritten digest, so the digest never goes stale.
  note(id, { text, digest, source = 'chat' }) {
    const g = this.get(id); if (!g) throw new Error('not_found');
    const n = clean(text, 1000); const d = clean(digest, DIGEST_MAX);
    if (!n) throw new TypeError('note text required');
    if (!d) throw new TypeError('digest required: rewrite "where this stands" in 1-3 plain sentences including this note');
    const now = this.#iso();
    this.db.prepare('INSERT INTO goal_notes (goal_id, ts, text, source) VALUES (?,?,?,?)').run(id, now, n, source);
    this.db.prepare('UPDATE goals SET digest=?, digest_at=?, updated_at=? WHERE id=?').run(d, now, now, id);
    this.bus?.publish('goal.noted', { id });
    return this.get(id);
  }

  update(id, { title, why, digest, status } = {}) {
    const g = this.get(id); if (!g) throw new Error('not_found');
    const now = this.#iso();
    if (title !== undefined) { const t = clean(title, 200); if (!t) throw new TypeError('title cannot be empty'); this.db.prepare('UPDATE goals SET title=?, updated_at=? WHERE id=?').run(t, now, id); }
    if (why !== undefined) this.db.prepare('UPDATE goals SET why=?, updated_at=? WHERE id=?').run(clean(why, 500) || null, now, id);
    if (digest !== undefined) this.db.prepare('UPDATE goals SET digest=?, digest_at=?, updated_at=? WHERE id=?').run(clean(digest, DIGEST_MAX) || null, now, now, id);
    if (status !== undefined) {
      if (!['active', 'done', 'dropped'].includes(status)) throw new TypeError('status must be active, done or dropped');
      this.db.prepare('UPDATE goals SET status=?, closed_at=?, updated_at=? WHERE id=?').run(status, status === 'active' ? null : now, now, id);
    }
    return this.get(id);
  }

  // For Fridayy's context: one line per active goal.
  summaryLines({ max = 6, chars = 220 } = {}) {
    return this.list({ status: 'active' }).slice(0, max).map((g) => `- [${g.id.slice(0, 8)}] ${g.title}: ${g.digest ? clean(g.digest, chars) : 'no status yet'}`);
  }
}

export function goalTools(goals) {
  const view = (g, withNotes = false) => ({ id: g.id.slice(0, 8), title: g.title, why: g.why, status: g.status, where_it_stands: g.digest, updated: g.digest_at, ...(withNotes ? { recent_notes: goals.notes(g.id, 5) } : {}) });
  const missing = () => ({ error: 'not_found_or_ambiguous', goals: goals.list().map((g) => view(g)) });
  return [
    {
      name: 'goal_add', risk: 'safe',
      description: "Track one of HIS longer-term goals (an outcome over weeks or months: '3 FDE clients by December', 'run a half marathon'). Not for single to-dos (todo_add). digest = where it stands now, 1-3 sentences.",
      parameters: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' }, digest: { type: 'string' } }, required: ['title'], additionalProperties: false },
      run: (a) => view(goals.add(a)),
    },
    {
      name: 'goal_note', risk: 'safe',
      description: 'Record progress, evidence or a setback on a goal. ALWAYS pass digest: the rewritten "where this stands" (1-3 plain sentences, numbers and dates over adjectives) that includes this note. id = 8-char id or words from its title.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' }, digest: { type: 'string' } }, required: ['id', 'note', 'digest'], additionalProperties: false },
      run: (a) => { const g = goals.find(a.id); if (!g) return missing(); try { return view(goals.note(g.id, { text: a.note, digest: a.digest, source: 'chat:model' })); } catch (e) { return { error: e.message }; } },
    },
    {
      name: 'goal_update', risk: 'safe',
      description: 'Mark a goal done or dropped (or active again), rename it, or correct its digest.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['active', 'done', 'dropped'] }, title: { type: 'string' }, digest: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: (a) => { const g = goals.find(a.id); if (!g) return missing(); try { return view(goals.update(g.id, { title: a.title, digest: a.digest, status: a.status })); } catch (e) { return { error: e.message }; } },
    },
    {
      name: 'goal_list', risk: 'safe',
      description: "His goals with where each stands and recent notes (status done/dropped for history). Use for 'how am I doing on X', planning, or weekly reviews.",
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'done', 'dropped'] } }, additionalProperties: false },
      run: (a) => ({ goals: goals.list({ status: a.status ?? 'active' }).map((g) => view(g, true)) }),
    },
  ];
}
