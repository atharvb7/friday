// Files shared in chat: uploads from the user and documents Friday makes. Stored under <data>/files/<id> with
// metadata in SQLite. Downloads are always served as attachments (never rendered inline), so a hostile upload can't
// run as a page on Friday's origin.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, extname } from 'node:path';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  tsv: 'text/tab-separated-values', html: 'text/html', htm: 'text/html', json: 'application/json', xml: 'application/xml', log: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', zip: 'application/zip',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
};
export const extOf = (name) => extname(String(name)).slice(1).toLowerCase();

export function safeName(name) {
  const base = String(name ?? '').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return base || 'file';
}

export class Files {
  constructor({ store, dir, bus = null }) {
    Object.assign(this, { dir, bus });
    this.db = store.db;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db.exec(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      source TEXT NOT NULL, conversation_id TEXT, task_id TEXT, parent_id TEXT, created_at TEXT NOT NULL)`);
    this.db.exec('CREATE INDEX IF NOT EXISTS files_conv_idx ON files (conversation_id, created_at)');
  }

  #insert({ id, name, size, sha, source, conversationId, taskId, parentId }) {
    const ext = extOf(name);
    if (!MIME[ext]) throw new TypeError(`file type .${ext || '?'} is not allowed`);
    this.db.prepare('INSERT INTO files (id,name,mime,size,sha256,source,conversation_id,task_id,parent_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, MIME[ext], size, sha, source, conversationId ?? null, taskId ?? null, parentId ?? null, new Date().toISOString());
    this.bus?.publish('file.saved', { id, name, source, conversationId: conversationId ?? null });
    return this.get(id);
  }

  save({ name, data, source = 'friday', conversationId = null, taskId = null, parentId = null, maxBytes = MAX_FILE_BYTES }) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
    if (!buf.length) throw new TypeError('empty file');
    if (buf.length > maxBytes) throw new TypeError(`file too large (max ${Math.round(maxBytes / 1048576)} MB)`);
    const clean = safeName(name); if (!MIME[extOf(clean)]) throw new TypeError(`file type .${extOf(clean) || '?'} is not allowed`);
    const id = randomUUID();
    writeFileSync(this.path(id), buf, { mode: 0o600 });
    try { return this.#insert({ id, name: clean, size: buf.length, sha: createHash('sha256').update(buf).digest('hex'), source, conversationId, taskId, parentId }); }
    catch (e) { rmSync(this.path(id), { force: true }); throw e; }
  }

  // Adopt a file a tool just wrote (e.g. the document engine's output).
  adopt({ srcPath, name, source = 'friday', conversationId = null, taskId = null, parentId = null }) {
    const size = statSync(srcPath).size;
    if (!size || size > MAX_FILE_BYTES) throw new TypeError('output file empty or too large');
    const id = randomUUID();
    copyFileSync(srcPath, this.path(id));
    const sha = createHash('sha256').update(readFileSync(this.path(id))).digest('hex');
    try { return this.#insert({ id, name: safeName(name), size, sha, source, conversationId, taskId, parentId }); }
    catch (e) { rmSync(this.path(id), { force: true }); throw e; }
  }

  path(id) { if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new TypeError('bad file id'); return join(this.dir, id); }
  get(id) { return /^[0-9a-f-]{36}$/.test(String(id)) ? this.db.prepare('SELECT * FROM files WHERE id=?').get(id) ?? null : null; }
  // Accepts a full id or an unambiguous prefix (models often quote 8 chars).
  resolve(idOrPrefix) {
    const s = String(idOrPrefix ?? '').trim().toLowerCase();
    if (!/^[0-9a-f-]{6,36}$/.test(s)) return null;
    const rows = this.db.prepare('SELECT * FROM files WHERE id LIKE ? LIMIT 2').all(`${s}%`);
    return rows.length === 1 ? rows[0] : null;
  }
  read(id) { return readFileSync(this.path(id)); }
  list({ conversationId = null, limit = 50 } = {}) {
    return conversationId
      ? this.db.prepare('SELECT * FROM files WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?').all(conversationId, limit)
      : this.db.prepare('SELECT * FROM files ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  // Files uploaded before the chat existed join the conversation they were sent in.
  claim(ids, conversationId) { for (const id of ids ?? []) this.db.prepare('UPDATE files SET conversation_id=? WHERE id=? AND conversation_id IS NULL').run(conversationId, id); }
  remove(id) { const f = this.get(id); if (!f) return false; rmSync(this.path(id), { force: true }); this.db.prepare('DELETE FROM files WHERE id=?').run(id); return true; }
  public(f) { return f ? { id: f.id, name: f.name, mime: f.mime, size: f.size, source: f.source, created_at: f.created_at } : null; }
}
