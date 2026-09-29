import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const statuses = new Set(['proposed', 'staged', 'awaiting_approval', 'approved', 'committing', 'effect_unknown', 'verified_success', 'verified_failure']);

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function encodeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('exact arguments must be an object');
  return JSON.stringify(args);
}

export class Effects {
  constructor(store) {
    this.db = store.db;
    const columns = new Set(this.db.prepare('PRAGMA table_info(effects)').all().map(row => row.name));
    if (!columns.has('approval_hash')) this.db.exec('ALTER TABLE effects ADD COLUMN approval_hash TEXT');
    if (!columns.has('approval_expires_at')) this.db.exec('ALTER TABLE effects ADD COLUMN approval_expires_at TEXT');
    if (!columns.has('receipt')) this.db.exec('ALTER TABLE effects ADD COLUMN receipt TEXT');
    this.db.prepare("UPDATE effects SET status='effect_unknown', updated_at=? WHERE status='committing'").run(new Date().toISOString());
  }

  get(id) {
    const row = this.db.prepare('SELECT id, task_id, kind, exact_args, status, created_at, updated_at, approval_expires_at, receipt FROM effects WHERE id=?').get(id);
    return row ? { ...row, exact_args: JSON.parse(row.exact_args), receipt: row.receipt ? JSON.parse(row.receipt) : null } : null;
  }

  list(taskId) {
    return this.db.prepare('SELECT id FROM effects WHERE task_id=? ORDER BY created_at').all(taskId).map(row => this.get(row.id));
  }

  propose(taskId, kind, exactArgs) {
    if (!/^[a-z][a-z0-9_.]{2,79}$/.test(kind)) throw new TypeError('invalid effect kind');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO effects (id, task_id, kind, exact_args, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, taskId, kind, encodeArgs(exactArgs), 'proposed', now, now);
    return this.get(id);
  }

  stage(id, exactArgs) {
    const row = this.#require(id, 'proposed');
    const args = encodeArgs(exactArgs);
    if (args !== row.exact_args) throw new Error('staged arguments differ from proposal');
    this.db.prepare("UPDATE effects SET status='staged', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    return this.get(id);
  }

  requestApproval(id, ttlMs = 5 * 60_000) {
    this.#require(id, 'staged');
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw new RangeError('invalid approval TTL');
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + ttlMs).toISOString();
    this.db.prepare("UPDATE effects SET status='awaiting_approval', approval_hash=?, approval_expires_at=?, updated_at=? WHERE id=?").run(digest(token), expires, new Date().toISOString(), id);
    return { effect: this.get(id), token };
  }

  approve(id, token, exactArgs) {
    const row = this.#require(id, 'awaiting_approval');
    if (Date.parse(row.approval_expires_at) <= Date.now()) throw new Error('approval expired');
    const supplied = Buffer.from(digest(String(token)), 'hex');
    const expected = Buffer.from(row.approval_hash, 'hex');
    if (!timingSafeEqual(supplied, expected)) throw new Error('invalid approval');
    if (encodeArgs(exactArgs) !== row.exact_args) throw new Error('arguments changed after approval request');
    this.db.prepare("UPDATE effects SET status='approved', approval_hash=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    return this.get(id);
  }

  beginCommit(id, exactArgs) {
    const row = this.#require(id, 'approved');
    if (encodeArgs(exactArgs) !== row.exact_args) throw new Error('arguments changed before commit');
    this.db.prepare("UPDATE effects SET status='committing', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    return this.get(id);
  }

  resolve(id, status, receipt) {
    if (!['effect_unknown', 'verified_success', 'verified_failure'].includes(status)) throw new TypeError('invalid resolution');
    this.#require(id, 'committing');
    if (!receipt || typeof receipt !== 'object') throw new TypeError('receipt required');
    this.db.prepare('UPDATE effects SET status=?, receipt=?, updated_at=? WHERE id=?').run(status, JSON.stringify(receipt), new Date().toISOString(), id);
    return this.get(id);
  }

  #require(id, status) {
    if (!statuses.has(status)) throw new TypeError('invalid status');
    const row = this.db.prepare('SELECT * FROM effects WHERE id=?').get(id);
    if (!row) throw new Error('effect not found');
    if (row.status !== status) throw new Error(`effect must be ${status}; got ${row.status}`);
    return row;
  }
}
