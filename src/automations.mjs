// Proactive automations with explicit scopes.
//
// Design source: docs/friday-laptop-only-master-design.md
// ("Proactivity without becoming annoying" + "Security is part of the capability").
//
// Hard policy encoded here:
//  1. NO auto-goals from private data. create() requires an explicit human
//     `owner` plus an explicit trigger, and this module never scans tasks,
//     events, memory, files, messages, or any other ambient private data to
//     invent, suggest, or import automations. There is deliberately no
//     scan/suggest/discover path — only explicit creation.
//  2. fire() is a read-only query: it returns due automations and never runs
//     tools, agent turns, shell, browser, or effects. dispatch() records
//     dispatch accounting (for the maxPerDay frequency cap) and likewise
//     executes nothing. Actually performing a due automation must still go
//     through stage -> verify -> approve -> commit -> verify (src/effects.mjs)
//     with single-use approval tokens.
//  3. Capabilities are read-only-flavoured only (notify / summarize /
//     diagnose-draft / offer-open). Anything that sends, writes, executes,
//     deletes, publishes, or purchases is rejected at create() time.
//  4. Every automation carries an armed kill switch (kill_switch = 1).
//     kill(id), kill(owner), and killAll() revoke dispatch immediately;
//     revoked automations never fire again.

import { randomUUID } from 'node:crypto';

export const TRIGGER_KINDS = ['download_done', 'schedule', 'build_failed'];

// Narrow, read-only-flavoured verbs only. Anything outside this set is rejected.
export const AUTOMATION_CAPABILITIES = [
  'read-only',
  'notify',
  'summarize',
  'offer-open',
  'diagnose-draft',
];

const TRIGGER_SET = new Set(TRIGGER_KINDS);
const CAPABILITY_SET = new Set(AUTOMATION_CAPABILITIES);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_MAX_PER_DAY = 5;

function requireOwner(owner) {
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new TypeError('owner must be a non-empty string');
  }
  if (owner.length > 200) throw new RangeError('owner too long');
  return owner.trim();
}

function requireTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    throw new TypeError('trigger must be an object');
  }
  if (!TRIGGER_SET.has(trigger.kind)) {
    throw new TypeError(`invalid trigger kind: ${String(trigger.kind)}`);
  }
  let at = null;
  if (trigger.kind === 'schedule') {
    if (typeof trigger.at !== 'string' || Number.isNaN(Date.parse(trigger.at))) {
      throw new TypeError("schedule trigger requires 'at' as an ISO timestamp");
    }
    at = new Date(trigger.at).toISOString();
  } else if (trigger.at !== undefined && trigger.at !== null) {
    throw new TypeError(`trigger kind '${trigger.kind}' does not accept 'at'`);
  }
  return { kind: trigger.kind, at };
}

function requireCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new TypeError('capabilities must be a non-empty array');
  }
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability)) {
      throw new TypeError(
        `forbidden capability: ${String(capability)} (allowed: ${AUTOMATION_CAPABILITIES.join(', ')})`,
      );
    }
  }
  return [...capabilities];
}

function requireQuietHours(quietHours) {
  if (quietHours === undefined || quietHours === null) return null;
  if (typeof quietHours !== 'object' || Array.isArray(quietHours)) {
    throw new TypeError('quietHours must be { start, end } in HH:MM');
  }
  if (!TIME_RE.test(quietHours.start ?? '') || !TIME_RE.test(quietHours.end ?? '')) {
    throw new TypeError('quietHours start/end must be HH:MM (24h)');
  }
  return { start: quietHours.start, end: quietHours.end };
}

function requireExpiresAt(expiresAt) {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new TypeError('expiresAt must be an ISO timestamp');
  }
  return new Date(expiresAt).toISOString();
}

function requireMaxPerDay(maxPerDay) {
  if (maxPerDay === undefined || maxPerDay === null) return DEFAULT_MAX_PER_DAY;
  if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 100) {
    throw new RangeError('maxPerDay must be an integer in 1..100');
  }
  return maxPerDay;
}

function toMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

// Quiet hours are evaluated in UTC against the automation's declared window.
// Overnight windows (e.g. 22:00 -> 07:00) wrap correctly.
export function inQuietHours(quietHours, now = new Date()) {
  if (!quietHours) return false;
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid now timestamp');
  const current = date.getUTCHours() * 60 + date.getUTCMinutes();
  const start = toMinutes(quietHours.start);
  const end = toMinutes(quietHours.end);
  if (start === end) return false; // degenerate window suppresses nothing
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function startOfUtcDayIso(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

function parseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    trigger: { kind: row.trigger_kind, at: row.trigger_at },
    capabilities: JSON.parse(row.capabilities),
    quietHours: row.quiet_hours ? JSON.parse(row.quiet_hours) : null,
    expiresAt: row.expires_at,
    maxPerDay: row.max_per_day,
    createdAt: row.created_at,
    revoked: row.revoked === 1,
    killSwitch: row.kill_switch === 1,
  };
}

