// src/chat.mjs — Friday conversations (SQLite, WAL, same DB as tasks).
// A conversation is an id + title + timestamps; messages are role/content rows.
// History is returned oldest-first; providers receive a capped window so a
// long chat cannot blow the model context or the response budget.
import { randomUUID } from 'node:crypto';

const MAX_MESSAGE_CHARS = 20000;
const MAX_HISTORY_MESSAGES = 40;
const ROLES = new Set(['user', 'assistant', 'system']);

function assertMessage(role, content) {
  if (!ROLES.has(role)) throw new TypeError('invalid role');
  if (typeof content !== 'string' || !content.trim() || content.length > MAX_MESSAGE_CHARS) {
    throw new TypeError('invalid message content');
  }
}

export class ChatStore {
  constructor(store) {
    if (!store || !store.db) throw new TypeError('store required');
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);
    `);
  }

  createConversation(title = 'New chat') {
    const id = randomUUID();
    const now = new Date().toISOString();
    const clean = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'New chat';
    this.db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, clean, now, now);
    return this.getConversation(id);
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) ?? null;
  }

  listConversations() {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50').all();
  }

  addMessage(conversationId, role, content) {
    const convo = this.getConversation(conversationId);
    if (!convo) throw new Error('conversation_not_found');
    assertMessage(role, content);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(id, conversationId, role, content.trim(), now);
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, conversation_id: conversationId, role, content: content.trim(), created_at: now };
  }

  listMessages(conversationId, limit = MAX_HISTORY_MESSAGES) {
    if (!this.getConversation(conversationId)) throw new Error('conversation_not_found');
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_HISTORY_MESSAGES) : MAX_HISTORY_MESSAGES;
    return this.db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT ?').all(conversationId, cap);
  }

  // Window formatted for a chat-completions provider (oldest-first, capped).
  historyForProvider(conversationId, limit = 20) {
    return this.listMessages(conversationId, limit).map((m) => ({ role: m.role, content: m.content }));
  }
}
