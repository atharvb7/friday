// Principals: the local OWNER token (file on disk) and per-device tokens
// (phone, ESP32, laptop node). Device tokens are stored hashed, shown once,
// scoped, and revocable. TOTP gates consequential actions from devices.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { generateSecret, verifyTotp, otpauthUri } from './totp.mjs';

export const SCOPES = Object.freeze(['read', 'chat', 'tasks', 'approve', 'node', 'guest', 'admin']);
const sha = (s) => createHash('sha256').update(s).digest('hex');

export class Auth {
  constructor(store, ownerToken) {
    this.db = store.db;
    this.owner = Buffer.from(ownerToken);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, name TEXT,
        scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT, ip TEXT, user_agent TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_totp (
        id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, last_step INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  authenticate(token) {
    if (!token) return null;
    const b = Buffer.from(token);
    if (b.length === this.owner.length && timingSafeEqual(b, this.owner)) return { kind: 'owner', id: 'owner', scopes: [...SCOPES] };
    if (token.startsWith('fws_')) return this.#session(token);
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(sha(token));
    if (!row) return null;
    this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(new Date().toISOString(), row.id);
    return { kind: 'device', id: row.id, name: row.name, scopes: JSON.parse(row.scopes) };
  }

  // Web sessions: what a browser gets after signing in over the public internet with token + authenticator code.
  // Never carry admin or node scope (those stay on the private Tailscale address), expire, and can be revoked.
  createSession(principal, { ip = null, userAgent = null, days = 30 } = {}) {
    const token = `fws_${randomBytes(32).toString('hex')}`; const id = randomUUID(); const now = Date.now();
    const scopes = principal.scopes.filter((s) => s !== 'admin' && s !== 'node');
    this.db.prepare('INSERT INTO web_sessions (id, token_hash, principal_kind, principal_id, name, scopes, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, sha(token), principal.kind, principal.id, principal.name ?? null, JSON.stringify(scopes), new Date(now).toISOString(), new Date(now + days * 86_400_000).toISOString(), ip, String(userAgent ?? '').slice(0, 160) || null);
    return { id, token, expires_at: new Date(now + days * 86_400_000).toISOString() };
  }
  #session(token) {
    const row = this.db.prepare('SELECT * FROM web_sessions WHERE token_hash=? AND revoked_at IS NULL').get(sha(token));
    if (!row || row.expires_at < new Date().toISOString()) return null;
    if (row.principal_kind === 'device' && !this.db.prepare('SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL').get(row.principal_id)) return null; // device revoked -> its sessions die
    if (row.principal_kind === 'member' && !this.memberActive?.(row.principal_id)) return null; // disabled/rejected member -> sessions die
    this.db.prepare('UPDATE web_sessions SET last_seen_at=? WHERE id=?').run(new Date().toISOString(), row.id);
    return { kind: 'session', id: `session:${row.id}`, sessionOf: row.principal_kind, ...(row.principal_kind === 'member' ? { userId: row.principal_id } : {}), name: row.name ?? (row.principal_kind === 'owner' ? 'owner' : null), scopes: JSON.parse(row.scopes) };
  }
  listSessions() { return this.db.prepare("SELECT id, principal_kind, name, created_at, expires_at, last_seen_at, ip, user_agent FROM web_sessions WHERE revoked_at IS NULL AND expires_at > ? AND principal_kind != 'member' ORDER BY last_seen_at DESC NULLS LAST, created_at DESC").all(new Date().toISOString()); }
  revokeMemberSessions(userId) { return this.db.prepare("UPDATE web_sessions SET revoked_at=? WHERE principal_kind='member' AND principal_id=? AND revoked_at IS NULL").run(new Date().toISOString(), userId).changes; }
  revokeSession(id) { return this.db.prepare('UPDATE web_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes > 0; }

  createDevice({ name, scopes = ['read', 'chat', 'tasks'] }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new TypeError('invalid device name');
    if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => SCOPES.includes(s) && s !== 'admin')) throw new TypeError('invalid scopes'); // admin is owner-only
    if (scopes.includes('guest') && scopes.length > 1) throw new TypeError('guest devices can only have the guest scope');
    const token = `fdv_${randomBytes(32).toString('hex')}`;
    const id = randomUUID();
    this.db.prepare('INSERT INTO devices (id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), sha(token), JSON.stringify([...new Set(scopes)]), new Date().toISOString());
    return { id, name: name.trim(), scopes, token };
  }

  listDevices() {
    return this.db.prepare('SELECT id, name, scopes, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at DESC').all().map((r) => ({ ...r, scopes: JSON.parse(r.scopes) }));
  }

  revokeDevice(id) { return this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes > 0; }

  // TOTP enrolment: secret is shown once; becomes active after a valid code.
  enrollTotp(account = 'owner') {
    if (this.totpActive()) throw new Error('totp_already_active');
    const secret = generateSecret();
    this.db.prepare('INSERT INTO auth_totp (id, secret, confirmed, last_step) VALUES (1, ?, 0, 0) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, confirmed=0, last_step=0').run(secret);
    return { secret, uri: otpauthUri(secret, account) };
  }

  confirmTotp(code) {
    const row = this.db.prepare('SELECT * FROM auth_totp WHERE id=1').get();
    if (!row) throw new Error('totp_not_enrolled');
    const step = verifyTotp(row.secret, code);
    if (step === null) return false;
    this.db.prepare('UPDATE auth_totp SET confirmed=1, last_step=? WHERE id=1').run(step);
    return true;
  }

  totpActive() { return this.db.prepare('SELECT confirmed FROM auth_totp WHERE id=1').get()?.confirmed === 1; }

  // Brute-force defence: 5 wrong codes in 10 minutes locks TOTP checks for 15 minutes (any device).
  #fails = []; #lockedUntil = 0;
  // Single-use per time step: a replayed code is rejected.
  checkTotp(code) {
    const now = Date.now();
    if (now < this.#lockedUntil) return false;
    const ok = this.#checkTotp(code);
    if (!ok) { this.#fails = this.#fails.filter((t) => now - t < 600_000); this.#fails.push(now); if (this.#fails.length >= 5) { this.#lockedUntil = now + 900_000; this.#fails = []; } }
    else this.#fails = [];
    return ok;
  }
  get totpLocked() { return Date.now() < this.#lockedUntil; }
  #checkTotp(code) {
    const row = this.db.prepare('SELECT * FROM auth_totp WHERE id=1 AND confirmed=1').get();
    if (!row) return false;
    const step = verifyTotp(row.secret, code);
    if (step === null || step <= row.last_step) return false;
    this.db.prepare('UPDATE auth_totp SET last_step=? WHERE id=1').run(step);
    return true;
  }
}

// Which scope a request needs. Emergency stop is deliberately open to every
// authenticated device: stopping must never be the hard part.
export function requiredScope(method, pathname) {
  if (pathname.startsWith('/v1/node/')) return 'node';
  if (pathname === '/v1/emergency-stop') return 'read';
  if (pathname === '/v1/auth/whoami') return 'read';
  if (/^\/v1\/(devices|sessions|auth|backup|mcp|users)/.test(pathname) || pathname === '/v1/skills/install') return 'admin';
  if (pathname === '/v1/emergency-clear') return 'approve';
  if (/^\/v1\/effects\/[^/]+\/approve$/.test(pathname) || /^\/v1\/approvals\/[^/]+\/decide$/.test(pathname) || (method !== 'GET' && pathname === '/v1/autonomy')) return 'approve';
  if (pathname === '/v1/companion/events') return 'read';
  if (/^\/v1\/(learned|watches)/.test(pathname) && method !== 'GET') return 'tasks';
  if (/^\/v1\/apps\/[a-z]+\/connect$/.test(pathname) || /^\/v1\/google\/(connect|disconnect)$/.test(pathname)) return 'admin'; // linking an account is an owner-only act
  if (pathname.startsWith('/v1/files')) return method === 'GET' ? 'read' : 'chat';
  if (pathname.startsWith('/v1/voice/') || pathname.startsWith('/v1/profile') || pathname.startsWith('/v1/questions')) return method === 'GET' ? 'read' : 'chat';
  if (pathname === '/v1/chat' || pathname.startsWith('/v1/chat/') || pathname.startsWith('/v1/memory')) return method === 'GET' ? 'read' : 'chat';
  return method === 'GET' ? 'read' : 'tasks';
}

// Actions a device must back with a fresh TOTP code once TOTP is active.
export function needsTotp(pathname) {
  return requiredScope('POST', pathname) === 'approve' || pathname === '/v1/emergency-clear';
}
