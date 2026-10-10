import { randomUUID } from 'node:crypto';

export const MEMORY_KINDS = Object.freeze(['long_term', 'preference', 'project', 'research', 'episodic', 'semantic']);
const RRF_K = 60;

function toBlob(vec) { return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength); }
function fromBlob(blob) { const b = Buffer.from(blob); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }
function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

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
    const have = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
    const add = (name, ddl) => { if (!have.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${ddl}`); };
    add('kind', "kind TEXT NOT NULL DEFAULT 'long_term'");
    add('importance', 'importance REAL NOT NULL DEFAULT 0.5');
    add('embedding', 'embedding BLOB');
    add('embedding_model', 'embedding_model TEXT');
    add('last_used_at', 'last_used_at TEXT');
    add('use_count', 'use_count INTEGER NOT NULL DEFAULT 0');
    this.onChange = null; // (event, memory) hook: indexer + event bus
  }

  create({ content, source = 'explicit_user', project = null, sensitivity = 'normal', confidence = 1, kind = 'long_term', importance = 0.5 }) {
    if (typeof content !== 'string' || !content.trim() || content.length > 10000) throw new TypeError('invalid memory content');
    if (typeof source !== 'string' || !source.trim() || source.length > 200) throw new TypeError('invalid source');
    if (project !== null && (typeof project !== 'string' || project.length > 200)) throw new TypeError('invalid project');
    if (!['normal', 'sensitive'].includes(sensitivity)) throw new TypeError('invalid sensitivity');
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new TypeError('invalid confidence');
    if (!MEMORY_KINDS.includes(kind)) throw new TypeError('invalid kind');
    if (typeof importance !== 'number' || importance < 0 || importance > 1) throw new TypeError('invalid importance');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO memories (id, content, source, project, sensitivity, confidence, pinned, created_at, updated_at, kind, importance) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
      .run(id, content.trim(), source.trim(), project, sensitivity, confidence, now, now, kind, importance);
    const row = this.get(id);
    this.#notify('created', row);
    return row;
  }

  #notify(event, row) { try { this.onChange?.(event, row); } catch { /* hooks never break writes */ } }

  #strip(row) { if (!row) return row; const { embedding, ...rest } = row; return { ...rest, embedded: embedding != null }; }
  get(id) { return this.#strip(this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) ?? null); }
  list() { return this.db.prepare('SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC LIMIT 100').all().map((r) => this.#strip(r)); }

  // Edit content/metadata. Changing content invalidates the embedding.
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    if (typeof next.content !== 'string' || !next.content.trim() || next.content.length > 10000) throw new TypeError('invalid memory content');
    if (!['normal', 'sensitive'].includes(next.sensitivity)) throw new TypeError('invalid sensitivity');
    if (!MEMORY_KINDS.includes(next.kind)) throw new TypeError('invalid kind');
    if (typeof next.importance !== 'number' || next.importance < 0 || next.importance > 1) throw new TypeError('invalid importance');
    if (next.project !== null && (typeof next.project !== 'string' || next.project.length > 200)) throw new TypeError('invalid project');
    const contentChanged = next.content.trim() !== cur.content;
    this.db.prepare('UPDATE memories SET content=?, project=?, sensitivity=?, kind=?, importance=?, updated_at=?' + (contentChanged ? ', embedding=NULL, embedding_model=NULL' : '') + ' WHERE id=?')
      .run(next.content.trim(), next.project ?? null, next.sensitivity, next.kind, next.importance, new Date().toISOString(), id);
    const row = this.get(id);
    if (contentChanged) this.#notify('updated', row);
    return row;
  }

  pin(id, pinned = true) {
    const r = this.db.prepare('UPDATE memories SET pinned=?, updated_at=? WHERE id=?').run(pinned ? 1 : 0, new Date().toISOString(), id);
    return r.changes > 0 ? this.get(id) : null;
  }

  delete(id) { return this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0; }

  // Keyword search (FTS5/bm25). Returns rows best-first.
  search(query, { limit = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 200) throw new TypeError('invalid search');
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const safeQuery = terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    return this.db.prepare('SELECT memories.* FROM memories_fts JOIN memories ON memories.rowid=memories_fts.rowid WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?')
      .all(safeQuery, limit).map((r) => this.#strip(r));
  }

  // --- vector side -------------------------------------------------------
  setEmbedding(id, vec, model) {
    this.db.prepare('UPDATE memories SET embedding=?, embedding_model=? WHERE id=?').run(toBlob(vec), model, id);
  }
  needingEmbedding(limit = 16) {
    return this.db.prepare('SELECT id, content FROM memories WHERE embedding IS NULL ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  countEmbedded() { return this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL').get().n; }

  // Hybrid retrieval: reciprocal-rank fusion of FTS and cosine, then small
  // boosts for pinned/importance. Falls back to FTS-only without a query vector.
  searchHybrid(query, { queryVector = null, limit = 8, includeSensitive = true, project = null, minCosine = 0.25 } = {}) {
    const fts = (() => { try { return this.search(query, { limit: 30 }); } catch { return []; } })();
    const scored = new Map();
    const bump = (row, s) => { const e = scored.get(row.id) ?? { row, score: 0 }; e.score += s; scored.set(row.id, e); };
    fts.forEach((row, i) => bump(row, 1 / (RRF_K + i + 1)));
    if (queryVector) {
      const rows = this.db.prepare('SELECT * FROM memories WHERE embedding IS NOT NULL').all();
      rows.map((r) => ({ r, c: cosine(queryVector, fromBlob(r.embedding)) }))
        .filter((x) => x.c >= minCosine).sort((a, b) => b.c - a.c).slice(0, 30)
        .forEach((x, i) => bump(this.#strip(x.r), 1 / (RRF_K + i + 1)));
    }
    let out = [...scored.values()];
    if (!includeSensitive) out = out.filter((e) => e.row.sensitivity !== 'sensitive');
    if (project) out = out.filter((e) => !e.row.project || e.row.project === project);
    for (const e of out) e.score += (e.row.pinned ? 0.01 : 0) + e.row.importance * 0.004;
    return out.sort((a, b) => b.score - a.score).slice(0, limit).map((e) => e.row);
  }

  pinned(limit = 5, { includeSensitive = false } = {}) {
    return this.db.prepare(`SELECT * FROM memories WHERE pinned=1 ${includeSensitive ? '' : "AND sensitivity='normal'"} ORDER BY importance DESC, updated_at DESC LIMIT ?`).all(limit).map((r) => this.#strip(r));
  }

  touch(ids) {
    const now = new Date().toISOString();
    const st = this.db.prepare('UPDATE memories SET last_used_at=?, use_count=use_count+1 WHERE id=?');
    for (const id of ids) st.run(now, id);
  }
}
