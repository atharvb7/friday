// Folder organizer, server side ("sort my Downloads"). The laptop node scans the folder (node/organize.mjs: type,
// size, date, a short text peek of documents, exact duplicates, what sub-folders hold, what must not move); a model
// groups the items into a small folder tree by what they ARE ABOUT (college labs, a client, IDs, wallpapers...), with
// the node's type-based suggestion as the fallback for anything the model skips or gets wrong. The plan is kept here
// for an hour; applying it sends the exact moves back to the node, which re-checks each one and records an undo.
import { randomUUID } from 'node:crypto';

const PLAN_TTL_MS = 60 * 60_000;
const PLAN_MODEL_MS = 150_000;
const MAX_PLANS = 20;
const MAX_TOP = 14;
const plans = new Map(); // planId -> { dir, moves, createdAt, summary }

const SYSTEM = `You organize ONE messy folder (usually Downloads) into a clean, small folder tree, the way a tidy person would.
Input: one line per item: id | file or dir | type | size | date | name | (what a folder holds) | «first words of the document».
Output ONLY JSON: {"folders": {"<Folder/Sub>": "<what goes there, 3-8 words>"}, "assign": {"<id>": "<Folder/Sub>", ...}}
Rules:
- Group by WHAT IT IS ABOUT when a clear topic has 3+ items (a course, lab experiments, a company/client, an event, a hackathon, an internship, personal IDs, wallpapers, resumes, a project). Otherwise group by kind (Images, Videos, Audio, Installers, Archives, Code, Spreadsheets...).
- 6 to ${MAX_TOP} top-level folders. At most 2 levels ("College/Lab Experiments"). Human names in Title Case, no dates or ids in names. Reuse an existing folder from the list as a target when it fits (e.g. put loose Salex files into the existing "salex" folder).
- Read the «text» and the name together: "APP_EXP9.docx" whose text says "LAB EXPERIMENT NO.: 9" is a college lab experiment. Resumes, offer letters and ID photos are personal; quotations, LOAs, invoices for a company go under that company.
- Items marked dup-of are exact copies: assign them to "Duplicates" (he decides later; nothing is deleted).
- Archives marked extracted-to are spare copies of a folder that is already here: put them in "Archives".
- Folders that are apps (kind app) go to "Apps"; code projects (kind project) go to "Projects" unless they clearly belong to a topic folder; a folder that already IS a clean topic (e.g. "DSA", "SIP") may move under a parent topic ("College/DSA") or stay its own top-level folder: then assign it to its own name.
- Kind folders hold ONLY that kind: "Code" = source files (.py .ino .ipynb .json), never PDFs/docs about tech; "Presentations" = slide files only; "Images" = pictures only. A document about a topic goes to that topic or to "Documents".
- Never merge different companies, clubs or events into one folder (Paytm is not AI Pulse Club). A project with several loose files (a film, a pitch, firmware) gets its own folder, e.g. "Projects/Nudge".
- "Duplicates" ONLY for items marked dup-of. Empty folders go to "Folders".
- Never invent ids. Every id in the input gets exactly one folder.`;

const line = (e) => [e.id, e.type, e.type === 'dir' ? `folder:${e.dir?.kind ?? '?'}${e.dir?.markers?.length ? `(${e.dir.markers.join(',')})` : ''} ${e.dir?.files ?? 0} files ${e.dir?.top?.join(' ') ?? ''}` : e.category, human(e.size), e.mtime, e.name,
  e.dupOf ? `dup-of: ${e.dupOf}` : '', e.extractedTo ? `extracted-to: ${e.extractedTo}` : '', e.peek ? `«${e.peek.slice(0, 120)}»` : ''].filter(Boolean).join(' | ');
