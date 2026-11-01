import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { ChatStore } from '../src/chat.mjs';
import { Files, safeName } from '../src/files.mjs';
import { Documents } from '../src/documents.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.FRIDAY_DOCS_PYTHON ?? 'python3';
const hasLibs = spawnSync(PY, ['-c', 'import docx, openpyxl, pptx, reportlab, pypdf'], { stdio: 'ignore' }).status === 0;

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-docs-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const chat = new ChatStore(store);
  const files = new Files({ store, dir: join(dir, 'files') });
  return { dir, store, chat, files, docs: new Documents({ files, appRoot, python: PY }), done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('files: safe names, type allow-list, size cap, attachments on messages, model sees file ids, newest messages listed', () => {
  const r = rig();
  try {
    assert.equal(safeName('../../etc/pass:wd.txt'), '.._.._etc_pass_wd.txt'.replace(/^\.+/, ''));
    assert.throws(() => r.files.save({ name: 'x.exe', data: 'MZ' }), /not allowed/);
    assert.throws(() => r.files.save({ name: 'big.txt', data: Buffer.alloc(26 * 1024 * 1024) }), /too large/);
    const c = r.chat.createConversation('t');
    const f = r.files.save({ name: 'notes.txt', data: 'hello', source: 'upload' });
    r.files.claim([f.id], c.id);
    assert.equal(r.files.get(f.id).conversation_id, c.id);
    r.chat.addMessage(c.id, 'user', '', { attachments: [f.id] });
    const [m] = r.chat.listMessages(c.id);
    assert.equal(m.attachments[0].name, 'notes.txt');
    assert.match(r.chat.historyForProvider(c.id)[0].content, new RegExp(`notes\\.txt \\(file id ${f.id.slice(0, 8)}\\)`));
    assert.equal(r.files.resolve(f.id.slice(0, 8)).id, f.id);
    for (let i = 0; i < 60; i++) r.chat.addMessage(c.id, 'user', `m${i}`);
    assert.equal(r.chat.listMessages(c.id).at(-1).content, 'm59', 'newest messages are shown, not the first 40');
  } finally { r.done(); }
});

test('documents: create docx/xlsx/pptx/pdf, read them back, edits make a new version and keep the original', { skip: !hasLibs && 'python document libs not installed' }, async () => {
  const r = rig();
  try {
    const md = '## Plan\n\n- **Day 1**: students\n- Day 2\n\n| Day | Topic |\n|---|---|\n| 14 | Students |';
    const d = await r.docs.create({ format: 'docx', name: 'SemiX plan', title: 'SemiX', markdown: md });
    assert.ok(d._attach?.length, JSON.stringify(d)); assert.equal(d.file.name, 'SemiX plan.docx');
    const read = await r.docs.read(d.file.id);
    assert.match(read.text, /\[p\d\]\(Heading 2\) Plan/); assert.match(read.text, /14 \| Students/);
    const e = await r.docs.edit(d.file.id.slice(0, 8), [{ op: 'replace_text', find: 'students', replace: 'student day' }, { op: 'append_markdown', markdown: 'Bring ID.' }]);
    assert.equal(e.file.name, 'SemiX plan (v2).docx');
    assert.match((await r.docs.read(e.file.id)).text, /student day[\s\S]*Bring ID/);
    assert.doesNotMatch((await r.docs.read(d.file.id)).text, /Bring ID/, 'original untouched');
    const e3 = await r.docs.edit(e.file.id, [{ op: 'append_markdown', markdown: 'v3' }]);
    assert.equal(e3.file.name, 'SemiX plan (v3).docx');

    const x = await r.docs.create({ format: 'xlsx', name: 'budget', sheets: [{ name: 'Trip', rows: [['Item', 'Cost'], ['Hotel', '4500'], ['Total', '=SUM(B2:B2)']] }] });
    const xe = await r.docs.edit(x.file.id, [{ op: 'set_cells', sheet: 'Trip', cells: { B2: '5000' } }, { op: 'append_rows', sheet: 'Trip', rows: [['Food', '800']] }]);
    assert.match((await r.docs.read(xe.file.id)).text, /2: Hotel \| 5000[\s\S]*Food \| 800/);

    const p = await r.docs.create({ format: 'pptx', name: 'deck', title: 'SemiX 2026', slides: [{ title: 'Agenda', bullets: ['Students', { text: 'Workshops', level: 1 }] }] });
    const pe = await r.docs.edit(p.file.id, [{ op: 'add_slide', title: 'Thanks', bullets: ['Questions?'] }]);
    assert.match((await r.docs.read(pe.file.id)).text, /slide 2\nThanks/);

    const pdf = await r.docs.create({ format: 'pdf', name: 'report', title: 'Report', markdown: md });
    assert.match((await r.docs.read(pdf.file.id)).text, /Plan[\s\S]*Students/);
    assert.match((await r.docs.edit(pdf.file.id, [{ op: 'set_text', text: 'x' }])).error, /unknown pdf op/);
    assert.match((await r.docs.create({ format: 'exe', name: 'x' })).error, /format must be/);
    assert.match((await r.docs.read('deadbeef')).error, /no such file/);
  } finally { r.done(); }
});
