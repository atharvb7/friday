// src/scheduler.mjs — durable scheduler backed by Store (SQLite `schedules`).
//
// - schedule(): records a one-shot or repeating intent. Accepts either an
//   existing taskId or title+instruction (which creates the task). Validates
//   only; never executes anything.
// - claimDue(): atomically flips rows from scheduled to due (BEGIN
//   IMMEDIATE) and returns them for a future WorkerLoop. No timers, no
//   auto-run, no execution anywhere in this module.
// - done()/cancel(): terminal transitions (due/scheduled -> done,
//   scheduled/due -> cancelled).

import { randomUUID } from 'node:crypto';

const STATUSES = new Set(['scheduled', 'due', 'done', 'cancelled']);

function assertIsoDate(value, name) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`invalid ${name}`);
  }
  return new Date(value).toISOString();
}

export class Scheduler {
  constructor(store) {
    if (!store || typeof store !== 'object' || !store.db) throw new TypeError('store required');
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        title TEXT,
        instruction TEXT,
        run_at TEXT NOT NULL,
        repeat TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_status_run_at ON schedules (status, run_at);
    `);
  }

  schedule({ taskId = null, title = null, instruction = null, runAt, repeat = null } = {}) {
    if (!arguments[0] || typeof arguments[0] !== 'object' || Array.isArray(arguments[0])) {
      throw new TypeError('args must be an object');
    }
    let resolvedTaskId;
    let resolvedTitle = null;
    let resolvedInstruction = null;
    if (taskId !== null && taskId !== undefined) {
      if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('invalid taskId');
      const task = typeof this.store.getTask === 'function' ? this.store.getTask(taskId) : null;
      if (!task) throw new Error('task_not_found');
      resolvedTaskId = task.id;
      resolvedTitle = task.title ?? null;
      resolvedInstruction = task.instruction ?? null;
    } else {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
        throw new TypeError('invalid title');
      }
      if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 20000) {
        throw new TypeError('invalid instruction');
      }
      const task = this.store.createTask({ title: title.trim(), instruction: instruction.trim() });
      resolvedTaskId = task.id;
      resolvedTitle = task.title;
      resolvedInstruction = task.instruction;
    }
    const runAtIso = assertIsoDate(runAt, 'runAt');
    let cleanRepeat = null;
    if (repeat !== null && repeat !== undefined) {
      if (typeof repeat !== 'string' || !repeat.trim() || repeat.trim().length > 50) {
        throw new TypeError('invalid repeat');
      }
      cleanRepeat = repeat.trim();
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO schedules (id, task_id, title, instruction, run_at, repeat, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, resolvedTaskId, resolvedTitle, resolvedInstruction, runAtIso, cleanRepeat, 'scheduled', now, now,
    );
    return this.get(id);
  }

  get(id) {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('invalid id');
    return this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) ?? null;
  }

  list(status = null) {
    if (status !== null && status !== undefined) {
      if (!STATUSES.has(status)) throw new TypeError('invalid status');
      return this.db.prepare('SELECT * FROM schedules WHERE status=? ORDER BY run_at ASC LIMIT 500').all(status);
    }
    return this.db.prepare('SELECT * FROM schedules ORDER BY run_at ASC LIMIT 500').all();
  }

  claimDue(now = new Date().toISOString()) {
    const nowIso = assertIsoDate(now, 'now');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare("SELECT * FROM schedules WHERE status='scheduled' AND run_at <= ? ORDER BY run_at ASC").all(nowIso);
      const claimedAt = new Date().toISOString();
      const stmt = this.db.prepare("UPDATE schedules SET status='due', updated_at=? WHERE id=? AND status='scheduled'");
      for (const row of rows) stmt.run(claimedAt, row.id);
      this.db.exec('COMMIT');
      return rows.map((row) => this.get(row.id));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  done(id) {
    return this.transition(id, 'done', ['due', 'scheduled']);
  }

  cancel(id) {
    return this.transition(id, 'cancelled', ['scheduled', 'due']);
  }

  transition(id, status, allowedFrom) {
    if (!STATUSES.has(status)) throw new TypeError('invalid status');
    const row = this.get(id);
    if (!row) throw new Error('schedule_not_found');
    if (!allowedFrom.includes(row.status)) throw new Error(`cannot transition from ${row.status} to ${status}`);
    const now = new Date().toISOString();
    const updated = this.db.prepare('UPDATE schedules SET status=?, updated_at=? WHERE id=? AND status=?').run(status, now, id, row.status);
    if (updated.changes !== 1) throw new Error('schedule changed concurrently');
    return this.get(id);
  }
}