function human(n) { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = Number(n) || 0; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${v < 10 && i ? v.toFixed(1) : Math.round(v)}${u[i]}`; }
const jsonIn = (s) => { try { return JSON.parse(/\{[\s\S]*\}/.exec(String(s ?? ''))?.[0] ?? 'null'); } catch { return null; } };

export function cleanFolder(to) {
  const segs = String(to ?? '').split(/[/\\]+/).map((s) => s.replace(/[\x00-\x1f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!segs.length || segs.length > 2 || segs.some((s) => s === '.' || s === '..' || s.startsWith('.') || s.length > 60)) return null;
  return segs.join('/');
}

// Folders named after a KIND only take that kind (the model put PDFs into "Code" and an unrelated file into "Duplicates").
const KIND_FOLDERS = { images: ['image'], photos: ['image'], pictures: ['image'], videos: ['video'], audio: ['audio'], music: ['audio'], code: ['code', 'data'], scripts: ['code'],
  presentations: ['presentation'], slides: ['presentation'], spreadsheets: ['spreadsheet', 'data'], installers: ['installer'], archives: ['archive'], apps: [], duplicates: [] };
const DIR_KINDS = { images: ['images'], photos: ['images'], pictures: ['images'], videos: ['videos'], audio: ['audio'], music: ['audio'], code: ['code', 'project'], scripts: ['code'], apps: ['app'], installers: ['installers', 'app'] };
export function fitsKind(e, to) {
  const last = to.split('/').at(-1).toLowerCase();
  if (!(last in KIND_FOLDERS)) return true;
  if (e.type === 'dir') return (DIR_KINDS[last] ?? []).includes(e.dir?.kind);
  return KIND_FOLDERS[last].includes(e.category);
}

// Merge the model's assignment with the node's fallback; enforce the structure rules the model may have ignored.
export function buildMoves(scan, assign = {}, { maxTop = MAX_TOP } = {}) {
  const movable = scan.entries.filter((e) => !e.pinned);
  const names = new Set(scan.entries.map((e) => e.name));
  const pick = new Map();
  let fromModel = 0;
  for (const e of movable) {
    let to = e.dupOf ? 'Duplicates' : cleanFolder(assign[String(e.id)]);
    if (to && !e.dupOf && !fitsKind(e, to)) to = null; // a PDF in "Code", a non-copy in "Duplicates"
    if (to && !e.dupOf) fromModel++;
    // An app bundle or a pinned name never becomes a target parent for something unrelated; a file can't be a folder.
    if (to && names.has(to.split('/')[0]) && scan.entries.find((x) => x.name === to.split('/')[0])?.type !== 'dir') to = null;
    pick.set(e.name, to ?? e.suggest ?? 'Other');
  }
  // Too many top-level folders: fold the smallest model-made ones into their type fallback.
  const tops = () => { const c = new Map(); for (const t of pick.values()) { const k = t.split('/')[0]; c.set(k, (c.get(k) ?? 0) + 1); } return c; };
  let c = tops();
  // (folding can itself add a type folder, so repeat until it fits)
  for (let guard = 0; c.size > maxTop && guard < 50; guard++) {
    const fallbacks = new Set(movable.map((e) => (e.suggest ?? 'Other').split('/')[0]));
    const small = [...c.entries()].filter(([k]) => !fallbacks.has(k)).sort((a, b) => a[1] - b[1]).slice(0, Math.max(1, c.size - maxTop + 1)).map(([k]) => k);
    if (!small.length) break;
    for (const e of movable) if (small.includes(pick.get(e.name).split('/')[0])) pick.set(e.name, e.suggest ?? 'Other');
    c = tops();
  }
  const moves = []; const stays = [];
  for (const e of movable) {
    const to = pick.get(e.name);
    if (e.type === 'dir' && to.split('/')[0] === e.name && !to.includes('/')) { stays.push({ name: e.name, reason: 'already a good folder' }); continue; }
    moves.push({ name: e.name, to, ...(e.type === 'file' ? { size: e.size } : {}) });
  }
  // A folder that is a target root must not itself be moved (the node refuses that too).
  const roots = new Set(moves.map((m) => m.to.split('/')[0]));
  const final = moves.filter((m) => { if (roots.has(m.name)) { stays.push({ name: m.name, reason: 'other items go into it' }); return false; } return true; });
  for (const e of scan.entries.filter((x) => x.pinned)) stays.push({ name: e.name, reason: e.pinned });
  return { moves: final, stays, fromModel, movable: movable.length };
}

function summarize(scan, moves, stays) {
  const tree = {};
  for (const m of moves) { (tree[m.to] ??= []).push(m.name); }
  const folders = Object.entries(tree).sort((a, b) => a[0].localeCompare(b[0])).map(([folder, items]) => ({ folder, count: items.length, examples: items.slice(0, 4) }));
  const dups = moves.filter((m) => m.to === 'Duplicates').length;
  return { folders, stays: stays.slice(0, 40), duplicates: dups, items: scan.entries.length };
}

function remember(plan) {
  const now = Date.now();
  for (const [id, p] of plans) if (now - p.createdAt > PLAN_TTL_MS) plans.delete(id);
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
  const id = randomUUID().slice(0, 8);
  plans.set(id, { ...plan, createdAt: now });
  return id;
}

// -> { planId, dir, summary, planner }
export async function planOrganize({ nodes, ai, dir, instructions = '', signal } = {}) {
  const scan = await nodes.dispatch({ action: 'folder_scan', args: { dir }, timeoutMs: 180_000 });
  const movable = scan.entries.filter((e) => !e.pinned);
  if (!movable.length) return { dir: scan.dir, summary: { folders: [], stays: scan.entries.map((e) => ({ name: e.name, reason: e.pinned })), items: scan.entries.length }, note: 'Nothing to move.' };
  let assign = {}; let planner = 'type fallback';
  if (ai?.hasProvider !== false && ai?.run) {
    const existing = scan.entries.filter((e) => e.type === 'dir').map((e) => e.name);
    const user = `Folder: ${scan.dir}\nExisting sub-folders: ${existing.join(', ') || '(none)'}\n${instructions ? `HIS WISHES (follow them): ${String(instructions).slice(0, 800)}\n` : ''}Items:\n${movable.map(line).join('\n')}`;
    // Hard cap: on 3 Nov one planning call never returned (>400 s); the type fallback beats a hung chat.
    const cap = AbortSignal.timeout(PLAN_MODEL_MS);
    try {
      const run = ai.run('reason', { signal: signal ? AbortSignal.any([signal, cap]) : cap, maxTokens: 12_000, temperature: 0.1, timeoutMs: PLAN_MODEL_MS, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] });
      const out = await Promise.race([run, new Promise((_, rej) => cap.addEventListener('abort', () => rej(new Error('plan_timeout')), { once: true }))]);
      const j = jsonIn(out.content);
      if (j?.assign && typeof j.assign === 'object') { assign = j.assign; planner = out.model ?? 'model'; }
    } catch { /* fall back to type folders */ }
  }
  const { moves, stays, fromModel } = buildMoves(scan, assign);
  const summary = summarize(scan, moves, stays);
  const planId = remember({ dir: scan.dir, moves, summary });
  return { planId, dir: scan.dir, planner: fromModel ? planner : 'type fallback (no model plan)', modelAssigned: `${fromModel}/${movable.length}`, summary, moves: moves.length };
}

export function getPlan(planId) { const p = plans.get(String(planId ?? '')); return p && Date.now() - p.createdAt <= PLAN_TTL_MS ? p : null; }

// changes: [{ name, to }] — his corrections to the plan before applying ("keep the wallpapers in Images/Wallpapers").
// via 'screen' (default): the laptop moves each group visibly in the Files app; 'direct': plain renames (seconds).
export async function applyOrganize({ nodes, planId, changes = [], via = 'screen' }) {
  const p = getPlan(planId);
  if (!p) return { error: 'unknown_or_expired_plan', note: 'Plan again (action plan); plans last one hour.' };
  const moves = p.moves.map((m) => ({ ...m }));
  const byName = new Map(moves.map((m) => [m.name, m]));
  let changed = 0;
  for (const ch of Array.isArray(changes) ? changes.slice(0, 300) : []) {
    const to = ch?.to === 'stay' ? 'stay' : cleanFolder(ch?.to);
    const m = byName.get(String(ch?.name ?? ''));
    if (!m || !to) continue;
    if (to === 'stay') { moves.splice(moves.indexOf(m), 1); byName.delete(m.name); } else m.to = to;
    changed++;
  }
  const r = await nodes.dispatch({ action: 'folder_apply', args: { dir: p.dir, moves, via: via === 'direct' ? 'direct' : 'screen' }, timeoutMs: 15 * 60_000 });
  plans.delete(String(planId));
  return { ...r, dir: p.dir, changesApplied: changed };
}

export const _plans = plans; // tests
