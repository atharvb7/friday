// src/chat.mjs — Friday conversations (SQLite, WAL, same DB as tasks).
// A conversation is an id + title + timestamps; messages are role/content rows.
// History is returned oldest-first; providers receive a capped window so a
// long chat cannot blow the model context or the response budget.
import { randomUUID } from 'node:crypto';

const MAX_MESSAGE_CHARS = 20000;
const MAX_HISTORY_MESSAGES = 40;
const ROLES = new Set(['user', 'assistant', 'system']);

function assertMessage(role, content, hasAttachments = false) {
  if (!ROLES.has(role)) throw new TypeError('invalid role');
  if (typeof content !== 'string' || (!content.trim() && !hasAttachments) || content.length > MAX_MESSAGE_CHARS) {
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
    // Files attached to a message (JSON array of file ids); added in place for existing databases.
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'attachments')) this.db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
    // Whose conversation: NULL = the owner; otherwise an approved member's id (members only ever see their own).
    if (!this.db.prepare('PRAGMA table_info(conversations)').all().some((c) => c.name === 'user_id')) this.db.exec('ALTER TABLE conversations ADD COLUMN user_id TEXT');
  }

  createConversation(title = 'New chat', userId = null) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const clean = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'New chat';
    this.db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)').run(id, clean, now, now, userId);
    return this.getConversation(id);
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) ?? null;
  }

  listConversations(userId = null) {
    return userId ? this.db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 50').all(userId)
      : this.db.prepare('SELECT * FROM conversations WHERE user_id IS NULL ORDER BY updated_at DESC LIMIT 50').all();
  }
  // Does this conversation belong to that person? (null = owner)
  owns(conversationId, userId = null) { const c = this.getConversation(conversationId); return Boolean(c) && (c.user_id ?? null) === (userId ?? null); }

  // Permanently delete a conversation and its messages. Memories already saved from it are kept
  // (they live in the Memory tab, which has its own delete).
  deleteConversation(id) {
    if (!this.getConversation(id)) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      try { this.db.prepare('UPDATE tasks SET conversation_id=NULL WHERE conversation_id=?').run(id); } catch { /* tasks table optional in tests */ }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return true;
  }

  renameConversation(id, title) {
    const t = typeof title === 'string' ? title.trim().slice(0, 200) : '';
    if (!t) throw new TypeError('title required');
    return this.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(t, id).changes > 0;
  }

  addMessage(conversationId, role, content, { attachments = [] } = {}) {
    const convo = this.getConversation(conversationId);
    if (!convo) throw new Error('conversation_not_found');
    const att = Array.isArray(attachments) ? [...new Set(attachments.filter((x) => /^[0-9a-f-]{36}$/.test(String(x))))].slice(0, 20) : [];
    assertMessage(role, content, att.length > 0);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)').run(id, conversationId, role, content.trim(), now, att.length ? JSON.stringify(att) : null);
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    try { this.onMessage?.({ conversationId, role }); } catch { /* observers never break writes */ }
    return { id, conversation_id: conversationId, role, content: content.trim(), created_at: now, attachments: att };
  }

  listMessages(conversationId, limit = MAX_HISTORY_MESSAGES) {
    if (!this.getConversation(conversationId)) throw new Error('conversation_not_found');
    // The NEWEST messages (oldest-first), with attachment metadata for the UI.
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
    const rows = this.db.prepare('SELECT * FROM (SELECT id, role, content, created_at, attachments, rowid AS r FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, r ASC').all(conversationId, cap);
    return rows.map(({ r, attachments, ...m }) => ({ ...m, attachments: this.#files(attachments) }));
  }

  #files(json) {
    if (!json) return [];
    let ids = []; try { ids = JSON.parse(json); } catch { return []; }
    return ids.map((id) => { try { return this.db.prepare('SELECT id, name, mime, size FROM files WHERE id=?').get(id) ?? null; } catch { return null; } }).filter(Boolean);
  }

  // The NEWEST `limit` messages, oldest-first (the model must see recent turns, not the start of the chat).
  historyForProvider(conversationId, limit = 20) {
    if (!this.getConversation(conversationId)) throw new Error('conversation_not_found');
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_HISTORY_MESSAGES) : 20;
    const rows = this.db.prepare('SELECT role, content, attachments FROM (SELECT role, content, attachments, created_at, rowid FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rowid ASC').all(conversationId, n);
    // The model sees attachments as a note it can act on (document_read / document_edit by file id); fileNote (set by
    // the context) adds what it needs to work on a file again, e.g. the prompt of an image she drew.
    return rows.map(({ role, content, attachments }) => {
      const files = this.#files(attachments);
      return { role, content: files.length ? `${content}${content ? '\n' : ''}[attached files: ${files.map((f) => { const note = this.fileNote?.(f); return `${f.name} (file id ${f.id.slice(0, 8)}${note ? `; ${note}` : ''})`; }).join(', ')}]` : content };
    });
  }
}
