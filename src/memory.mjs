import { randomUUID } from 'node:crypto';

export class Memory {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT,
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  create({ content, source = 'explicit_user', project = null, sensitivity = 'normal', confidence = 1 }) {
    if (typeof content !== 'string' || !content.trim() || content.length > 10000) throw new TypeError('invalid memory content');
    if (typeof source !== 'string' || !source.trim() || source.length > 200) throw new TypeError('invalid source');
    if (project !== null && (typeof project !== 'string' || project.length > 200)) throw new TypeError('invalid project');
    if (!['normal', 'sensitive'].includes(sensitivity)) throw new TypeError('invalid sensitivity');
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new TypeError('invalid confidence');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)').run(id, content.trim(), source.trim(), project, sensitivity, confidence, now, now);
    return this.get(id);
  }

  get(id) { return this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) ?? null; }
  list() { return this.db.prepare('SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC LIMIT 100').all(); }
  search(query) {
    if (typeof query !== 'string' || query.length > 200) throw new TypeError('invalid search');
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const safeQuery = terms.slice(0, 12).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    return this.db.prepare('SELECT memories.* FROM memories_fts JOIN memories ON memories.rowid=memories_fts.rowid WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 20').all(safeQuery);
  }
  delete(id) { return this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0; }
}
