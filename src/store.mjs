import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';

const ALLOWED = {
  queued: ['planning', 'running', 'cancelled'],
  planning: ['running', 'waiting', 'blocked', 'failed', 'cancelled'],
  running: ['waiting', 'blocked', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'blocked', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  completed: [], failed: ['queued'], cancelled: [],
};

export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        result TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effects (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        exact_args TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name));
    if (!columns.has('result')) this.db.exec('ALTER TABLE tasks ADD COLUMN result TEXT');
    if (!columns.has('error')) this.db.exec('ALTER TABLE tasks ADD COLUMN error TEXT');
    // A process may have disappeared after an external action. Never auto-retry such work.
    const recoveredAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO events (task_id, kind, detail, created_at) SELECT id, 'task.blocked', '{\"error\":\"interrupted; inspect before retry\"}', ? FROM tasks WHERE status IN ('planning', 'running')").run(recoveredAt);
      this.db.prepare("UPDATE tasks SET status='blocked', error='interrupted; inspect before retry', updated_at=? WHERE status IN ('planning', 'running')").run(recoveredAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createTask({ title, instruction, idempotencyKey = null }) {
    if (idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key=?').get(idempotencyKey);
      if (existing) return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO tasks (id, title, instruction, status, created_at, updated_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, title, instruction, 'queued', now, now, idempotencyKey);
      this.db.prepare('INSERT INTO events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(id, 'task.created', '{}', now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (idempotencyKey) {
        const existing = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key=?').get(idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
    return this.getTask(id);
  }

  getTask(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) ?? null; }
  listTasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all(); }
  countTasks() { return this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n; }
  nextQueuedTask() { return this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get() ?? null; }
  claimNextQueuedTask() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.nextQueuedTask();
      if (!task) { this.db.exec('COMMIT'); return null; }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=? AND status='queued'").run(now, task.id);
      this.db.prepare('INSERT INTO events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(task.id, 'task.running', '{}', now);
      this.db.exec('COMMIT');
      return this.getTask(task.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  listEvents(taskId) { return this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id ASC').all(taskId).map(row => ({ ...row, detail: JSON.parse(row.detail) })); }

  transition(id, status, detail = {}) {
    const task = this.getTask(id);
    if (!task) return { error: 'not_found' };
    if (!ALLOWED[task.status]?.includes(status)) return { error: 'invalid_transition', task };
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db.prepare('UPDATE tasks SET status=?, updated_at=?, result=?, error=? WHERE id=? AND status=?').run(status, now, status === 'completed' ? String(detail.result ?? '') : task.result, status === 'failed' || status === 'blocked' ? String(detail.error ?? status) : task.error, id, task.status);
      if (updated.changes !== 1) throw new Error('task changed concurrently');
      this.db.prepare('INSERT INTO events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(id, `task.${status}`, JSON.stringify(detail), now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { task: this.getTask(id) };
  }

  close() { this.db.close(); }
}
