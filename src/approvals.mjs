// Human-in-the-loop approvals for actions the policy says need a yes.
// The approval binds the EXACT payload that was shown; approving runs that
// stored payload (never anything re-supplied later), once.
import { createHash, randomUUID } from 'node:crypto';

const TTL_MS = 24 * 3600_000;
const REPEAT_WINDOW_MS = 7 * 24 * 3600_000;
const hashOf = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');
// Direction overrides/isolates and Unicode tag characters can make a card read differently from what runs
// (or hide text from the reader). Not ZWJ/ZWNJ: emoji and Indic scripts need those.
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export class Approvals {
  #executors = new Map();
  constructor({ store, notifications, chat, bus, audit = null, now = () => Date.now() }) {
    Object.assign(this, { notifications, chat, bus, audit, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, risk TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL,
      payload TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, conversation_id TEXT, result TEXT
    )`);
    const cols = new Set(this.db.prepare('PRAGMA table_info(approvals)').all().map((c) => c.name));
    if (!cols.has('repeat_of')) this.db.exec('ALTER TABLE approvals ADD COLUMN repeat_of TEXT');
    if (!cols.has('note')) this.db.exec('ALTER TABLE approvals ADD COLUMN note TEXT');
    this.#closeInterrupted();
  }

  // An approved action whose result never got written was cut off by a restart (nothing runs across one).
  // It may or may not have happened, so it is marked unknown and the conversation is told, never re-run.
  #closeInterrupted() {
    const rows = this.db.prepare("SELECT id, summary, conversation_id, decided_at FROM approvals WHERE status='approved' AND result IS NULL").all();
    const recent = new Date(this.now() - 24 * 3600_000).toISOString();
    for (const r of rows) {
      this.db.prepare('UPDATE approvals SET result=? WHERE id=? AND result IS NULL').run(JSON.stringify({ error: 'interrupted', unknown: true }), r.id);
      if (!(r.decided_at >= recent)) continue; // old history: recorded, not announced
      const text = `⚠️ Fridayy restarted while doing “${r.summary}” after your approval. I can't tell whether it finished, so check before asking me to do it again.`;
      try { if (r.conversation_id && this.chat?.getConversation(r.conversation_id)) this.chat.addMessage(r.conversation_id, 'assistant', text); } catch {}
      try { this.notifications?.create({ level: 'warning', title: `Unknown result: ${String(r.summary).slice(0, 120)}`, body: text, conversationId: r.conversation_id }); } catch {}
      try { this.audit?.append(r.conversation_id ?? 'ad-hoc-local', 'approval.interrupted', { id: r.id }); } catch {}
    }
  }

  register(tool, fn) { this.#executors.set(tool, fn); }

  request({ category, risk, tool, summary, payload, conversationId = null }) {
    if (INVISIBLE.test(JSON.stringify(payload) ?? '') || INVISIBLE.test(String(summary))) {
      throw new TypeError('invisible_characters: the action contains hidden text-direction or tag characters, so the approval card could not show what would run. Remove them and try again.');
    }
    const id = randomUUID();
    const now = this.now();
    const hash = hashOf(payload);
    // The same exact action already approved and run recently: still asked, but the card says so.
    const prior = this.db.prepare(`SELECT id, decided_at FROM approvals WHERE tool=? AND payload_hash=? AND status='approved' AND decided_at >= ?
      AND (result IS NULL OR result NOT LIKE '{"error"%') ORDER BY decided_at DESC LIMIT 1`).get(tool, hash, new Date(now - REPEAT_WINDOW_MS).toISOString());
    this.db.prepare('INSERT INTO approvals (id, category, risk, tool, summary, payload, payload_hash, created_at, expires_at, conversation_id, repeat_of) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, category, risk, tool, String(summary).slice(0, 500), JSON.stringify(payload), hash, new Date(now).toISOString(), new Date(now + TTL_MS).toISOString(), conversationId, prior?.id ?? null);
    const repeat = prior ? `Same as the one you approved ${day(prior.decided_at)}, which already ran. ` : '';
    this.notifications.create({ level: 'warning', title: `Approval needed${prior ? ' (repeat)' : ''}: ${String(summary).slice(0, 120)}`, body: `${repeat}${category} / ${risk}`, conversationId });
    this.bus?.publish('approval.requested', { id, category, risk, tool });
    try { this.audit?.append(conversationId ?? 'ad-hoc-local', 'approval.requested', { id, tool, category, risk }); } catch {}
    return this.get(id);
  }

  // Resolves true/false once the approval is decided (false on timeout/expiry); rejects on abort.
  waitFor(id, signal, timeoutMs = TTL_MS) {
    return new Promise((resolve, reject) => {
      const done = (v) => { clearTimeout(timer); off(); signal?.removeEventListener('abort', onAbort); resolve(v); };
      const off = this.bus.subscribe((e) => { if (e.data?.id !== id) return; if (e.type === 'approval.approved') done(true); else if (e.type === 'approval.denied') done(false); });
      const timer = setTimeout(() => done(false), timeoutMs);
      const onAbort = () => { clearTimeout(timer); off(); reject(signal.reason ?? new Error('aborted')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cur = this.get(id); if (cur && cur.status !== 'pending') done(cur.status === 'approved');
    });
  }

  get(id) { const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id); return r ? this.#row(r) : null; }

  list(status = 'pending') {
    this.#expire();
    return this.db.prepare('SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC LIMIT 50').all(status).map((r) => this.#row(r));
  }

  #row(r) {
    const prior = r.repeat_of ? this.db.prepare('SELECT decided_at FROM approvals WHERE id=?').get(r.repeat_of) : null;
    return { ...r, payload: JSON.parse(r.payload), repeat: prior ? { id: r.repeat_of, approved_at: prior.decided_at } : null };
  }

  #expire() { this.db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at < ?").run(new Date(this.now()).toISOString()); }

  // note: the owner's words with the decision (why it was denied, or what to keep in mind); never changes what runs.
  async decide(id, approve, by = 'owner', note = '') {
    note = String(note ?? '').trim().slice(0, 500);
    this.#expire();
    const a = this.get(id);
    if (!a) throw new Error('not_found');
    if (a.status !== 'pending') throw new Error(`already_${a.status}`);
    if (hashOf(a.payload) !== a.payload_hash) throw new Error('payload_tampered');
    // Claim atomically so a double-tap can never execute twice.
    const claimed = this.db.prepare("UPDATE approvals SET status=?, decided_at=?, decided_by=?, note=? WHERE id=? AND status='pending'").run(approve ? 'approved' : 'denied', new Date(this.now()).toISOString(), by, note || null, id).changes === 1;
    if (!claimed) throw new Error('already_decided');
    this.bus?.publish(approve ? 'approval.approved' : 'approval.denied', { id, note: note || null });
    try { this.audit?.append(a.conversation_id ?? 'ad-hoc-local', approve ? 'approval.approved' : 'approval.denied', { id, tool: a.tool, by, ...(note ? { note } : {}) }); } catch {}
    const inChat = a.conversation_id && this.chat.getConversation(a.conversation_id);
    if (!approve) {
      // Said in the conversation so the next turn knows why, instead of trying the same thing again.
      if (inChat && note) this.chat.addMessage(a.conversation_id, 'assistant', `🚫 You declined “${a.summary}”: ${note}`);
      return this.get(id);
    }
    const exec = this.#executors.get(a.tool);
    let result;
    try { result = exec ? await exec(a.payload, { approvalId: id, conversationId: a.conversation_id }) : { error: 'no_executor' }; }
    catch (error) { result = { error: String(error.message).slice(0, 300) }; }
    this.db.prepare('UPDATE approvals SET result=? WHERE id=?').run(JSON.stringify(result).slice(0, 4000), id);
    if (inChat) {
      const said = note ? `\n\nYour note: ${note}` : '';
      this.chat.addMessage(a.conversation_id, 'assistant', (result?.error ? `❌ I tried “${a.summary}” after your approval but it failed: ${result.explain ?? result.error}${result.fallback ? `\n\n${result.explain ? 'What I can do instead: ' : ''}${String(result.fallback).replace(/^Offer to /, '')}` : ''}` : (typeof result?.message === 'string' ? `✅ ${result.message}` : `✅ Done after your approval: ${a.summary}`)) + said);
    }
    return this.get(id);
  }
}
