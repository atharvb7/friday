import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMoves, cleanFolder, fitsKind } from '../src/organize.mjs';
import { buildFridayTools } from '../src/agent/friday-tools.mjs';
import { GROUPS, ToolRouter } from '../src/agent/toolsets.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { Memory } from '../src/memory.mjs';

const SCAN = { dir: '/home/u/Downloads', entries: [
  { id: 1, name: 'APP_EXP9.docx', type: 'file', category: 'document', size: 10, suggest: 'Documents', peek: 'LAB EXPERIMENT NO.: 9' },
  { id: 2, name: 'Lab_Experiment_5.pdf', type: 'file', category: 'document', size: 11, suggest: 'Documents' },
  { id: 3, name: 'Resume (1).pdf', type: 'file', category: 'document', size: 12, dupOf: 'Resume.pdf', suggest: 'Duplicates' },
  { id: 4, name: 'Resume.pdf', type: 'file', category: 'document', size: 12, suggest: 'Documents' },
  { id: 5, name: 'zoro.jpg', type: 'file', category: 'image', size: 13, suggest: 'Images' },
  { id: 6, name: 'Antigravity', type: 'dir', pinned: 'an app launcher or service points at it', dir: { kind: 'app' } },
  { id: 7, name: 'salex', type: 'dir', suggest: 'Folders', dir: { kind: 'mixed' } },
  { id: 8, name: 'salex-hairstyle.jpg', type: 'file', category: 'image', size: 14, suggest: 'Images' },
  { id: 9, name: 'DSA', type: 'dir', suggest: 'Folders', dir: { kind: 'mixed' } },
] };

test('plan merge: model topics win, duplicates forced, bad/missing targets fall back, existing folders used as targets stay', () => {
  const { moves, stays, fromModel } = buildMoves(SCAN, { 1: 'College/Lab Experiments', 2: 'College/Lab Experiments', 3: 'Personal', 4: 'Personal/Resumes', 5: '../../etc', 7: 'Work/Salex', 8: 'salex', 9: 'DSA' });
  const to = Object.fromEntries(moves.map((m) => [m.name, m.to]));
  assert.equal(to['APP_EXP9.docx'], 'College/Lab Experiments');
  assert.equal(to['Resume (1).pdf'], 'Duplicates', 'exact copies always go to Duplicates');
  assert.equal(to['zoro.jpg'], 'Images', 'unsafe target -> type fallback');
  assert.equal(to['salex-hairstyle.jpg'], 'salex');
  assert.ok(!('salex' in to) && stays.some((s) => s.name === 'salex'), 'a folder others go into is not moved');
  assert.ok(!('DSA' in to) && stays.some((s) => s.name === 'DSA' && /already/.test(s.reason)));
  assert.ok(!('Antigravity' in to) && stays.some((s) => s.name === 'Antigravity' && /launcher/.test(s.reason)));
  assert.equal(fromModel, 6);
  assert.equal(moves.find((m) => m.name === 'APP_EXP9.docx').size, 10, 'size sent so the node can detect changes');
  assert.equal(cleanFolder('a/b/c'), null); assert.equal(cleanFolder(' Work /  Ahum Labs '), 'Work/Ahum Labs');
});

test('kind folders only take their kind; Duplicates only exact copies', () => {
  const pdf = { name: 'guide.pdf', type: 'file', category: 'document' };
  assert.equal(fitsKind(pdf, 'Code'), false); assert.equal(fitsKind(pdf, 'Duplicates'), false); assert.equal(fitsKind(pdf, 'College/Labs'), true);
  assert.equal(fitsKind({ type: 'file', category: 'image' }, 'Personal/Photos'), true);
  assert.equal(fitsKind({ type: 'dir', dir: { kind: 'documents' } }, 'Archives'), false);
  assert.equal(fitsKind({ type: 'dir', dir: { kind: 'app' } }, 'Apps'), true);
  const { moves } = buildMoves({ dir: '/x', entries: [{ id: 1, ...pdf, size: 1, suggest: 'Documents' }, { id: 2, name: 'lol', type: 'dir', dir: { kind: 'empty' }, suggest: 'Folders' }] }, { 1: 'Code', 2: 'Duplicates' });
  assert.deepEqual(moves.map((m) => m.to), ['Documents', 'Folders']);
});

