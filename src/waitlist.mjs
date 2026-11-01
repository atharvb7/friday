// The public waitlist for the landing page (fridayy.site). Anyone may leave an email; nothing else is stored
// (no IP, no user agent). Joining twice is not an error and does not say whether the email was already there,
// so the endpoint cannot be used to check who signed up. The owner sees the list on the private address and
// gets a notification per new signup (capped per day so a flood cannot bury the inbox).
import { randomUUID } from 'node:crypto';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const SOURCES = new Set(['hero', 'final', 'other']);
export const DAILY_CAP = 1000;      // new signups accepted per day (a flood stops here, the list stays usable)
export const NOTIFY_PER_DAY = 25;   // owner notifications per day; the rest are counted in the list

export class Waitlist {
  constructor({ store, notifications = null, now = () => Date.now() }) {
    Object.assign(this, { notifications, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'other', created_at TEXT NOT NULL)`);
  }

  static normalize(email) { return String(email ?? '').trim().toLowerCase(); }
  static valid(email) { const e = Waitlist.normalize(email); return e.length <= 254 && EMAIL_RE.test(e); }

  #today() { return new Date(this.now()).toISOString().slice(0, 10); }
  #countSince(day) { return this.db.prepare('SELECT COUNT(*) n FROM waitlist WHERE created_at >= ?').get(`${day}T00:00:00.000Z`).n; }

  // -> { joined: true } for a new email, { joined: false } when it was already on the list.
  join({ email, source = 'other' }) {
    const e = Waitlist.normalize(email);
    if (!Waitlist.valid(e)) throw new TypeError('valid email required');
    if (this.db.prepare('SELECT 1 FROM waitlist WHERE email=?').get(e)) return { joined: false };
    const today = this.#today();
    const n = this.#countSince(today);
    if (n >= DAILY_CAP) throw new RangeError('waitlist is busy');
    const src = SOURCES.has(source) ? source : 'other';
    this.db.prepare('INSERT INTO waitlist (id,email,source,created_at) VALUES (?,?,?,?)').run(randomUUID(), e, src, new Date(this.now()).toISOString());
    if (n < NOTIFY_PER_DAY) this.notifications?.create({ level: 'success', title: `New waitlist signup: ${e}`, body: `From the ${src} form. ${this.count()} on the list.` });
    return { joined: true };
  }

  list() { return this.db.prepare('SELECT email, source, created_at FROM waitlist ORDER BY created_at DESC').all(); }
  count() { return this.db.prepare('SELECT COUNT(*) n FROM waitlist').get().n; }
  remove(email) { return this.db.prepare('DELETE FROM waitlist WHERE email=?').run(Waitlist.normalize(email)).changes > 0; }
}
