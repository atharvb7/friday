// Other people's accounts (the owner is not in here). Anyone can ask for an account on the public site — with Google
// or email + password — and it stays 'pending' until the owner approves it from the Inbox. Approved members get
// their own, separate chats with Friday and NO access to the owner's laptop, mail, Instagram, memory, tasks or
// settings. (Role-based permissions come later; for now there is a single 'member' role.)
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const norm = (e) => String(e ?? '').trim().toLowerCase();
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MAX_PENDING = 30;

export class Users {
  constructor({ store, approvals = null, bus = null, now = () => Date.now() }) {
    Object.assign(this, { approvals, bus, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, provider TEXT NOT NULL, salt TEXT, hash TEXT,
      role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending', approval_id TEXT,
      created_at TEXT NOT NULL, decided_at TEXT, last_login_at TEXT, day TEXT, day_count INTEGER NOT NULL DEFAULT 0)`);
    // The owner decides in the Inbox; approving runs this, denying marks the request rejected.
    approvals?.register('user_approve', async (payload) => { const ok = this.setStatus(payload.userId, 'approved'); return ok ? { approved: payload.email } : { error: 'user not found' }; });
    bus?.subscribe((e) => {
      if (e.type !== 'approval.denied') return;
      const a = approvals?.get(e.data?.id);
      if (a?.tool === 'user_approve') this.setStatus(a.payload.userId, 'rejected');
    });
  }

  get(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) ?? null; }
  byEmail(email) { return this.db.prepare('SELECT * FROM users WHERE email=?').get(norm(email)) ?? null; }
  list() { return this.db.prepare('SELECT id, email, name, provider, role, status, created_at, decided_at, last_login_at FROM users ORDER BY created_at DESC').all(); }
  public(u) { return u ? { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status } : null; }

  #request(u, via) {
    if (!this.approvals) return;
    const a = this.approvals.request({ category: 'system', risk: 'consequential', tool: 'user_approve', summary: `New Friday account request: ${u.name} <${u.email}> (via ${via})`, payload: { userId: u.id, email: u.email } });
    this.db.prepare('UPDATE users SET approval_id=? WHERE id=?').run(a.id, u.id);
  }
  #pendingCount() { return this.db.prepare("SELECT COUNT(*) n FROM users WHERE status='pending'").get().n; }

  signupPassword({ name, email, password }) {
    const e = norm(email); const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!n) throw new TypeError('name required');
    if (!EMAIL_RE.test(e)) throw new TypeError('valid email required');
    const p = String(password ?? '');
    if (p.length < 10 || p.length > 200) throw new TypeError('password must be 10-200 characters');
    if (this.byEmail(e)) throw new TypeError('an account with this email already exists');
    if (this.#pendingCount() >= MAX_PENDING) throw new TypeError('too many pending requests right now — try again later');
    const salt = randomBytes(16);
    const u = { id: randomUUID(), email: e, name: n, provider: 'password', salt: salt.toString('base64'), hash: scryptSync(p, salt, 64, SCRYPT).toString('base64') };
    this.db.prepare('INSERT INTO users (id,email,name,provider,salt,hash,created_at) VALUES (?,?,?,?,?,?,?)').run(u.id, u.email, u.name, u.provider, u.salt, u.hash, new Date(this.now()).toISOString());
    this.#request(u, 'email');
    return this.public(this.get(u.id));
  }

  // Google sign-in by a non-owner: returns the existing account, or creates a pending one (and asks the owner).
  fromGoogle({ email, name }) {
    const e = norm(email);
    const existing = this.byEmail(e);
    if (existing) return existing;
    if (this.#pendingCount() >= MAX_PENDING) throw new TypeError('too many pending requests right now — try again later');
    const u = { id: randomUUID(), email: e, name: String(name ?? e.split('@')[0]).slice(0, 60) };
    this.db.prepare("INSERT INTO users (id,email,name,provider,created_at) VALUES (?,?,?,'google',?)").run(u.id, u.email, u.name, new Date(this.now()).toISOString());
    this.#request(u, 'Google');
    return this.get(u.id);
  }

  // Constant cost whether or not the email exists.
  checkPassword(email, password) {
    const u = this.byEmail(email);
    const salt = u?.salt ? Buffer.from(u.salt, 'base64') : randomBytes(16);
    const got = scryptSync(String(password ?? ''), salt, 64, SCRYPT);
    const want = u?.hash ? Buffer.from(u.hash, 'base64') : randomBytes(64);
    return u?.hash && timingSafeEqual(got, want) ? u : null;
  }

  setStatus(id, status) {
    if (!['pending', 'approved', 'rejected', 'disabled'].includes(status)) throw new TypeError('bad status');
    const ok = this.db.prepare('UPDATE users SET status=?, decided_at=? WHERE id=?').run(status, new Date(this.now()).toISOString(), id).changes > 0;
    if (ok) this.bus?.publish('user.status', { id, status });
    return ok;
  }
  touchLogin(id) { this.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(new Date(this.now()).toISOString(), id); }

  // Daily message allowance per member (protects the owner's model quota).
  takeMessage(id, limit = 80) {
    const day = new Date(this.now()).toISOString().slice(0, 10); const u = this.get(id);
    if (!u) return false;
    const count = u.day === day ? u.day_count : 0;
    if (count >= limit) return false;
    this.db.prepare('UPDATE users SET day=?, day_count=? WHERE id=?').run(day, count + 1, id);
    return true;
  }
}