export class Automations {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_at TEXT,
        capabilities TEXT NOT NULL,
        quiet_hours TEXT,
        expires_at TEXT,
        max_per_day INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        kill_switch INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_automations_owner ON automations(owner);
      CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(trigger_kind);
      CREATE TABLE IF NOT EXISTS automation_fires (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id TEXT NOT NULL REFERENCES automations(id),
        fired_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_fires_automation ON automation_fires(automation_id);
    `);
  }

  create({ owner, trigger, capabilities, quietHours, expiresAt, maxPerDay }) {
    const cleanOwner = requireOwner(owner);
    const cleanTrigger = requireTrigger(trigger);
    const cleanCapabilities = requireCapabilities(capabilities);
    const cleanQuietHours = requireQuietHours(quietHours);
    const cleanExpiresAt = requireExpiresAt(expiresAt);
    const cleanMaxPerDay = requireMaxPerDay(maxPerDay);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO automations
           (id, owner, trigger_kind, trigger_at, capabilities, quiet_hours,
            expires_at, max_per_day, created_at, revoked, kill_switch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
      )
      .run(
        id,
        cleanOwner,
        cleanTrigger.kind,
        cleanTrigger.at,
        JSON.stringify(cleanCapabilities),
        cleanQuietHours ? JSON.stringify(cleanQuietHours) : null,
        cleanExpiresAt,
        cleanMaxPerDay,
        now,
      );
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM automations WHERE id=?').get(id);
    return parseRow(row);
  }

  list(owner = null) {
    const rows = owner === null
      ? this.db.prepare('SELECT * FROM automations ORDER BY created_at ASC').all()
      : this.db.prepare('SELECT * FROM automations WHERE owner=? ORDER BY created_at ASC').all(owner);
    return rows.map(parseRow);
  }

  firesToday(id, now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);
    return this.db
      .prepare('SELECT COUNT(*) AS n FROM automation_fires WHERE automation_id=? AND fired_at >= ?')
      .get(id, startOfUtcDayIso(date)).n;
  }

  // Read-only: returns due automations for a trigger without executing anything.
  // `trigger` is a kind string ('schedule') or { kind }. `opts.now` (ISO/Date)
  // pins the clock for expiry, schedule time, quiet hours, and frequency cap.
  fire(trigger, opts = {}) {
    const kind = typeof trigger === 'string' ? trigger : trigger?.kind;
    if (!TRIGGER_SET.has(kind)) throw new TypeError(`invalid trigger kind: ${String(kind)}`);
    const now = opts.now === undefined ? new Date() : new Date(opts.now);
    if (Number.isNaN(now.getTime())) throw new TypeError('invalid now timestamp');
    const nowIso = now.toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM automations
         WHERE revoked = 0 AND kill_switch = 1 AND trigger_kind = ?
           AND (expires_at IS NULL OR expires_at > ?)
           AND (trigger_kind != 'schedule' OR (trigger_at IS NOT NULL AND trigger_at <= ?))
         ORDER BY created_at ASC`,
      )
      .all(kind, nowIso, nowIso);
    return rows
      .map(parseRow)
      .filter((automation) => !inQuietHours(automation.quietHours, now))
      .filter((automation) => this.firesToday(automation.id, now) < automation.maxPerDay);
  }

  // Records that a due automation was handed off for (approval-gated) handling.
  // Executes nothing itself; throws if the automation is not currently due.
  dispatch(id, opts = {}) {
    const automation = this.get(id);
    if (!automation) throw new Error('automation not found');
    if (automation.revoked) throw new Error('automation revoked');
    const now = opts.now === undefined ? new Date() : new Date(opts.now);
    if (Number.isNaN(now.getTime())) throw new TypeError('invalid now timestamp');
    if (automation.expiresAt && automation.expiresAt <= now.toISOString()) {
      throw new Error('automation expired');
    }
    if (inQuietHours(automation.quietHours, now)) throw new Error('automation in quiet hours');
    if (this.firesToday(id, now) >= automation.maxPerDay) throw new Error('frequency cap reached');
    this.db
      .prepare('INSERT INTO automation_fires (automation_id, fired_at) VALUES (?, ?)')
      .run(id, now.toISOString());
    return { ...automation, firedAt: now.toISOString() };
  }

  // Revokes one automation by id, or every automation of an owner.
  // Accepts a bare string (id wins, else treated as owner) or { id } / { owner }.
  kill(target) {
    const selector = typeof target === 'string' ? { value: target } : target ?? {};
    if (selector.id) {
      const updated = this.db
        .prepare('UPDATE automations SET revoked=1 WHERE id=? AND revoked=0')
        .run(selector.id);
      return { revoked: Number(updated.changes), ids: updated.changes === 1 ? [selector.id] : [] };
    }
    const owner = selector.owner ?? selector.value;
    requireOwner(owner);
    if (this.get(owner)) {
      const updated = this.db
        .prepare('UPDATE automations SET revoked=1 WHERE id=? AND revoked=0')
        .run(owner);
      return { revoked: Number(updated.changes), ids: updated.changes === 1 ? [owner] : [] };
    }
    const rows = this.db
      .prepare('SELECT id FROM automations WHERE owner=? AND revoked=0')
      .all(owner);
    this.db.prepare('UPDATE automations SET revoked=1 WHERE owner=? AND revoked=0').run(owner);
    return { revoked: rows.length, ids: rows.map((row) => row.id) };
  }

  // Global kill switch: revokes every live automation at once.
  killAll() {
    const updated = this.db
      .prepare('UPDATE automations SET revoked=1 WHERE revoked=0')
      .run();
    return { revoked: Number(updated.changes) };
  }
}
