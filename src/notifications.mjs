// Notification inbox: durable list the phone/web can read, plus a bus event so
// connected clients (and later Web Push / the ESP32) react instantly.
import { randomUUID } from 'node:crypto';

export class Notifications {
  constructor(store, bus) {
    this.db = store.db;
    this.bus = bus;
    this.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      task_id TEXT, conversation_id TEXT, created_at TEXT NOT NULL, read_at TEXT
    )`);
  }

  create({ level = 'info', title, body = '', taskId = null, conversationId = null }) {
    if (!['info', 'success', 'warning', 'error'].includes(level)) throw new TypeError('invalid level');
    if (typeof title !== 'string' || !title.trim()) throw new TypeError('title required');
    const n = { id: randomUUID(), level, title: title.trim().slice(0, 200), body: String(body).slice(0, 2000), task_id: taskId, conversation_id: conversationId, created_at: new Date().toISOString(), read_at: null };
    this.db.prepare('INSERT INTO notifications (id, level, title, body, task_id, conversation_id, created_at) VALUES (?,?,?,?,?,?,?)').run(n.id, n.level, n.title, n.body, n.task_id, n.conversation_id, n.created_at);
    this.bus?.publish('notification.created', { id: n.id, level: n.level, title: n.title, body: n.body, taskId });
    return n;
  }

  list({ unreadOnly = false, limit = 50 } = {}) {
    return this.db.prepare(`SELECT * FROM notifications ${unreadOnly ? 'WHERE read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`).all(Math.min(limit, 200));
  }
  markRead(id) { return this.db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND read_at IS NULL').run(new Date().toISOString(), id).changes > 0; }
  markAllRead() { return this.db.prepare('UPDATE notifications SET read_at=? WHERE read_at IS NULL').run(new Date().toISOString()).changes; }
  unreadCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get().n; }
}
