// Folder organizer for the laptop node ("sort my Downloads").
//   scan   what each item in ONE folder is (type, size, date, a short text peek of documents, exact duplicates, what a
//          sub-folder holds: project / installed app / photos...) and what must NOT move (hidden files, downloads still
//          in progress, things an app launcher or a running program points at, Fridayy's own folders)
//   apply  move items into sub-folders of that same folder: never outside it, never overwriting, never deleting;
//          every move is recorded in an undo manifest
//   undo   put everything back from a manifest
// The server plans (a model groups items by what they are about); the node re-checks every move itself.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';

const HOME = homedir();
const MAX_ENTRIES = 1500;
const DIR_WALK_LIMIT = 3000;
const PEEK_CHARS = 160;
const HASH_MAX_BYTES = 1024 ** 3;
const SETTLE_MS = 2 * 60_000; // touched in the last 2 minutes: maybe still downloading/being written
const err = (code, msg = code) => Object.assign(new Error(msg), { code });

const CATEGORY = {};
const add = (cat, exts) => { for (const e of exts.split(' ')) CATEGORY[e] = cat; };
add('document', 'pdf doc docx odt rtf txt md epub tex pages');
add('presentation', 'ppt pptx odp key');
add('spreadsheet', 'xls xlsx ods csv tsv numbers');
add('data', 'json xml yaml yml sql db sqlite parquet');
add('image', 'jpg jpeg png gif webp heic heif svg bmp tif tiff ico avif raw cr2 nef psd xcf');
add('video', 'mp4 mkv mov avi webm m4v flv wmv 3gp');
add('audio', 'mp3 wav m4a flac ogg aac opus wma mid midi');
add('code', 'py ipynb js mjs ts tsx jsx java c h cpp hpp cc cs go rs rb php sh bash ino v sv vhd vhdl m r kt swift dart lua pl html htm css scss vue');
add('archive', 'zip tar gz tgz bz2 xz 7z rar zst');
add('installer', 'deb rpm appimage snap flatpakref exe msi dmg pkg apk run');
add('font', 'ttf otf woff woff2');
add('design', 'fig sketch xd ai blend stl obj fbx kicad_pcb kicad_sch');
// Fallback folder per kind when the planner has nothing better (or no model is reachable).
export const TYPE_FOLDER = { document: 'Documents', presentation: 'Presentations', spreadsheet: 'Spreadsheets', data: 'Data', image: 'Images', video: 'Videos', audio: 'Audio',
  code: 'Code', archive: 'Archives', installer: 'Installers', font: 'Fonts', design: 'Design', other: 'Other' };
const PEEKABLE = new Set(['document', 'presentation', 'spreadsheet', 'code', 'data']);
// Never sent to the model even as a 160-char peek: IDs, money, health, passwords.
const SENSITIVE_NAME = /aadha?ar|\bpan\b|pan.?card|passport|licen[cs]e|voter|bank|statement|salary|payslip|tax|itr|invoice|medical|prescription|password|secret|credential|private|confidential|signed/i;
const PROTECTED = new Set(['friday-media']); // Fridayy saves downloads/reels here (node/browser.mjs, reel tools)
const PARTIAL = /\.(crdownload|part|partial|download|tmp|opdownload)$|^\.~lock\.|^~\$/i;
const COPY_MARK = /\s\(\d+\)(?=\.[^.]+$|$)| - copy(?=\.[^.]+$|$)|_copy(?=\.[^.]+$|$)/i;

export function extOf(name) {
  const n = name.toLowerCase();
  if (/\.tar\.(gz|xz|bz2|zst)$/.test(n)) return n.match(/\.tar\.\w+$/)[0].slice(1);
  return extname(n).slice(1);
}
export function categoryOf(name) {
  const e = extOf(name);
  return CATEGORY[e] ?? CATEGORY[e.split('.').pop()] ?? 'other';
}
const stemOf = (name) => name.replace(/\.(tar\.\w+|tgz|zip|7z|rar|tar)$/i, '');

const run = (cmd, args, timeout = 5000) => new Promise((res) => execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (e, out) => res(e ? '' : out.toString())));
const cleanText = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, PEEK_CHARS);

