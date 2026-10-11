// Documents: create / read / edit Word, Excel, PowerPoint, PDF, Markdown, HTML, CSV and text through the Python
// engine (docs-engine/engine.py, short-lived subprocess). Edits never touch the original: each edit is a new
// file version in the chat, so nothing the user shared is ever lost.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extOf, safeName } from './files.mjs';

export const CREATE_FORMATS = Object.freeze(['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html', 'csv', 'txt']);
const READABLE = new Set(['docx', 'xlsx', 'xlsm', 'pptx', 'pdf', 'md', 'txt', 'csv', 'tsv', 'html', 'htm', 'json', 'xml', 'log']);
const EDITABLE = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'md', 'txt', 'csv', 'html', 'htm', 'json']);
const TIMEOUT_MS = 90_000;

export class Documents {
  constructor({ files, appRoot, python = 'python3', runner = null }) {
    Object.assign(this, { files, python, engine: resolve(appRoot, 'docs-engine', 'engine.py') });
    this.runner = runner ?? ((req) => this.#spawn(req));
  }

  #spawn(req) {
    return new Promise((res, rej) => {
      const dir = mkdtempSync(join(tmpdir(), 'friday-doc-'));
      const reqPath = join(dir, 'req.json');
      writeFileSync(reqPath, JSON.stringify(req), { mode: 0o600 });
      const p = spawn(this.python, ['-I', this.engine, reqPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: dir, PYTHONDONTWRITEBYTECODE: '1' } });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; if (out.length > 2_000_000) p.kill('SIGKILL'); });
      p.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
      p.on('error', (e) => { clearTimeout(t); rmSync(dir, { recursive: true, force: true }); rej(new Error(`document engine unavailable: ${e.message}`)); });
      p.on('close', () => {
        clearTimeout(t); rmSync(dir, { recursive: true, force: true });
        try { res(JSON.parse(out.trim().split('\n').pop())); } catch { rej(new Error(`document engine failed: ${(err || out).trim().split('\n').pop()?.slice(0, 300) || 'no output'}`)); }
      });
    });
  }

  async #run(req, { outName, conversationId, parentId = null }) {
    const work = mkdtempSync(join(tmpdir(), 'friday-docout-'));
    try {
      const out = join(work, `out.${extOf(outName)}`);
      const r = await this.runner({ ...req, out });
      if (r.error) return { error: r.error };
      if (!existsSync(out)) return { error: 'the engine produced no file' };
      const f = this.files.adopt({ srcPath: out, name: outName, conversationId, parentId });
      return { file: this.files.public(f), done: r.done, _attach: [f.id] };
    } finally { rmSync(work, { recursive: true, force: true }); }
  }

  create({ format, name, title = '', markdown = '', sheets = null, slides = null, rows = null, conversationId = null }) {
    if (!CREATE_FORMATS.includes(format)) return Promise.resolve({ error: `format must be one of ${CREATE_FORMATS.join(', ')}` });
    const base = safeName(name || title || 'document').replace(/\.[a-z0-9]{1,5}$/i, '');
    return this.#run({ op: 'create', format, title, markdown: String(markdown ?? '').slice(0, 400_000), sheets, slides, rows }, { outName: `${base}.${format}`, conversationId });
  }

  async read(fileId, { maxChars = 30_000 } = {}) {
    const f = this.files.resolve(fileId);
    if (!f) return { error: 'no such file (use the file id shown in the chat)' };
    const ext = extOf(f.name);
    if (!READABLE.has(ext)) return { error: `can't read .${ext} files`, file: this.files.public(f) };
    const work = mkdtempSync(join(tmpdir(), 'friday-docin-'));
    try {
      const p = join(work, `in.${ext}`); writeFileSync(p, this.files.read(f.id));
      const r = await this.runner({ op: 'read', path: p, max_chars: Math.min(Math.max(1000, maxChars), 60_000) });
      return r.error ? r : { file: this.files.public(f), ...r };
    } finally { rmSync(work, { recursive: true, force: true }); }
  }

  async edit(fileId, ops, { name = null, conversationId = null } = {}) {
    const f = this.files.resolve(fileId);
    if (!f) return { error: 'no such file (use the file id shown in the chat)' };
    const ext = extOf(f.name);
    if (!EDITABLE.has(ext)) return { error: `can't edit .${ext} files (convert: read it, then create a new document)` };
    if (!Array.isArray(ops) || !ops.length || ops.length > 50) return { error: 'ops must be a non-empty list (max 50)' };
    const work = mkdtempSync(join(tmpdir(), 'friday-docin-'));
    try {
      const p = join(work, `in.${ext}`); writeFileSync(p, this.files.read(f.id));
      // append_pdf may reference another chat file by id
      const fixed = ops.map((o) => (o?.op === 'append_pdf' && o.file ? (() => { const g = this.files.resolve(o.file); if (!g) return o; const q = join(work, `${g.id}.pdf`); writeFileSync(q, this.files.read(g.id)); return { ...o, path: q }; })() : o));
      const v = (/ \(v(\d+)\)$/.exec(f.name.replace(/\.[^.]+$/, ''))?.[1] ?? 1) * 1 + 1;
      const outName = name ? `${safeName(name).replace(/\.[a-z0-9]{1,5}$/i, '')}.${ext}` : `${f.name.replace(/\.[^.]+$/, '').replace(/ \(v\d+\)$/, '')} (v${v}).${ext}`;
      return await this.#run({ op: 'edit', path: p, ops: fixed }, { outName, conversationId: conversationId ?? f.conversation_id, parentId: f.id });
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
}

export const DOCS_HELP = `Formats: ${CREATE_FORMATS.join(', ')}. docx/pdf/html/md/txt take "markdown" (# headings, - bullets, 1. lists, **bold**, *italic*, tables with | and ---|---, \`\`\`code\`\`\`). xlsx takes "sheets": [{name, rows: [[...]], header: true}] (cells starting with = are formulas). pptx takes "slides": [{title, bullets: ["..", {text, level:1}], notes, table: [[...]]}]. csv takes "rows".`;
export const EDIT_HELP = 'ops per format — docx: replace_text{find,replace}, set_paragraph{index,text}, delete_paragraph{index}, insert_after{index,markdown}, append_markdown{markdown} (indexes are the [pN] numbers from document_read). xlsx: set_cells{sheet,cells:{"B2":5}}, append_rows{sheet,rows}, delete_rows{sheet,start,count}, add_sheet{name,rows}, rename_sheet{sheet,name}, delete_sheet{sheet}. pptx: replace_text, set_slide{index,title,bullets,notes}, add_slide{title,bullets,table,notes}, delete_slide{index}, move_slide{from,to} (0-based). pdf: keep_pages{pages:[1,3]}, rotate{pages,degrees}, append_pdf{file}, append_markdown{markdown}, set_metadata (pdf text itself can\'t be edited in place: read it and create a new pdf). md/txt/csv/html/json: replace_text, append_markdown, set_content{content}.';
