// The public waitlist for the landing page (fridayy.site). Anyone may leave an email; nothing else is stored
// (no IP, no user agent). Joining twice is not an error and does not say whether the email was already there,
// so the endpoint cannot be used to check who signed up. The owner sees the list on the private address and
// gets a notification per new signup (capped per day so a flood cannot bury the inbox).
//
// Optional Google Sheet mirror: the owner's own sheet carries a tiny Apps Script web app (docs: WAITLIST_SHEET_SCRIPT)
// that only appends rows. Friday posts new signups to it with a shared secret. Every row remembers whether it reached
// the sheet, so a failed post is retried later and signups from before the sheet existed are backfilled.
import { randomUUID } from 'node:crypto';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const SOURCES = new Set(['hero', 'final', 'other']);
const SHEET_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const DAILY_CAP = 1000;      // new signups accepted per day (a flood stops here, the list stays usable)
export const NOTIFY_PER_DAY = 25;   // owner notifications per day; the rest are counted in the list
export const SHEET_BATCH = 200;     // rows per post to the sheet

export class Waitlist {
  constructor({ store, notifications = null, settings = null, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { notifications, settings, fetchImpl, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'other', created_at TEXT NOT NULL)`);
    if (!this.db.prepare('PRAGMA table_info(waitlist)').all().some((c) => c.name === 'sheet_synced_at')) this.db.exec('ALTER TABLE waitlist ADD COLUMN sheet_synced_at TEXT');
    this.syncing = null;
    this.lastSync = null; // { at, ok, added?, error? }
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
    this.syncSheet().catch(() => {}); // best effort now; the periodic sync retries anything that did not land
    return { joined: true };
  }

  list() { return this.db.prepare('SELECT email, source, created_at, sheet_synced_at FROM waitlist ORDER BY created_at DESC').all(); }
  count() { return this.db.prepare('SELECT COUNT(*) n FROM waitlist').get().n; }
  remove(email) { return this.db.prepare('DELETE FROM waitlist WHERE email=?').run(Waitlist.normalize(email)).changes > 0; }

  // ---- Google Sheet mirror ----
  sheetConfig() { const c = this.settings?.get('waitlist_sheet', null); return c?.url && c?.secret ? c : null; }
  setSheet({ url, secret }) {
    const u = String(url ?? '').trim(), s = String(secret ?? '').trim();
    if (!SHEET_URL_RE.test(u)) throw new TypeError('url must be the Apps Script web app address: https://script.google.com/macros/s/<id>/exec');
    if (s.length < 24 || s.length > 200) throw new TypeError('secret must be 24-200 characters');
    this.settings.set('waitlist_sheet', { url: u, secret: s });
    return this.sheetStatus();
  }
  clearSheet() { this.settings.set('waitlist_sheet', null); return this.sheetStatus(); }
  sheetStatus() {
    const c = this.sheetConfig();
    const pending = this.db.prepare('SELECT COUNT(*) n FROM waitlist WHERE sheet_synced_at IS NULL').get().n;
    return { configured: Boolean(c), url: c?.url ?? null, pending, last: this.lastSync };
  }

  // Posts every not-yet-synced row (oldest first, in batches). One run at a time; returns rows the sheet accepted.
  syncSheet() {
    if (this.syncing) return this.syncing;
    this.syncing = this.#sync().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async #sync() {
    const c = this.sheetConfig();
    if (!c) return 0;
    let total = 0;
    try {
      for (;;) {
        const rows = this.db.prepare('SELECT id, email, source, created_at FROM waitlist WHERE sheet_synced_at IS NULL ORDER BY created_at LIMIT ?').all(SHEET_BATCH);
        if (!rows.length) break;
        const r = await this.fetchImpl(c.url, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ secret: c.secret, rows: rows.map(({ email, source, created_at }) => ({ email, source, created_at })) }),
        });
        let j = null; try { j = await r.json(); } catch { /* Apps Script answers HTML when the deployment is wrong */ }
        if (!r.ok || !j?.ok) throw new Error(j?.error ? `sheet said: ${j.error}` : `sheet answered HTTP ${r.status}${j ? '' : ' (not the waitlist script? check the web app address and that it runs as you, for anyone)'}`);
        const at = new Date(this.now()).toISOString();
        const mark = this.db.prepare('UPDATE waitlist SET sheet_synced_at=? WHERE id=?');
        for (const row of rows) mark.run(at, row.id);
        total += rows.length;
        if (rows.length < SHEET_BATCH) break;
      }
      this.lastSync = { at: new Date(this.now()).toISOString(), ok: true, added: total };
    } catch (e) {
      this.lastSync = { at: new Date(this.now()).toISOString(), ok: false, error: String(e.message ?? e).slice(0, 300), added: total };
    }
    return total;
  }
}

// What the owner pastes into the sheet (Extensions -> Apps Script). Appends only; skips emails already in column B.
export const WAITLIST_SHEET_SCRIPT = `const SECRET = 'PASTE_THE_SECRET_HERE';

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.secret !== SECRET) return reply({ ok: false, error: 'forbidden' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Joined', 'Email', 'Form']);
      sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    const n = sheet.getLastRow() - 1;
    const seen = new Set(n > 0 ? sheet.getRange(2, 2, n, 1).getValues().map((r) => String(r[0]).toLowerCase()) : []);
    const tz = Session.getScriptTimeZone();
    let added = 0;
    (body.rows || []).forEach((r) => {
      if (seen.has(r.email)) return;
      sheet.appendRow([Utilities.formatDate(new Date(r.created_at), tz, 'yyyy-MM-dd HH:mm'), r.email, r.source]);
      seen.add(r.email);
      added++;
    });
    return reply({ ok: true, added: added });
  } finally {
    lock.releaseLock();
  }
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
