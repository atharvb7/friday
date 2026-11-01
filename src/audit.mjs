// Hash-chained append-only audit over Store events.
//
// Every append() writes one row to the `audit_chain` table carrying
// prev_hash + sha256(prev_hash | task_id | kind | detail | created_at), so any
// later modification, reordering, or field swap breaks verify(). There is no
// update or delete path: the table is append-only by construction.
//
// verify() replays the full chain and returns { ok: true } or
// { ok: false, badIndex } where badIndex is the audit row id that fails.
// Known limit, stated honestly: verify() detects tampering with stored rows
// but cannot detect truncation (deleting the tail still leaves a valid
// prefix). Compare row counts against the Store `events` table externally if
// truncation is in your threat model.
//
// Secrecy: details are redacted BEFORE hashing/storage, so the chain never
// persists NVIDIA_API_KEY values, DSH_* entries, Bearer tokens, or other
// secret-shaped fields. Redaction applies to nested objects, arrays, and
// Bearer/nvapi- tokens embedded in free-text strings.

import { createHash } from 'node:crypto';

export const GENESIS_HASH = 'GENESIS';
export const REDACTED = '[REDACTED]';

const KIND_RE = /^[a-z][a-z0-9_.]{2,79}$/;
const SECRET_KEY_RE =
  /(nvidia.?api.?key|api[_-]?key|secret|passwd|password|auth.?token|access.?token|bearer|session.?key)/i;
const DSH_KEY_RE = /^dsh_/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/=]{4,}/g;
const NVAPI_RE = /nvapi-[A-Za-z0-9\-_]{8,}/g;

// Deep redaction: secret-named keys anywhere in the structure become
// '[REDACTED]', and Bearer / nvapi- tokens inside strings are masked in place.
export function redactDetail(value) {
  if (typeof value === 'string') {
    return value.replace(BEARER_RE, `Bearer ${REDACTED}`).replace(NVAPI_RE, REDACTED);
  }
  if (Array.isArray(value)) return value.map(redactDetail);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) || DSH_KEY_RE.test(key) ? REDACTED : redactDetail(entry);
    }
    return out;
  }
  return value;
}

function chainHash(prevHash, taskId, kind, detailJson, createdAt) {
  return createHash('sha256')
    .update(JSON.stringify({ prevHash, taskId, kind, detail: detailJson, createdAt }))
    .digest('hex');
}

export class Audit {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_chain (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  last() {
    const row = this.db.prepare('SELECT * FROM audit_chain ORDER BY id DESC LIMIT 1').get();
    return row ? { ...row, detail: JSON.parse(row.detail) } : null;
  }

  length() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM audit_chain').get().n;
  }

  append(taskId, kind, detail = {}) {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new TypeError('taskId must be a non-empty string');
    }
    if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
      throw new TypeError('invalid audit kind');
    }
    if (detail !== null && typeof detail !== 'object' && typeof detail !== 'string') {
      throw new TypeError('detail must be an object or string');
    }
    const redacted = redactDetail(detail ?? {});
    const detailJson = JSON.stringify(redacted);
    const createdAt = new Date().toISOString();
    const prevHash = this.last()?.hash ?? GENESIS_HASH;
    const hash = chainHash(prevHash, taskId, kind, detailJson, createdAt);
    const result = this.db
      .prepare(
        'INSERT INTO audit_chain (task_id, kind, detail, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(taskId, kind, detailJson, prevHash, hash, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      kind,
      detail: redacted,
      prevHash,
      hash,
      createdAt,
    };
  }

  verify() {
    const rows = this.db.prepare('SELECT * FROM audit_chain ORDER BY id ASC').all();
    let expectedPrev = GENESIS_HASH;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) return { ok: false, badIndex: row.id };
      const recomputed = chainHash(row.prev_hash, row.task_id, row.kind, row.detail, row.created_at);
      if (recomputed !== row.hash) return { ok: false, badIndex: row.id };
      expectedPrev = row.hash;
    }
    return { ok: true };
  }
}
