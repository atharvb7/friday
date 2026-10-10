// Human-in-the-loop approvals for actions the policy says need a yes.
// The approval binds the EXACT payload that was shown; approving runs that
// stored payload (never anything re-supplied later), once.
import { createHash, randomUUID } from 'node:crypto';

const TTL_MS = 24 * 3600_000;
const hashOf = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

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
  }

  register(tool, fn) { this.#executors.set(tool, fn); }

  request({ category, risk, tool, summary, payload, conversationId = null }) {
    const id = randomUUID();
    const now = this.now();
    this.db.prepare('INSERT INTO approvals (id, category, risk, tool, summary, payload, payload_hash, created_at, expires_at, conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, category, risk, tool, String(summary).slice(0, 500), JSON.stringify(payload), hashOf(payload), new Date(now).toISOString(), new Date(now + TTL_MS).toISOString(), conversationId);
    this.notifications.create({ level: 'warning', title: `Approval needed: ${String(summary).slice(0, 120)}`, body: `${category} / ${risk}`, conversationId });
    this.bus?.publish('approval.requested', { id, category, risk, tool });
    try { this.audit?.append(conversationId ?? 'ad-hoc-local', 'approval.requested', { id, tool, category, risk }); } catch {}
    return this.get(id);
  }

  get(id) { const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id); return r ? { ...r, payload: JSON.parse(r.payload) } : null; }

  list(status = 'pending') {
    this.#expire();
    return this.db.prepare('SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC LIMIT 50').all(status).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  #expire() { this.db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at < ?").run(new Date(this.now()).toISOString()); }

  async decide(id, approve, by = 'owner') {
    this.#expire();
    const a = this.get(id);
    if (!a) throw new Error('not_found');
    if (a.status !== 'pending') throw new Error(`already_${a.status}`);
    if (hashOf(a.payload) !== a.payload_hash) throw new Error('payload_tampered');
    // Claim atomically so a double-tap can never execute twice.
    const claimed = this.db.prepare("UPDATE approvals SET status=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'").run(approve ? 'approved' : 'denied', new Date(this.now()).toISOString(), by, id).changes === 1;
    if (!claimed) throw new Error('already_decided');
    this.bus?.publish(approve ? 'approval.approved' : 'approval.denied', { id });
    try { this.audit?.append(a.conversation_id ?? 'ad-hoc-local', approve ? 'approval.approved' : 'approval.denied', { id, tool: a.tool, by }); } catch {}
    if (!approve) return this.get(id);
    const exec = this.#executors.get(a.tool);
    let result;
    try { result = exec ? await exec(a.payload, { approvalId: id, conversationId: a.conversation_id }) : { error: 'no_executor' }; }
    catch (error) { result = { error: String(error.message).slice(0, 300) }; }
    this.db.prepare('UPDATE approvals SET result=? WHERE id=?').run(JSON.stringify(result).slice(0, 4000), id);
    if (a.conversation_id && this.chat.getConversation(a.conversation_id)) {
      this.chat.addMessage(a.conversation_id, 'assistant', result?.error ? `❌ I tried “${a.summary}” after your approval but it failed: ${result.error}` : `✅ Done after your approval: ${a.summary}`);
    }
    return this.get(id);
  }
}
