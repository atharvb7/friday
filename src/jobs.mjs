// Durable reminders and recurring agent jobs. One timer, one table.
//   kind 'reminder' -> notification (+ message in the originating chat)
//   kind 'task'     -> queues a background agent task each time it fires
// Missed fires (server was off) collapse into ONE late firing, never a flood.
import { randomUUID } from 'node:crypto';
import { nextOccurrence, parseWhen, validateRecurrence } from './time.mjs';

const MAX_ACTIVE = 200;

export class Jobs {
  #timer = null;
  constructor({ store, notifications, chat, bus, settings, now = () => new Date() }) {
    Object.assign(this, { store, notifications, chat, bus, settings, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('reminder','task')), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      due_at TEXT NOT NULL, recurrence TEXT, timezone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      conversation_id TEXT, created_at TEXT NOT NULL, last_fired_at TEXT, fire_count INTEGER NOT NULL DEFAULT 0, max_fires INTEGER
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, due_at)");
  }

  get timezone() { return this.settings.get('timezone', null) ?? Intl.DateTimeFormat().resolvedOptions().timeZone; }

  create({ kind = 'reminder', title, body = '', when = null, recurrence = null, conversationId = null, maxFires = null }) {
    if (!['reminder', 'task'].includes(kind)) throw new TypeError('invalid kind');
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new TypeError('title required (<=200 chars)');
    if (String(body).length > 20000) throw new TypeError('body too long');
    if (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='active'").get().n >= MAX_ACTIVE) throw new TypeError('too many active jobs');
    const tz = this.timezone;
    const rec = validateRecurrence(recurrence);
    const now = this.now();
    let due;
    if (when) {
      due = parseWhen(when, tz);
      if (!rec && due.getTime() < now.getTime() - 60_000) throw new TypeError('time is in the past');
    } else if (rec) due = nextOccurrence(rec, now, tz);
    else throw new TypeError('provide `when` or a recurrence');
    const id = randomUUID();
    this.db.prepare('INSERT INTO jobs (id, kind, title, body, due_at, recurrence, timezone, conversation_id, created_at, max_fires) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, kind, title.trim(), String(body), due.toISOString(), rec ? JSON.stringify(rec) : null, tz, conversationId, now.toISOString(), maxFires);
    this.bus?.publish('job.created', { id, kind });
    return this.get(id);
  }

  get(id) { const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return r ? { ...r, recurrence: r.recurrence ? JSON.parse(r.recurrence) : null } : null; }
  findByPrefix(prefix) { const rows = this.db.prepare("SELECT id FROM jobs WHERE id LIKE ?").all(`${String(prefix).replace(/[%_]/g, '')}%`); return rows.length === 1 ? this.get(rows[0].id) : null; }
  list({ status = 'active', kind = null } = {}) {
    return this.db.prepare(`SELECT * FROM jobs WHERE status=? ${kind ? 'AND kind=?' : ''} ORDER BY due_at ASC LIMIT 100`).all(...(kind ? [status, kind] : [status])).map((r) => ({ ...r, recurrence: r.recurrence ? JSON.parse(r.recurrence) : null }));
  }
  cancel(id) { const ok = this.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=? AND status='active'").run(id).changes > 0; if (ok) this.bus?.publish('job.cancelled', { id }); return ok; }
  // Change an active job in place (new time, text or repeat rule): editing must never leave the old one firing too.
  update(id, { title = null, when = null, recurrence } = {}) {
    const j = this.get(id);
    if (!j || j.status !== 'active') return null;
    const tz = this.timezone;
    const rec = recurrence === undefined ? j.recurrence : validateRecurrence(recurrence);
    const now = this.now();
    let due = new Date(j.due_at);
    if (when) {
      due = parseWhen(when, tz);
      if (!rec && due.getTime() < now.getTime() - 60_000) throw new TypeError('time is in the past');
    } else if (recurrence !== undefined && rec) due = nextOccurrence(rec, now, tz);
    if (title !== null && (typeof title !== 'string' || !title.trim() || title.length > 200)) throw new TypeError('title required (<=200 chars)');
    this.db.prepare('UPDATE jobs SET title=?, due_at=?, recurrence=?, timezone=? WHERE id=?').run(title?.trim() || j.title, due.toISOString(), rec ? JSON.stringify(rec) : null, tz, id);
    this.bus?.publish('job.updated', { id });
    return this.get(id);
  }

  snooze(id, minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw new TypeError('minutes must be 1..10080');
    return this.db.prepare("UPDATE jobs SET due_at=? WHERE id=? AND status='active'").run(new Date(this.now().getTime() + minutes * 60_000).toISOString(), id).changes > 0;
  }

  start(intervalMs = 10_000) {
    if (this.#timer) return;
    this.#timer = setInterval(() => { try { this.tick(); } catch { /* never kill the process */ } }, intervalMs);
    this.#timer.unref();
    try { this.tick(); } catch {}
  }
  stop() { clearInterval(this.#timer); this.#timer = null; }

  // Fire everything due. Returns the number fired.
  tick() {
    const now = this.now();
    const due = this.db.prepare("SELECT * FROM jobs WHERE status='active' AND due_at <= ? ORDER BY due_at ASC LIMIT 20").all(now.toISOString());
    for (const row of due) {
      const job = { ...row, recurrence: row.recurrence ? JSON.parse(row.recurrence) : null };
      const lateMs = now.getTime() - Date.parse(job.due_at);
      // Advance state FIRST so a crash mid-fire can never double-fire.
      const fires = job.fire_count + 1;
      let nextDue = null;
      if (job.recurrence && (job.max_fires == null || fires < job.max_fires)) nextDue = nextOccurrence(job.recurrence, now, job.timezone);
      if (nextDue) this.db.prepare('UPDATE jobs SET due_at=?, last_fired_at=?, fire_count=? WHERE id=?').run(nextDue.toISOString(), now.toISOString(), fires, job.id);
      else this.db.prepare("UPDATE jobs SET status='done', last_fired_at=?, fire_count=? WHERE id=?").run(now.toISOString(), fires, job.id);
      try { this.#fire(job, lateMs); } catch (error) { this.bus?.publish('job.error', { id: job.id, error: error.message }); }
    }
    return due.length;
  }

  #fire(job, lateMs) {
    const late = lateMs > 5 * 60_000 ? ` (was due ${new Date(Date.parse(job.due_at)).toLocaleString('en-GB', { timeZone: job.timezone })})` : '';
    if (job.kind === 'reminder') {
      this.notifications.create({ level: 'info', title: `⏰ ${job.title}${late}`, body: job.body, conversationId: job.conversation_id });
      if (job.conversation_id && this.chat.getConversation(job.conversation_id)) this.chat.addMessage(job.conversation_id, 'assistant', `⏰ Reminder: ${job.title}${late}${job.body ? `\n${job.body}` : ''}`);
      this.bus?.publish('reminder.fired', { id: job.id, title: job.title });
    } else {
      const t = this.store.createTask({ title: job.title, instruction: job.body, conversationId: job.conversation_id });
      this.notifications.create({ level: 'info', title: `Scheduled task started: ${job.title}`, body: '', taskId: t.id });
      this.bus?.publish('job.task_queued', { id: job.id, taskId: t.id });
    }
  }
}
