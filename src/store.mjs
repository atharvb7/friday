import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pre-deploy snapshot: new code changes an existing database as it starts (constructors run ALTER TABLE and
// backfills), so before that the database is copied once per code version. A crash loop on the same code never
// overwrites the copy (the fingerprint is written only after a good copy); the newest SNAPSHOT_KEEP are kept.
export const SNAPSHOT_KEEP = 3;
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
let codeFingerprint = null;
export function codeVersion() {
  if (codeFingerprint) return codeFingerprint;
  const h = createHash('sha256');
  for (const f of readdirSync(SRC_DIR, { recursive: true }).filter((f) => String(f).endsWith('.mjs')).sort()) { h.update(String(f)); h.update(readFileSync(join(SRC_DIR, f))); }
  return (codeFingerprint = h.digest('hex').slice(0, 16));
}
function preDeploySnapshot(db, filename) {
  const dir = join(dirname(filename), 'snapshots'); const mark = join(dir, 'code-version');
  const version = codeVersion();
  try { if (readFileSync(mark, 'utf8').trim() === version) return null; } catch { /* first snapshot */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `pre-deploy-${new Date().toISOString().replace(/[:.]/g, '-')}-${version}.db`); const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`); // a consistent copy, WAL included
  chmodSync(tmp, 0o600); renameSync(tmp, file); // never a half-written snapshot under the real name
  writeFileSync(mark, `${version}\n`, { mode: 0o600 });
  for (const f of readdirSync(dir).filter((f) => /^pre-deploy-.*\.db$/.test(f)).sort().reverse().slice(SNAPSHOT_KEEP)) rmSync(join(dir, f), { force: true });
  return file;
}

const ALLOWED = {
  queued: ['planning', 'running', 'cancelled'],
  planning: ['running', 'waiting', 'blocked', 'failed', 'cancelled'],
  running: ['waiting', 'blocked', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'blocked', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  completed: [], failed: ['queued'], cancelled: [],
};

export class Store {
  // Optional hook: ({ taskId, kind, detail }) after each committed task event.
  onEvent = null;

  constructor(filename) {
    const existed = filename !== ':memory:' && existsSync(filename);
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.snapshot = null;
    if (existed) {
      try { this.snapshot = preDeploySnapshot(this.db, filename); }
      catch (error) { console.warn(`pre-deploy snapshot failed (continuing): ${error.message}`); }
    }
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
    if (!columns.has('conversation_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN conversation_id TEXT');
    if (!columns.has('kind')) this.db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
    if (!columns.has('workspace')) this.db.exec('ALTER TABLE tasks ADD COLUMN workspace TEXT');
    if (!columns.has('meta')) this.db.exec('ALTER TABLE tasks ADD COLUMN meta TEXT');
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

  createTask({ title, instruction, idempotencyKey = null, conversationId = null, kind = 'agent', workspace = null, meta = null }) {
    if (!['agent', 'research', 'coding', 'computer', 'hermes', 'team', 'watch'].includes(kind) && !/^sub:(agent|research|coding|computer|hermes)$/.test(kind)) throw new TypeError('invalid task kind');
    if (workspace !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(workspace)) throw new TypeError('invalid workspace name');
    if (idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key=?').get(idempotencyKey);
      if (existing) return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO tasks (id, title, instruction, status, created_at, updated_at, idempotency_key, conversation_id, kind, workspace, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, title, instruction, 'queued', now, now, idempotencyKey, conversationId, kind, workspace, meta ? JSON.stringify(meta) : null);
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
    this.#emit(id, 'task.created', {});
    return this.getTask(id);
  }

  #emit(taskId, kind, detail) { try { this.onEvent?.({ taskId, kind, detail }); } catch { /* observers never break the store */ } }

  getTask(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) ?? null; }
  listTasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all(); }
  countTasks() { return this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n; }
  nextQueuedTask(kinds = null) {
    if (!kinds) return this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get() ?? null;
    if (!kinds.length) return null;
    return this.db.prepare(`SELECT * FROM tasks WHERE status='queued' AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT 1`).get(...kinds) ?? null;
  }
  // `kinds` restricts the claim to task kinds some adapter can currently run
  // (e.g. computer tasks stay queued while the laptop is offline).
  claimNextQueuedTask(kinds = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.nextQueuedTask(kinds);
      if (!task) { this.db.exec('COMMIT'); return null; }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=? AND status='queued'").run(now, task.id);
      this.db.prepare('INSERT INTO events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(task.id, 'task.running', '{}', now);
      this.db.exec('COMMIT');
      this.#emit(task.id, 'task.running', {});
      return this.getTask(task.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  // Append a trace event (tool call, step, note) without changing task state.
  addEvent(taskId, kind, detail = {}) {
    const text = JSON.stringify(detail);
    this.db.prepare('INSERT INTO events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)').run(taskId, kind, text.length > 4000 ? JSON.stringify({ truncated: text.slice(0, 3900) }) : text, new Date().toISOString());
    this.#emit(taskId, kind, detail);
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
    this.#emit(id, `task.${status}`, detail);
    return { task: this.getTask(id) };
  }

  close() { this.db.close(); }
}