async function peek(path, ext) {
  try {
    if (ext === 'pdf') return cleanText(await run('pdftotext', ['-f', '1', '-l', '1', '-q', path, '-']));
    if (ext === 'docx') return cleanText(await run('unzip', ['-p', path, 'word/document.xml']));
    if (ext === 'pptx') return cleanText(await run('unzip', ['-p', path, 'ppt/slides/slide1.xml']));
    if (ext === 'xlsx') return cleanText(await run('unzip', ['-p', path, 'xl/sharedStrings.xml']));
    if (ext === 'ipynb') {
      const nb = JSON.parse(readFileSync(path, 'utf8'));
      return cleanText((nb.cells ?? []).slice(0, 3).map((c) => [].concat(c.source ?? []).join('')).join(' '));
    }
    if (statSync(path).size > 2 * 1024 * 1024) return '';
    const buf = readFileSync(path).subarray(0, 2048);
    return buf.includes(0) ? '' : cleanText(buf.toString('utf8'));
  } catch { return ''; }
}

const sha1 = (path) => new Promise((res) => {
  const h = createHash('sha1'); const s = createReadStream(path);
  s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex'))); s.on('error', () => res(null));
});

// Paths that something else depends on: app launchers, autostart, user services, ~/.local/bin links, running programs.
export function dependedPaths({ home = HOME, proc = '/proc' } = {}) {
  const texts = []; const paths = [];
  for (const d of ['.local/share/applications', '.config/autostart', '.config/systemd/user']) {
    try { for (const f of readdirSync(join(home, d))) { try { const p = join(home, d, f); if (statSync(p).isFile()) texts.push(readFileSync(p, 'utf8').slice(0, 64 * 1024)); } catch { /* unreadable */ } } } catch { /* missing */ }
  }
  try { for (const f of readdirSync(join(home, '.local/bin'))) { try { paths.push(realpathSync(join(home, '.local/bin', f))); } catch { /* dangling */ } } } catch { /* missing */ }
  try {
    for (const pid of readdirSync(proc)) {
      if (!/^\d+$/.test(pid)) continue;
      for (const l of ['cwd', 'exe']) { try { paths.push(readlinkSync(join(proc, pid, l))); } catch { /* other user / gone */ } }
    }
  } catch { /* no /proc */ }
  return { texts, paths };
}
function dependedOn(full, deps) {
  const under = (p) => p === full || p.startsWith(full + sep);
  if (deps.paths.some(under)) return 'in use by a running program';
  for (const t of deps.texts) {
    let i = t.indexOf(full);
    while (i >= 0) { const c = t[i + full.length]; if (c === undefined || /[/\s"'=;:%]/.test(c)) return 'an app launcher or service points at it'; i = t.indexOf(full, i + 1); }
  }
  return null;
}

// What a sub-folder holds, without reading file contents (bounded walk).
const PROJECT_MARKERS = new Set(['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'makefile', 'cmakelists.txt', 'platformio.ini', 'composer.json', 'gemfile', 'vite.config.js', 'next.config.js', 'tsconfig.json', 'dockerfile', 'docker-compose.yml', 'compose.yaml']);
export function describeDir(path) {
  const counts = {}; const markers = new Set(); let files = 0, dirs = 0, elf = 0, bytes = 0;
  const stack = [[path, 0]];
  while (stack.length && files + dirs < DIR_WALK_LIMIT) {
    const [d, depth] = stack.pop();
    let list; try { list = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const low = e.name.toLowerCase();
      if (depth <= 1 && PROJECT_MARKERS.has(low)) markers.add(low);
      if (e.isDirectory()) { dirs++; if (depth < 6 && low !== 'node_modules' && low !== '.git') stack.push([join(d, e.name), depth + 1]); continue; }
      if (!e.isFile()) continue;
      files++;
      const cat = categoryOf(e.name); counts[cat] = (counts[cat] ?? 0) + 1;
      if (cat === 'code' && depth <= 1 && low.endsWith('.ino')) markers.add('*.ino');
      try {
        const p = join(d, e.name); const st = statSync(p); bytes += st.size;
        if (depth <= 2 && (st.mode & 0o111) && st.size > 100_000) { const b = Buffer.alloc(4); const fd = openSync(p, 'r'); try { readSync(fd, b, 0, 4, 0); } finally { closeSync(fd); } if (b.toString('latin1') === '\x7fELF') elf++; }
      } catch { /* vanished */ }
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const share = (cat) => (files ? (counts[cat] ?? 0) / files : 0);
  let kind = 'mixed';
  if (!files && !dirs) kind = 'empty';
  else if (elf) kind = 'app';
  else if (markers.size) kind = 'project';
  else if (share('image') + share('video') >= 0.7) kind = share('video') > share('image') ? 'videos' : 'images';
  else if (share('audio') >= 0.7) kind = 'audio';
  else if (share('document') + share('presentation') + share('spreadsheet') >= 0.7) kind = 'documents';
  else if (share('code') >= 0.5) kind = 'code';
  else if (share('installer') >= 0.5) kind = 'installers';
  return { files, dirs, bytes, kind, markers: [...markers].slice(0, 6), top: top.slice(0, 3).map(([c, n]) => `${c} ${Math.round((n / files) * 100)}%`), truncated: files + dirs >= DIR_WALK_LIMIT };
}

const DIR_FOLDER = { project: 'Projects', app: 'Apps', images: 'Images', videos: 'Videos', audio: 'Audio', documents: 'Documents', code: 'Code', installers: 'Installers', mixed: 'Folders', empty: 'Folders' };

// A folder the user may sort: inside $HOME, never $HOME itself, never a hidden/config folder.
export function organizableDir(dir, { home = HOME } = {}) {
  const raw = String(dir ?? '').trim().replace(/^~(?=\/|$)/, home);
  if (!raw) throw err('dir_required', 'dir required, e.g. ~/Downloads');
  const real = realpathSync(raw.startsWith('/') ? raw : join(home, raw));
  if (!statSync(real).isDirectory()) throw err('not_a_folder', 'not a folder');
  if (!real.startsWith(home + sep)) throw err('path_not_allowed', 'only folders inside the home folder can be organized');
  const rel = relative(home, real);
  if (rel.split(sep).some((s) => s.startsWith('.')) || /^(snap|\.local|\.config)(\/|$)/.test(rel)) throw err('path_not_allowed', 'hidden/config/app folders are never reorganized');
  return real;
}

export async function scanFolder({ dir, keep = [], home = HOME, deps = null, now = Date.now() } = {}) {
  const root = organizableDir(dir, { home });
  const d = deps ?? dependedPaths({ home });
  const keepSet = new Set([...PROTECTED, ...keep.map(String)]);
  const list = readdirSync(root, { withFileTypes: true });
  const entries = [];
  for (const e of list.slice(0, MAX_ENTRIES)) {
    const full = join(root, e.name);
    let st; try { st = lstatSync(full); } catch { continue; }
    const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'special';
    const it = { id: entries.length + 1, name: e.name, type, size: st.size, mtime: new Date(st.mtimeMs).toISOString().slice(0, 10) };
    if (type === 'file') { it.ext = extOf(e.name); it.category = categoryOf(e.name); }
    if (e.name.startsWith('.') && !PARTIAL.test(e.name)) it.pinned = 'hidden file';
    else if (PARTIAL.test(e.name)) it.pinned = 'download in progress or an open document lock';
    else if (keepSet.has(e.name)) it.pinned = 'Fridayy uses this folder';
    else if (type === 'special') it.pinned = 'not a regular file';
    else if (now - st.mtimeMs < SETTLE_MS) it.pinned = 'changed in the last 2 minutes';
    else { const why = dependedOn(full, d); if (why) it.pinned = why; }
    if (type === 'dir') { it.dir = describeDir(full); it.size = it.dir.bytes; }
    entries.push(it);
  }
  // Extracted archives: "x.zip" next to folder "x" (the archive is the spare copy).
  const dirNames = new Set(entries.filter((x) => x.type === 'dir').map((x) => x.name));
  for (const it of entries) if (it.category === 'archive' && dirNames.has(stemOf(it.name))) it.extractedTo = stemOf(it.name);
  // Exact duplicates: same size, then same SHA-1. The original is the name without "(1)", then the shortest, then the oldest.
  const bySize = new Map();
  for (const it of entries) if (it.type === 'file' && it.size > 0 && it.size <= HASH_MAX_BYTES) bySize.set(it.size, [...(bySize.get(it.size) ?? []), it]);
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byHash = new Map();
    for (const it of group) { const h = await sha1(join(root, it.name)); if (h) byHash.set(h, [...(byHash.get(h) ?? []), it]); }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      same.sort((a, b) => Number(COPY_MARK.test(a.name)) - Number(COPY_MARK.test(b.name)) || a.name.length - b.name.length || a.mtime.localeCompare(b.mtime));
      for (const dup of same.slice(1)) dup.dupOf = same[0].name;
    }
  }
  // Text peeks (documents only, never sensitive-looking names), a few at a time.
  const todo = entries.filter((x) => x.type === 'file' && PEEKABLE.has(x.category) && !x.dupOf && !x.pinned && x.size < 50 * 1024 * 1024 && !SENSITIVE_NAME.test(x.name));
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(async (x) => { const p = await peek(join(root, x.name), x.ext); if (p) x.peek = p; }));
  for (const it of entries) if (!it.pinned) it.suggest = suggestFolder(it);
  return { dir: root, scannedAt: new Date(now).toISOString(), entries, truncated: list.length > MAX_ENTRIES };
}

export function suggestFolder(it) {
  if (it.dupOf) return 'Duplicates';
  if (it.type === 'dir') return DIR_FOLDER[it.dir?.kind] ?? 'Folders';
  if (it.type === 'link') return 'Shortcuts';
  return TYPE_FOLDER[it.category] ?? 'Other';
}

// "College/Lab Experiments" -> segments; refuses anything that could leave the folder or hide files.
export function cleanTarget(to) {
  const segs = String(to ?? '').split(/[/\\]+/).map((s) => s.replace(/[\x00-\x1f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!segs.length || segs.length > 3) return null;
  if (segs.some((s) => s === '.' || s === '..' || s.startsWith('.') || s.length > 80)) return null;
  return segs;
}

function freeName(dirPath, name) {
  if (!existsSync(join(dirPath, name))) return name;
  const m = /^(.*?)(\.(tar\.\w+|[^.]+))?$/.exec(name); const base = m[1] || name; const ext = m[2] ?? '';
  for (let n = 2; n < 1000; n++) { const c = `${base} (${n})${ext}`; if (!existsSync(join(dirPath, c))) return c; }
  throw new Error('no free name');
}

const manifestDir = (confDir) => join(confDir, 'organize');

// moves: [{ name, to, size?, mtime? }] — name = an item directly inside dir, to = sub-folder path relative to dir.
// gui (optional): async ({ dir, names, target, newFolder? }) that moves one group ON SCREEN in the Files app
// (atspi-helper.py files_move). Every group is then checked on disk: what the app did not move is moved directly,
// and anything it moved that was not asked for is put back. Without gui every move is a direct rename.
export async function applyMoves({ dir, moves, confDir, gui = null, home = HOME, deps = null, keep = [], now = Date.now(), onGroup = null }) {
  const root = organizableDir(dir, { home });
  if (!Array.isArray(moves) || !moves.length) throw err('moves_required', 'moves required');
  if (moves.length > MAX_ENTRIES) throw err('too_many_moves', `at most ${MAX_ENTRIES} moves`);
  const d = deps ?? dependedPaths({ home });
  const keepSet = new Set([...PROTECTED, ...keep.map(String)]);
  const id = `${new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomUUID().slice(0, 6)}`;
  const manifest = { id, dir: root, at: new Date(now).toISOString(), moves: [], createdDirs: [] };
  const skipped = []; const screen = { groups: 0, onScreen: 0, direct: 0, putBack: 0, errors: [] };
  // Folders the plan targets that are also items being moved must stay where they are.
  const targetRoots = new Set(moves.map((m) => cleanTarget(m.to)?.[0]).filter(Boolean));
  const save = () => { mkdirSync(manifestDir(confDir), { recursive: true, mode: 0o700 }); writeFileSync(join(manifestDir(confDir), `${id}.json`), JSON.stringify(manifest, null, 1), { mode: 0o600 }); };
  const groups = new Map(); // "College/Labs" -> { segs, names: [] }
  for (const m of moves) {
    const name = String(m?.name ?? '');
    const segs = cleanTarget(m?.to);
    const skip = (reason) => skipped.push({ name, reason });
    if (!name || name.includes('/') || name === '.' || name === '..') { skip('not an item of this folder'); continue; }
    if (!segs) { skip('bad target folder'); continue; }
    const full = join(root, name);
    let st; try { st = lstatSync(full); } catch { skip('no longer exists'); continue; }
    if (name.startsWith('.') || PARTIAL.test(name) || keepSet.has(name)) { skip('protected'); continue; }
    if (now - st.mtimeMs < SETTLE_MS) { skip('changed in the last 2 minutes'); continue; }
    if (m.size !== undefined && st.isFile() && Number(m.size) !== st.size) { skip('changed since the scan'); continue; }
    if (segs[0] === name || targetRoots.has(name)) { skip('it is one of the target folders'); continue; }
    const why = dependedOn(full, d); if (why) { skip(why); continue; }
    const key = segs.join('/');
    if (!groups.has(key)) groups.set(key, { segs, names: [] });
    groups.get(key).names.push(name);
  }
  const record = (name, cur, finalName) => manifest.moves.push({ from: name, to: relative(root, join(cur, finalName)) });
  const direct = (name, cur) => { const f = freeName(cur, name); renameSync(join(root, name), join(cur, f)); record(name, cur, f); };
  try {
    for (const { segs, names } of groups.values()) {
      const target = join(root, ...segs);
      // The parent folders exist first (so the app only ever does one step); a new top-level target folder is left for
      // the app's "New Folder with Selection" to create.
      let cur = root; let bad = false;
      const appMakesIt = gui && segs.length === 1 && !existsSync(target);
      for (const [i, s] of segs.entries()) {
        cur = join(cur, s);
        if (existsSync(cur)) { if (!lstatSync(cur).isDirectory()) { bad = true; break; } continue; }
        if (appMakesIt && i === segs.length - 1) continue;
        mkdirSync(cur); manifest.createdDirs.push(relative(root, cur));
      }
      if (bad) { for (const n of names) skipped.push({ name: n, reason: 'target path is a file' }); continue; }
      if (!gui) { for (const n of names) direct(n, target); continue; }
      // Same name already in the target: the app would stop on a "replace?" dialog. Those go directly, renamed.
      const clash = new Set(names.filter((n) => existsSync(join(target, n))));
      const onScreen = names.filter((n) => !clash.has(n));
      const before = new Set(existsSync(target) ? readdirSync(target) : []);
      screen.groups++;
      if (onScreen.length) {
        try { await gui({ dir: root, names: onScreen, target, ...(appMakesIt ? { newFolder: segs[0] } : {}) }); }
        catch (e) { screen.errors.push(`${segs.join('/')}: ${String(e.message ?? e).slice(0, 120)}`); }
      }
      if (appMakesIt && existsSync(target)) manifest.createdDirs.push(relative(root, target));
      else if (appMakesIt) { mkdirSync(target); manifest.createdDirs.push(relative(root, target)); }
      const want = new Set(onScreen);
      for (const n of readdirSync(target)) {
        if (before.has(n) || want.has(n)) continue;
        // The app moved something nobody asked for: put it back where it was.
        if (!existsSync(join(root, n))) { renameSync(join(target, n), join(root, n)); screen.putBack++; }
      }
      for (const n of names) {
        if (!clash.has(n) && existsSync(join(target, n)) && !existsSync(join(root, n))) { record(n, target, n); screen.onScreen++; }
        else if (existsSync(join(root, n))) { direct(n, target); screen.direct++; }
        else skipped.push({ name: n, reason: 'vanished during the move' });
      }
      onGroup?.({ folder: segs.join('/'), count: names.length });
    }
  } finally { if (manifest.moves.length || manifest.createdDirs.length) save(); }
  const folders = {};
  for (const mv of manifest.moves) { const f = mv.to.split(sep).slice(0, -1).join('/'); folders[f] = (folders[f] ?? 0) + 1; }
  return { undoId: manifest.moves.length ? id : null, moved: manifest.moves.length, folders, renamed: manifest.moves.filter((mv) => !mv.to.endsWith(sep + mv.from)).map((mv) => mv.to).slice(0, 20), skipped: skipped.slice(0, 60), skippedCount: skipped.length,
    ...(gui ? { screen: { ...screen, errors: screen.errors.slice(0, 10) } } : {}) };
}

export function undoMoves({ undoId, confDir }) {
  if (!/^[\w-]{10,60}$/.test(String(undoId ?? ''))) throw err('bad_undo_id', 'bad undoId');
  const file = join(manifestDir(confDir), `${undoId}.json`);
  if (!existsSync(file)) throw err('unknown_undo_id', 'no such organize run');
  const mf = JSON.parse(readFileSync(file, 'utf8'));
  if (mf.undoneAt) return { restored: 0, note: `already undone at ${mf.undoneAt}` };
  let restored = 0; const problems = [];
  for (const mv of [...mf.moves].reverse()) {
    const from = join(mf.dir, mv.from), to = join(mf.dir, mv.to);
    if (!existsSync(to)) { problems.push(`${mv.to}: no longer there`); continue; }
    if (existsSync(from)) { problems.push(`${mv.from}: something new has that name now`); continue; }
    renameSync(to, from); restored++;
  }
  let removedDirs = 0;
  for (const rel of [...mf.createdDirs].sort((a, b) => b.length - a.length)) { try { rmdirSync(join(mf.dir, rel)); removedDirs++; } catch { /* not empty: keep */ } }
  mf.undoneAt = new Date().toISOString(); writeFileSync(file, JSON.stringify(mf, null, 1), { mode: 0o600 });
  return { restored, removedDirs, problems: problems.slice(0, 30) };
}