test('too many top-level folders fold back into type folders', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `f${i}.pdf`, type: 'file', category: 'document', size: i + 1, suggest: 'Documents' }));
  const assign = Object.fromEntries(entries.map((e) => [e.id, `Topic ${e.id}`]));
  const { moves } = buildMoves({ dir: '/x', entries }, assign, { maxTop: 5 });
  assert.equal(new Set(moves.map((m) => m.to.split('/')[0])).size, 5);
});

test('folder_organize tool: plan (model) -> apply with corrections -> undo; refuses home; offline/outdated node are clear', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-org-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const sent = [];
  const mk = (caps, online = true) => ({ online, list: () => [{ name: 'laptop', caps }], dispatch: async (c) => {
    sent.push(c);
    if (c.action === 'folder_scan') return SCAN;
    if (c.action === 'folder_apply') return { undoId: '2026-11-03T10-00-00-abcdef', moved: c.args.moves.length, folders: {}, skipped: [] };
    if (c.action === 'folder_undo') return { restored: 5 };
    throw new Error('unexpected');
  } });
  let prompt = '';
  const ai = { run: async (role, o) => { prompt = o.messages[1].content; return { model: 'test-model', content: 'Here: {"folders":{"College/Lab Experiments":"labs"},"assign":{"1":"College/Lab Experiments","2":"College/Lab Experiments","4":"Personal/Resumes","5":"Wallpapers","7":"Work/Salex","8":"Work/Salex"}}' }; } };
  const tools = (nodes) => buildFridayTools({ memory: new Memory(store), store, tools: null, indexer: null, worker: { cancel() {} }, jobs: {}, settings: new Settings(store), proactive: {}, skills: null, nodes, researchMemory: null, ai }).get('folder_organize');
  try {
    const t = tools(mk(['folder_scan', 'folder_apply', 'folder_undo']));
    const p = await t.run({ action: 'plan', instructions: 'keep wallpapers separate' });
    assert.equal(sent[0].args.dir, '~/Downloads');
    assert.match(prompt, /HIS WISHES.*wallpapers/); assert.match(prompt, /LAB EXPERIMENT NO\.: 9/); assert.ok(!/Antigravity/.test(prompt.split('Items:')[1]), 'pinned items are not offered to the model');
    assert.equal(p.planner, 'test-model'); assert.ok(p.planId);
    assert.ok(p.summary.folders.some((f) => f.folder === 'College/Lab Experiments' && f.count === 2));
    const a = await t.run({ action: 'apply', planId: p.planId, changes: [{ name: 'zoro.jpg', to: 'Images/Wallpapers' }, { name: 'Resume.pdf', to: 'stay' }] });
    const mv = sent.at(-1).args.moves;
    assert.equal(sent.at(-1).args.via, 'screen', 'on screen by default');
    assert.equal(mv.find((m) => m.name === 'zoro.jpg').to, 'Images/Wallpapers'); assert.ok(!mv.some((m) => m.name === 'Resume.pdf'));
    assert.equal(a.changesApplied, 2); assert.equal(a.undoId, '2026-11-03T10-00-00-abcdef');
    assert.equal((await t.run({ action: 'apply', planId: p.planId })).error, 'unknown_or_expired_plan', 'a plan is used once');
    assert.equal((await t.run({ action: 'undo', undoId: a.undoId })).restored, 5);
    assert.equal((await t.run({ action: 'plan', dir: '~' })).error, 'home_folder_refused');
    assert.equal((await tools(mk([], false)).run({ action: 'plan' })).error, 'laptop_offline');
    assert.equal((await tools(mk(['shell_run'])).run({ action: 'plan' })).error, 'node_outdated');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('"arrange my downloads" loads the laptop group (folder_organize)', () => {
  const r = new ToolRouter();
  assert.ok(GROUPS.laptop.tools.includes('folder_organize'));
  for (const msg of ['arrange all my files in downloads properly', 'sort my Downloads folder', 'can you tidy up my files', 'organise this folder']) {
    assert.ok(r.select({ text: msg }).has('laptop'), msg);
  }
});
