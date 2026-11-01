// Commitments: things the owner said he has to get done ("lab manual today", "hackathon prototype by the 30th").
// They used to land only in memory, so the briefing (which reads tasks + reminders) said "nothing pending".
// Now they are first-class to-dos with a due date: auto-captured from chat, listed in the briefing and in Friday's
// context while open, nudged once when due soon, and closed when he says they're done.
import { randomUUID } from 'node:crypto';
import { parseWhen } from './time.mjs';

const HOUR = 3600_000;
const MAX_OPEN = 100;
// Numbers count at any length: "assignment 2" and "assignment 3" are different to-dos.
const words = (t) => new Set(String(t).toLowerCase().match(/\p{N}+|\p{L}[\p{L}\p{N}]{2,}/gu) ?? []);
const similar = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / Math.min(A.size, B.size); };

export class Commitments {
  constructor({ store, settings, bus = null, now = () => new Date() }) {
    Object.assign(this, { settings, bus, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, due_at TEXT, all_day INTEGER NOT NULL DEFAULT 0, priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL DEFAULT 'chat', conversation_id TEXT, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT, nudged_at TEXT
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS commitments_open_idx ON commitments (status, due_at)');
  }

  get timezone() { return this.settings.get('timezone', null) ?? Intl.DateTimeFormat().resolvedOptions().timeZone; }

  // due: ISO date "2026-10-30" (end of that local day, all-day) or local/offset datetime; null = no date.
  #due(due) {
    if (due === null || due === undefined || due === '') return { at: null, allDay: 0 };
    const s = String(due).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { at: parseWhen(`${s}T23:59`, this.timezone).toISOString(), allDay: 1 };
    return { at: parseWhen(s, this.timezone).toISOString(), allDay: 0 };
  }

  // Adds a commitment unless an open one already says the same thing (then its date/priority are refreshed).
  add({ title, due = null, priority = null, source = 'chat', conversationId = null, notes = null }) {
    const t = String(title ?? '').trim();
    if (!t || t.length > 200) throw new TypeError('title required (<=200 chars)');
    if (!['low', 'normal', 'high'].includes(priority)) priority = null; // unset: a refresh keeps the existing one
    const d = this.#due(due);
    const iso = this.now().toISOString();
    const dup = this.list({ status: 'open' }).find((c) => similar(c.title, t) >= 0.75);
    if (dup) {
      // A moved deadline is nudged again; a priority he did not give leaves the old one.
      this.db.prepare('UPDATE commitments SET nudged_at=CASE WHEN ? IS NOT NULL AND ? IS NOT due_at THEN NULL ELSE nudged_at END, due_at=COALESCE(?, due_at), all_day=CASE WHEN ? IS NULL THEN all_day ELSE ? END, priority=COALESCE(?, priority), updated_at=? WHERE id=?').run(d.at, d.at, d.at, d.at, d.allDay, priority, iso, dup.id);
      return { ...this.get(dup.id), updated: true };
    }
    if (this.db.prepare("SELECT COUNT(*) n FROM commitments WHERE status='open'").get().n >= MAX_OPEN) throw new TypeError('too many open commitments');
    const id = randomUUID();
    this.db.prepare('INSERT INTO commitments (id, title, due_at, all_day, priority, source, conversation_id, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, t, d.at, d.allDay, priority ?? 'normal', source, conversationId, notes ? String(notes).slice(0, 1000) : null, iso, iso);
    this.bus?.publish('commitment.added', { id, title: t });
    return { ...this.get(id), created: true };
  }

  get(id) { return this.db.prepare('SELECT * FROM commitments WHERE id=?').get(id) ?? null; }
  find(prefixOrTitle) {
    const p = String(prefixOrTitle ?? '').trim();
    if (!p) return null;
    const byId = this.db.prepare('SELECT * FROM commitments WHERE id LIKE ?').all(`${p.replace(/[%_]/g, '')}%`);
    if (byId.length === 1) return byId[0];
    const open = this.list({ status: 'open' }).map((c) => [c, similar(c.title, p)]).filter(([, s]) => s >= 0.5).sort((a, b) => b[1] - a[1]);
    return open.length && (open.length === 1 || open[0][1] > open[1][1]) ? open[0][0] : null;
  }

  // Open first by due date (undated last); done/dropped newest first.
  list({ status = 'open', dueWithinHours = null, limit = 50 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM commitments WHERE status=? ORDER BY ${status === 'open' ? "due_at IS NULL, due_at" : 'updated_at DESC'} LIMIT ?`).all(status, limit);
    if (dueWithinHours === null) return rows;
    const until = this.now().getTime() + dueWithinHours * HOUR;
    return rows.filter((c) => c.due_at && Date.parse(c.due_at) <= until);
  }

  setStatus(id, status) {
    if (!['open', 'done', 'dropped'].includes(status)) throw new TypeError('status must be open|done|dropped');
    const iso = this.now().toISOString();
    const ok = this.db.prepare('UPDATE commitments SET status=?, updated_at=?, done_at=? WHERE id=?').run(status, iso, status === 'done' ? iso : null, id).changes > 0;
    if (ok) this.bus?.publish(`commitment.${status}`, { id });
    return ok;
  }

  update(id, { title, due, priority, notes } = {}) {
    const c = this.get(id); if (!c) return null;
    const d = due === undefined ? null : this.#due(due);
    this.db.prepare('UPDATE commitments SET title=?, due_at=?, all_day=?, priority=?, notes=?, updated_at=?, nudged_at=CASE WHEN ? THEN NULL ELSE nudged_at END WHERE id=?')
      .run(title ? String(title).slice(0, 200) : c.title, d ? d.at : c.due_at, d ? d.allDay : c.all_day, priority ?? c.priority, notes ?? c.notes, this.now().toISOString(), d ? 1 : 0, id);
    return this.get(id);
  }

  // Short lines for the brain's context and the briefing: overdue + due within `hours`, then a few undated.
  summaryLines({ hours = 72, max = 8 } = {}) {
    const now = this.now().getTime();
    const tz = this.timezone;
    const fmt = (c) => {
      if (!c.due_at) return 'no date';
      const d = new Date(c.due_at);
      const day = d.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
      const late = Date.parse(c.due_at) < now ? 'OVERDUE, was due ' : 'due ';
      return `${late}${day}${c.all_day ? '' : ` ${d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`}`;
    };
    const open = this.list({ status: 'open' });
    const soon = open.filter((c) => c.due_at && Date.parse(c.due_at) <= now + hours * HOUR);
    const undated = open.filter((c) => !c.due_at).slice(0, 3);
    return [...soon, ...undated].slice(0, max).map((c) => `- [${c.id.slice(0, 8)}] ${c.title} (${fmt(c)}${c.priority === 'high' ? ', high priority' : ''})`);
  }

  // One nudge per commitment when its deadline is within `withinHours` (timed ones) or it is due today (all-day).
  dueForNudge({ withinHours = 3 } = {}) {
    const now = this.now().getTime();
    return this.list({ status: 'open' }).filter((c) => c.due_at && !c.nudged_at && Date.parse(c.due_at) - now <= (c.all_day ? 12 : withinHours) * HOUR && Date.parse(c.due_at) > now - HOUR);
  }
  markNudged(id) { this.db.prepare('UPDATE commitments SET nudged_at=? WHERE id=?').run(this.now().toISOString(), id); }
}

// Model-facing tools (core group: small, and needed whenever he mentions work he has to do).
export function commitmentTools(commitments) {
  const view = (c) => ({ id: c.id.slice(0, 8), title: c.title, due: c.due_at, all_day: Boolean(c.all_day), priority: c.priority, status: c.status });
  return [
    {
      name: 'todo_add', risk: 'safe',
      description: "Track something HE has to get done (assignment, submission, prototype, call, payment) so it shows in briefings until done. due: local date 2026-10-30 (end of that day) or datetime 2026-10-30T17:00; omit if no deadline. Add each item separately. Not for Friday's own background jobs (task_create) or timed pings (reminder_create).",
      parameters: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] }, notes: { type: 'string' } }, required: ['title'], additionalProperties: false },
      run: (a, { conversationId } = {}) => view(commitments.add({ title: a.title, due: a.due ?? null, priority: a.priority, notes: a.notes, conversationId, source: 'chat:model' })),
    },
    {
      name: 'todo_list', risk: 'safe',
      description: "His open to-dos with deadlines (status done/dropped for history). Use for \"what's pending / what do I have to do\".",
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'dropped'] } }, additionalProperties: false },
      run: (a) => ({ todos: commitments.list({ status: a.status ?? 'open', limit: 30 }).map(view) }),
    },
    {
      name: 'todo_update', risk: 'safe',
      description: 'Mark a to-do done or dropped, or change its title/deadline/priority. id = 8-char id or a few words of its title.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'dropped'] }, title: { type: 'string' }, due: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['id'], additionalProperties: false },
      run: (a) => {
        const c = commitments.find(a.id); if (!c) return { error: 'not_found_or_ambiguous', open: commitments.list({ status: 'open', limit: 15 }).map(view) };
        if (a.title || a.due !== undefined || a.priority) commitments.update(c.id, { title: a.title, due: a.due, priority: a.priority });
        if (a.status) commitments.setStatus(c.id, a.status);
        return view(commitments.get(c.id));
      },
    },
  ];
}
