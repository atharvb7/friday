// A background agent can ask the user for something it must not guess (a phone number, which option, ...).
// The task pauses; the question lands in chat + inbox; the user's answer (typed in the inbox or told to Friday in
// chat) resumes it. Answers for profile fields are saved so she never asks twice.
import { randomUUID } from 'node:crypto';

const TTL_MS = 6 * 3600_000;

export class Questions {
  constructor({ store, chat, notifications, bus, profile, now = () => Date.now() }) {
    Object.assign(this, { store, chat, notifications, bus, profile, now });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_questions (
      id TEXT PRIMARY KEY, task_id TEXT, conversation_id TEXT, question TEXT NOT NULL, field TEXT, status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT, created_at TEXT NOT NULL, answered_at TEXT, expires_at TEXT NOT NULL
    )`);
  }

  ask({ taskId = null, question, field = null }) {
    const q = String(question ?? '').trim().slice(0, 400);
    if (!q) throw new TypeError('question required');
    if (field && !['name', 'phone', 'email', 'address'].includes(field)) field = null;
    const task = taskId ? this.store.getTask(taskId) : null;
    const id = randomUUID();
    this.db.prepare('INSERT INTO agent_questions (id, task_id, conversation_id, question, field, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, taskId, task?.conversation_id ?? null, q, field, new Date(this.now()).toISOString(), new Date(this.now() + TTL_MS).toISOString());
    this.notifications.create({ level: 'warning', title: `I need your answer: ${q.slice(0, 100)}`, body: task ? `For: ${task.title}` : '', taskId, conversationId: task?.conversation_id ?? null });
    if (task?.conversation_id && this.chat.getConversation(task.conversation_id)) this.chat.addMessage(task.conversation_id, 'assistant', `❓ ${q}\n\n(Just tell me here, or answer in your Inbox — the task is waiting.)`);
    this.bus.publish('question.asked', { id, taskId, field });
    return this.get(id);
  }

  get(id) { return this.db.prepare('SELECT * FROM agent_questions WHERE id=?').get(id) ?? null; }
  #expire() { this.db.prepare("UPDATE agent_questions SET status='expired' WHERE status='pending' AND expires_at < ?").run(new Date(this.now()).toISOString()); }
  pending() { this.#expire(); return this.db.prepare("SELECT id, task_id, conversation_id, question, field, created_at FROM agent_questions WHERE status='pending' ORDER BY created_at ASC").all(); }
  pendingForConversation(cid) { return this.pending().filter((q) => q.conversation_id === cid); }

  answer(id, text) {
    this.#expire();
    const q = this.get(id);
    if (!q) throw new Error('not_found');
    if (q.status !== 'pending') throw new Error(`already_${q.status}`);
    const a = String(text ?? '').trim();
    if (!a || a.length > 500) throw new TypeError('answer required (<=500 chars)');
    let stored = a;
    if (q.field) stored = this.profile.set(q.field, a); // validates; remembered for next time
    const claimed = this.db.prepare("UPDATE agent_questions SET status='answered', answer=?, answered_at=? WHERE id=? AND status='pending'").run(q.field ? '[saved to profile]' : a, new Date(this.now()).toISOString(), id).changes === 1;
    if (!claimed) throw new Error('already_answered');
    this.bus.publish('question.answered', { id, taskId: q.task_id, field: q.field });
    return { ...this.get(id), value: q.field ? undefined : stored };
  }

  // Resolves with the answer text (or '[saved to profile]'), rejects on timeout/abort.
  wait(id, signal, timeoutMs = TTL_MS) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; } // its abort event already fired
      const done = (fn, v) => { clearTimeout(timer); off(); signal?.removeEventListener('abort', onAbort); fn(v); };
      const off = this.bus.subscribe((e) => { if (e.type === 'question.answered' && e.data.id === id) done(resolve, this.get(id).answer); });
      const timer = setTimeout(() => done(reject, new Error('question_timeout')), timeoutMs);
      const onAbort = () => done(reject, signal.reason ?? new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const cur = this.get(id); if (cur?.status === 'answered') done(resolve, cur.answer);
    });
  }
}
