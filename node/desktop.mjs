// Desktop helpers for the laptop node: the whole GNOME desktop, not just Friday's browser.
//   apps     find/launch any installed app (.desktop entries incl. snap + flatpak exports), fuzzy names
//   windows  list (AT-SPI), focus, close — verified, never "press Alt+F4 and hope"
//   input    keyboard + absolute pointer through a uinput virtual device (input-helper.py, no root, works on Wayland)
//   screen   geometry (Mutter DisplayConfig), screenshot (xdg portal, downscaled JPEG), lock state, clipboard
//   shell    run commands as the user (timeout + process-group kill, capped output); files anywhere in $HOME
// The server decides what needs approval; the node only refuses a few catastrophic things outright.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, checkFile } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const run = (cmd, args, timeout = 15_000) => new Promise((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => (e ? rej(Object.assign(new Error((err || e.message).toString().slice(0, 200)), { code: e.code })) : res(out.toString()))));
const err = (code, msg = code) => Object.assign(new Error(msg), { code });

export async function atspiAvailable() {
  try { JSON.parse(await run('python3', [join(HERE, 'atspi-helper.py'), 'windows', '{}'], 8000)); return true; } catch { return false; }
}
const atspi = async (cmd, args) => { const out = JSON.parse(await run('python3', [join(HERE, 'atspi-helper.py'), cmd, JSON.stringify(args ?? {})])); if (out.error) throw new Error(out.error); return out; };
// Arguments go through stdin, never argv: clipboard text (maybe a password) must not show up in `ps`.
const helper = (cmd, args, timeout = 20_000) => new Promise((res, rej) => {
  const p = execFile('python3', [join(HERE, 'desktop-helper.py'), cmd, '-'], { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, errOut) => {
    let j; try { j = JSON.parse(out.toString()); } catch { rej(new Error(String(errOut || e?.message || 'helper_failed').slice(0, 200))); return; }
    j.error ? rej(new Error(j.error)) : res(j);
  });
  p.stdin.end(JSON.stringify(args ?? {}));
});

// ms since the last keyboard/mouse event (GNOME Mutter idle monitor), or null. NOTE: Friday's own injected input counts too.
export async function idleMs() {
  try {
    const o = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor', '--object-path', '/org/gnome/Mutter/IdleMonitor/Core', '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'], 2000);
    const m = /uint64 (\d+)/.exec(o); return m ? Number(m[1]) : null;
  } catch { return null; }
}

// true while the lock screen is up (nothing can be seen or typed then), null if unknown.
export async function screenLocked() {
  try { const o = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'], 2000); return /true/.test(o); } catch { return null; }
}

let geo = null; // { at, value }: the layout changes rarely (monitor plugged in): cache briefly
export async function screenGeometry({ fresh = false } = {}) {
  if (!fresh && geo && Date.now() - geo.at < 30_000) return geo.value;
  const value = await helper('screen', {}, 8000);
  geo = { at: Date.now(), value }; return value;
}

// Whole-desktop screenshot, downscaled for a vision model. Shared by the computer agent and the voice "what's on my
// screen" path. Coordinates: image px * (screen.width / width) = desktop logical px (what the pointer actions take).
export async function captureScreen({ maxWidth = 1280, quality = 70 } = {}) {
  if (await screenLocked()) throw err('screen_locked', 'screen_locked: the laptop is locked; unlock it first');
  const [shot, screen] = await Promise.all([helper('shot', { maxWidth, quality }, 25_000), screenGeometry().catch(() => null)]);
  return { ...shot, screen: screen ? { width: screen.width, height: screen.height, monitors: screen.monitors } : { width: shot.sourceWidth, height: shot.sourceHeight } };
}

// ---------- apps (.desktop entries) ----------
export function desktopDirs(env = process.env) {
  const dataHome = env.XDG_DATA_HOME || join(HOME, '.local/share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  // The user service may start with a thin XDG_DATA_DIRS: always include the snap/flatpak export dirs too.
  return [...new Set([dataHome, join(HOME, '.local/share/flatpak/exports/share'), ...dataDirs, '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop', '/usr/local/share', '/usr/share'].map((d) => join(d, 'applications')))];
}

export function parseDesktopEntry(text) {
  const out = {}; let inMain = false;
  for (const line of String(text).split('\n')) {
    const l = line.trim();
    if (l.startsWith('[')) { inMain = l === '[Desktop Entry]'; continue; }
    if (!inMain || !l || l.startsWith('#')) continue;
    const i = l.indexOf('='); if (i < 0) continue;
    const k = l.slice(0, i).trim(); if (!(k in out)) out[k] = l.slice(i + 1).trim();
  }
  return out;
}

export function loadApps(dirs = desktopDirs()) {
  const seen = new Map();
  for (const dir of dirs) {
    let names; try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.desktop') || seen.has(f)) continue; // earlier dirs win (user overrides system), like the XDG spec
      let e; try { e = parseDesktopEntry(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      seen.set(f, null);
      if (e.Type !== 'Application' || e.Hidden === 'true' || !e.Name) continue;
      const id = f.slice(0, -8);
      const source = dir.includes('/snapd/') ? 'snap' : dir.includes('/flatpak/') ? 'flatpak' : 'desktop';
      const exec = (e.Exec ?? '').replace(/%[a-zA-Z]/g, '').trim();
      seen.set(f, { id, name: e.Name, generic: e.GenericName ?? '', keywords: (e.Keywords ?? '').split(';').filter(Boolean), exec, bin: basename(exec.split(/\s+/).find((w) => w && !w.includes('=') && w !== 'env') ?? ''), path: join(dir, f), source, hidden: e.NoDisplay === 'true', dbus: e.DBusActivatable === 'true' });
    }
  }
  return [...seen.values()].filter(Boolean);
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// What people call apps vs their menu names.
const ALIASES = { 'vs code': 'visual studio code', vscode: 'visual studio code', calc: 'calculator', 'file manager': 'files', explorer: 'files', nautilus: 'files',
  'control panel': 'settings', 'system settings': 'settings', 'task manager': 'system monitor', 'command prompt': 'terminal', cmd: 'terminal', notepad: 'text editor', paint: 'drawing', 'music player': 'music' };
// Score how well an app matches what the user said ("calculator", "vs code", "files", "calculater").
export function scoreApp(app, query) {
  let q = norm(query); if (!q) return 0;
  q = ALIASES[q] ?? q;
  const name = norm(app.name); const idTail = norm(app.id.split('.').pop()); const id = norm(app.id);
  const words = name.split(' '); const extra = norm([app.generic, ...app.keywords].join(' ')); const bin = norm(app.bin);
  let s = 0;
  if (name === q) s = 100;
  else if (id === q || idTail === q || bin === q) s = 95;
  else if (name.startsWith(q)) s = 85;
  else if (name.replace(/ /g, '') === q.replace(/ /g, '')) s = 85;
  else if (words.some((w) => w.startsWith(q))) s = 75;
  else if (q.split(' ').every((w) => name.includes(w))) s = 70;
  else if (name.includes(q) || id.includes(q.replace(/ /g, ''))) s = 60;
  else if (extra.split(' ').includes(q) || (q.length > 3 && extra.includes(q))) s = 50;
  else {
    const best = Math.min(...[name, idTail, ...words].filter((w) => w.length > 2).map((w) => editDistance(w, q)));
    if (best <= (q.length > 6 ? 2 : 1)) s = 45;
  }
  if (s && app.hidden) s -= 20; // NoDisplay helpers (url handlers etc.) only win when nothing visible matches
  return s;
}
export function findApps(apps, query, limit = 5) {
  return apps.map((a) => ({ a, s: scoreApp(a, query) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s || x.a.name.length - y.a.name.length).slice(0, limit);
}

// ---------- input (uinput) ----------
// One long-lived helper process owns the virtual devices; commands are JSON lines.
export class InputDevice {
  #proc = null; #ready = null; #seq = 0; #waiting = new Map(); #idleTimer = null;
  lastInjectAt = 0; // when Friday last injected input: the idle monitor can't tell her events from the user's
  constructor({ script = join(HERE, 'input-helper.py'), spawnImpl = spawn, idleExitMs = 10 * 60_000 } = {}) { Object.assign(this, { script, spawnImpl, idleExitMs }); }

  #start() {
    if (this.#ready) return this.#ready;
    const p = this.spawnImpl('python3', [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#proc = p;
    let buf = '';
    this.#ready = new Promise((resolveReady, rejectReady) => {
      const t = setTimeout(() => rejectReady(new Error('input_helper_timeout')), 8000);
      p.stdout.on('data', (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if ('ready' in m) { clearTimeout(t); m.ready ? resolveReady(true) : rejectReady(new Error(m.error ?? 'uinput_unavailable')); continue; }
          const w = this.#waiting.get(m.id); if (!w) continue;
          this.#waiting.delete(m.id); clearTimeout(w.timer); m.ok ? w.res(m) : w.rej(new Error(m.error ?? 'input_failed'));
        }
      });
      p.on('exit', () => { clearTimeout(t); rejectReady(new Error('input_helper_exited')); this.#reset(new Error('input_helper_exited')); });
      p.on('error', (e) => { clearTimeout(t); rejectReady(e); this.#reset(e); });
    });
    this.#ready.catch(() => { this.#reset(new Error('input_helper_failed')); });
    return this.#ready;
  }
  #reset(e) {
    for (const w of this.#waiting.values()) { clearTimeout(w.timer); w.rej(e); }
    this.#waiting.clear(); this.#proc = null; this.#ready = null;
  }
  async send(cmd, timeoutMs = 30_000) {
    await this.#start();
    const id = ++this.#seq;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close(), this.idleExitMs); this.#idleTimer.unref?.();
    try {
      return await new Promise((res, rej) => {
        const timer = setTimeout(() => { this.#waiting.delete(id); rej(new Error('input_timeout')); }, timeoutMs);
        this.#waiting.set(id, { res, rej, timer });
        this.#proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
      });
    } finally { this.lastInjectAt = Date.now(); }
  }
  close() { try { this.#proc?.stdin.end(); this.#proc?.kill(); } catch {} this.#reset(new Error('closed')); }
}

// ---------- shell ----------
// Refused even when approved: whole-disk/home wipes, filesystem formatting, raw disk writes, fork bombs.
const CATASTROPHIC = [/\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME|\/home\/?[^/\s]*)\/?(\s|$|\*)/i, /\bmkfs(\.\w+)?\b/, /\bdd\b[^|;]*\bof=\/dev\//, /:\(\)\s*\{\s*:\|:&\s*\};:/, /\b(shred|wipefs)\b[^|;]*\/dev\//, />\s*\/dev\/(sd|nvme)/];
export function catastrophic(cmd) { return CATASTROPHIC.some((r) => r.test(String(cmd))); }

const capText = (s, max) => (s.length <= max ? s : `${s.slice(0, Math.floor(max * 0.6))}\n…[${s.length - max} chars cut]…\n${s.slice(-Math.floor(max * 0.4))}`);
export function runShell({ command, cwd = HOME, timeoutMs = 60_000, maxChars = 12_000, spawnImpl = spawn } = {}) {
  const cmd = String(command ?? '').trim();
  if (!cmd || cmd.length > 8000) return Promise.reject(new Error('command must be 1-8000 chars'));
  if (catastrophic(cmd)) return Promise.reject(err('refused', 'refused: this command could destroy the system or home folder'));
  const limit = Math.max(1000, Math.min(Number(timeoutMs) || 60_000, 10 * 60_000));
  return new Promise((res) => {
    // Own process group so a timeout kills the whole pipeline; stdin closed so prompts (sudo, ssh) fail instead of hanging.
    const p = spawnImpl('bash', ['-lc', cmd], { cwd: existsSync(cwd) ? cwd : HOME, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SUDO_ASKPASS: '/bin/false', GIT_TERMINAL_PROMPT: '0', DEBIAN_FRONTEND: 'noninteractive' } });
    let out = '', errOut = '', timedOut = false; const t0 = Date.now();
    const keep = (s, d) => (s.length > 400_000 ? s : s + d.toString()); // don't buffer gigabytes of output
    p.stdout.on('data', (d) => { out = keep(out, d); }); p.stderr.on('data', (d) => { errOut = keep(errOut, d); });
    const kill = (sig) => { try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 2000).unref?.(); }, limit);
    p.on('error', (e) => { clearTimeout(timer); res({ code: null, stdout: '', stderr: String(e.message).slice(0, 300), timedOut: false, ms: Date.now() - t0 }); });
    p.on('close', (code, signal) => { clearTimeout(timer); res({ code, ...(signal ? { signal } : {}), stdout: capText(out, maxChars), stderr: capText(errOut, Math.floor(maxChars / 3)), timedOut, ms: Date.now() - t0 }); });
  });
}

// ---------- files ($HOME) ----------
// Credentials never leave the laptop through file actions (the shell path asks the user instead, see the server).
const SECRET_PATH = /(^|\/)(\.ssh|\.gnupg|\.password-store|\.friday-node|keyrings|\.mozilla\/firefox\/[^/]+\/(logins|key4)|google-chrome\/[^/]+\/(Login Data|Cookies))(\/|$)|(^|\/)(\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|kdbx|p12|pfx)|access-token|credentials(\.json)?|\.netrc|\.pgpass)$/i;
export function homePath(p, { mustExist = true } = {}) {
  const raw = String(p ?? '').trim().replace(/^~(?=\/|$)/, HOME);
  if (!raw) throw new Error('path required');
  const abs = resolve(HOME, raw);
  let real = abs;
  if (mustExist) real = realpathSync(abs);
  else { let d = dirname(abs); while (!existsSync(d) && d !== '/') d = dirname(d); real = join(realpathSync(d), abs.slice(d.length)); }
  if (real !== HOME && !real.startsWith(`${HOME}/`)) throw err('path_not_allowed', 'path_not_allowed: only files inside your home folder');
  if (SECRET_PATH.test(real.slice(HOME.length))) throw err('sensitive_file_blocked', 'sensitive_file_blocked: keys/credentials are never read or written by Friday');
  return real;
}

// Start a program and return once it is clearly running: detached, no pipes (an app holding our stdout open would make
// execFile wait for it to exit), and only an exit within the first second counts as a failure.
export function launchDetached(cmd, args, { spawnImpl = spawn, graceMs = 1000 } = {}) {
  return new Promise((res, rej) => {
    let p; try { p = spawnImpl(cmd, args, { detached: true, stdio: 'ignore' }); } catch (e) { rej(e); return; }
    const t = setTimeout(() => { p.unref?.(); res({ pid: p.pid }); }, graceMs);
    p.on('error', (e) => { clearTimeout(t); rej(e); });
    p.on('exit', (code) => { clearTimeout(t); code ? rej(new Error(`${cmd} exited with ${code}`)) : res({ pid: p.pid }); });
  });
}

export function defaultAllowedDirs() { return ['Downloads', 'Documents', 'Desktop', 'Pictures'].map((d) => join(HOME, d)); }

const ASCII = /^[\x20-\x7e\n\t]*$/;
// Everything that touches the session (D-Bus, AT-SPI, processes) is injectable so tests run headless.
export function makeDesktop({ allowedDirs = defaultAllowedDirs(), fullAccess = true, input = new InputDevice(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), exec = run, launch = launchDetached,
  idle = idleMs, locked = screenLocked, geometry = screenGeometry, a11y = atspi, capture = captureScreen, clip = helper, loadAppList = loadApps } = {}) {
  const walk = (dir, q, out, depth = 0, maxDepth = 4, until = Date.now() + 4000) => {
    if (out.length >= 60 || depth > maxDepth || Date.now() > until) return; // a big home folder must not stall the node
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink() || e.name === 'node_modules' || e.name === 'snap') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, q, out, depth + 1, maxDepth, until);
      else if (e.name.toLowerCase().includes(q)) { try { const s = statSync(p); out.push({ path: p, size: s.size, modified: s.mtime.toISOString() }); } catch {} }
    }
  };
  let appsCache = null;
  const launchedAt = new Map(); // app id -> ms: an app launched seconds ago may not have registered its window yet
  const apps = () => { if (!appsCache || Date.now() - appsCache.at > 60_000) appsCache = { at: Date.now(), list: loadAppList() }; return appsCache.list; };
  const resolveApp = (query) => {
    const hits = findApps(apps(), query);
    if (!hits.length) throw err('app_not_found', `app_not_found: nothing installed matches "${String(query).slice(0, 60)}"`);
    const [top, second] = hits;
    if (top.s < 95 && second && second.s >= top.s - 5 && !second.a.hidden && !top.a.hidden && norm(second.a.name) !== norm(top.a.name)) {
      throw err('app_ambiguous', `app_ambiguous: "${query}" could be ${hits.slice(0, 4).map((h) => `${h.a.name} (${h.a.id})`).join(', ')}; pass the exact id`);
    }
    return top.a;
  };
  // Input goes to whatever has focus: refuse while the screen is locked or the HUMAN (not Friday) just used the machine.
  const userActive = async (withinMs = 1500) => { const ms = await idle(); return ms !== null && ms < withinMs && Date.now() - ms > input.lastInjectAt + 400; };
  const guardInput = async () => {
    if (await locked()) throw err('screen_locked', 'screen_locked: the laptop is locked; Friday cannot type or click until it is unlocked');
    if (await userActive()) throw err('user_active', 'user_active: the user is using the keyboard/mouse right now; retry in a few seconds');
  };
  const toFrac = async (x, y) => {
    const g = await geometry();
    const fx = Number(x) / g.width, fy = Number(y) / g.height;
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) throw new Error(`point (${x},${y}) is outside the desktop ${g.width}x${g.height}`);
    return { x: fx, y: fy };
  };
  const windows = async () => a11y('windows');
  const activeWindows = async () => (await windows()).apps.flatMap((a) => a.windows.filter((w) => w.active).map((w) => ({ app: a.app, ...w })));
  const appWindows = async (app) => (await windows().catch(() => ({ apps: [] }))).apps.filter((a) => appMatchesWindow(app, a)).flatMap((a) => a.windows.filter((w) => w.name).map((w) => ({ app: a.app, ...w })));
  // Word-boundary match only ("code" must not match "claude-code"'s windows when closing things).
  const appMatchesWindow = (app, w) => { const n = norm(w.app); return [norm(app.name), norm(app.id.split('.').pop()), norm(app.bin)].some((x) => x && x.length > 2 && (n === x || ` ${n} `.includes(` ${x} `) || ` ${x} `.includes(` ${n} `))); };

  const d = {
    async windows_list() { return windows(); },
    async ui_tree({ ref }) { return a11y('tree', { ref: String(ref) }); },
    async ui_act({ ref, action }) { return a11y('act', { ref: String(ref), action }); },
    async ui_set_text({ ref, text }) { return a11y('set_text', { ref: String(ref), text: String(text) }); },
    async file_find({ query, dir }) {
      const q = String(query ?? '').toLowerCase().trim();
      if (q.length < 2 || q.length > 100) throw new Error('query must be 2-100 chars');
      const out = [];
      const roots = fullAccess ? [dir ? homePath(dir) : HOME] : allowedDirs;
      for (const r of roots) { try { walk(realpathSync(r), q, out, 0, fullAccess ? 6 : 4); } catch { /* dir missing */ } }
      return { files: out.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 20) };
    },
    async open_target({ target }) {
      const t = String(target ?? '').trim();
      if (/^https?:\/\//i.test(t)) { await exec('xdg-open', [checkUrl(t)]); return { opened: 'url' }; }
      if (/^mailto:/i.test(t)) { await exec('xdg-open', [t.slice(0, 2000)]); return { opened: 'mail_composer' }; } // opens a draft; nothing is sent
      const real = fullAccess ? homePath(t) : checkFile(t, allowedDirs);
      await exec('gio', ['open', real]); return { opened: real.split('/').pop() };
    },
    // Launch any installed app by name or id (fuzzy: "vs code", "calculater", "files").
    async open_app({ id, name }) {
      const app = resolveApp(id ?? name);
      if (await locked()) throw err('screen_locked', 'screen_locked: unlock the laptop first');
      const before = (await appWindows(app)).length;
      await launch('gio', ['launch', app.path]); launchedAt.set(app.id, Date.now());
      // Wait for its window (AT-SPI) so the next step can act on it; slow apps (Electron, snaps) may take longer.
      for (let i = 0; i < 24; i++) {
        await sleep(250);
        const wins = await appWindows(app);
        if (wins.length > before || (before && i >= 3)) return { launched: app.id, name: app.name, source: app.source, window: wins.at(-1)?.name ?? null, focused: wins.some((w) => w.active) };
      }
      return { launched: app.id, name: app.name, source: app.source, window: null, note: 'started; no window seen yet (slow app, or it runs in the background)' };
    },
    async apps_find({ query }) {
      const hits = query ? findApps(apps(), query, 8) : apps().filter((a) => !a.hidden).slice(0, 200).map((a) => ({ a, s: 0 }));
      return { apps: hits.map(({ a }) => ({ id: a.id, name: a.name, source: a.source })) };
    },
  };
  if (!fullAccess) return d;

  return Object.assign(d, {
    async screen_info() {
      const [g, isLocked, ms] = await Promise.all([geometry({ fresh: true }).catch((e) => ({ error: e.message })), locked(), idle()]);
      return { ...g, locked: isLocked, idleMs: ms, userActive: ms !== null && ms < 3000 && Date.now() - ms > input.lastInjectAt + 400 };
    },
    async screen_capture({ maxWidth = 1280, quality = 70 } = {}) { return capture({ maxWidth, quality }); },
    async key_press({ keys, repeat = 1 }) {
      if (!keys || String(keys).length > 60) throw new Error('keys like "ctrl+l", "Return", "alt+F4"');
      await guardInput();
      for (let i = 0; i < Math.max(1, Math.min(Number(repeat) || 1, 30)); i++) await input.send({ op: 'key', keys: String(keys) });
      return { pressed: String(keys) };
    },
    // ASCII is typed key by key (US layout); anything else (emoji, accents, Hindi) is pasted through the clipboard.
    async type_text({ text, method = 'auto', pasteKeys = 'ctrl+v' }) {
      const s = String(text ?? ''); if (!s || s.length > 20_000) throw new Error('text must be 1-20000 chars');
      await guardInput();
      if (method === 'paste' || (method === 'auto' && (!ASCII.test(s) || s.length > 400))) {
        let old = null; try { old = (await clip('clip_get', {}, 5000)).text; } catch { /* nothing to restore */ }
        await clip('clip_set', { text: s }, 8000);
        await sleep(120);
        await input.send({ op: 'key', keys: String(pasteKeys) });
        await sleep(400); // the target app reads the clipboard asynchronously
        if (old) clip('clip_set', { text: old }, 8000).catch(() => {});
        return { typed: s.length, method: 'paste' };
      }
      // Chunks, so a human grabbing the keyboard mid-way stops Friday within ~1 s.
      for (let i = 0; i < s.length; i += 40) { if (i) await guardInput(); await input.send({ op: 'type', text: s.slice(i, i + 40) }); }
      return { typed: s.length, method: 'keys' };
    },
    async mouse_move({ x, y }) { await guardInput(); await input.send({ op: 'move', ...(await toFrac(x, y)) }); return { at: [x, y] }; },
    async mouse_click({ x, y, button = 'left', count = 1 }) {
      await guardInput();
      await input.send({ op: 'click', ...(await toFrac(x, y)), button, count: Math.max(1, Math.min(Number(count) || 1, 3)) });
      return { clicked: [x, y], button, count };
    },
    async mouse_drag({ x1, y1, x2, y2 }) {
      await guardInput();
      const a = await toFrac(x1, y1), b = await toFrac(x2, y2);
      await input.send({ op: 'drag', x1: a.x, y1: a.y, x2: b.x, y2: b.y }); return { dragged: [[x1, y1], [x2, y2]] };
    },
    async mouse_scroll({ x, y, dy = 3, dx = 0 }) {
      await guardInput();
      const p = x !== undefined && y !== undefined ? await toFrac(x, y) : { x: null, y: null };
      await input.send({ op: 'scroll', ...p, dy: Math.max(-50, Math.min(50, Number(dy) || 0)), dx: Math.max(-50, Math.min(50, Number(dx) || 0)) }); return { scrolled: { dy, dx } };
    },
    async clipboard_get() { const t = (await clip('clip_get', {}, 5000)).text; return { text: t.slice(0, 20_000), truncated: t.length > 20_000 }; },
    async clipboard_set({ text }) { return clip('clip_set', { text: String(text ?? '').slice(0, 100_000) }, 8000); },
    // Bring an app's window to the front. Not running -> launch it. Running -> GNOME overview search (Super, type the
    // name, Enter) focuses its existing window like a person would; re-launching would open a SECOND window in many apps.
    async window_focus({ app: q }) {
      const app = resolveApp(q);
      await guardInput();
      const focused = async () => (await activeWindows().catch(() => [])).some((w) => appMatchesWindow(app, w));
      if (!(await appWindows(app)).length) {
        if (!(Date.now() - (launchedAt.get(app.id) ?? 0) < 15_000)) { await launch('gio', ['launch', app.path]); launchedAt.set(app.id, Date.now()); }
        for (let i = 0; i < 24; i++) { await sleep(250); if (await focused()) return { focused: app.name, via: 'launched' }; }
      } else if (await focused()) return { focused: app.name, via: 'already' };
      await input.send({ op: 'key', keys: 'super' }); await sleep(500);
      await input.send({ op: 'type', text: app.name.replace(/[^\x20-\x7e]/g, '').slice(0, 40) }); await sleep(700);
      await input.send({ op: 'key', keys: 'Return' });
      for (let i = 0; i < 8; i++) { await sleep(250); if (await focused()) return { focused: app.name, via: 'overview' }; }
      return { focused: null, warning: `could not verify that ${app.name} is focused; take a screenshot before typing` };
    },
    // Close an app's window(s). Prefer the window's own accessibility "close" action (GTK/libadwaita: exact window, no
    // focus needed). Otherwise Alt+F4, but only after AT-SPI confirms the target is the ONLY focused window: closing the
    // user's other window by mistake is the failure to avoid. Several windows -> name one (title) or pass all=true.
    async window_close({ app: q, title, all = false, force = false }) {
      const app = resolveApp(q);
      const wins = (await appWindows(app)).filter((w) => !title || w.name.toLowerCase().includes(String(title).toLowerCase()));
      if (!wins.length) return { closed: 0, note: `${app.name} has no ${title ? `window titled "${title}"` : 'open window'}` };
      if (wins.length > 1 && !all) return { closed: 0, error: 'several_windows', windows: wins.map((w) => w.name).slice(0, 8), hint: 'pass title (part of the window name) or all=true' };
      // Highest refs first: closing a window can renumber the windows/apps after it, never the ones before.
      const byRef = (a, b) => { const x = a.ref.split('.').map(Number), y = b.ref.split('.').map(Number); return y[0] - x[0] || y[1] - x[1]; };
      let closed = 0; const left = [];
      for (const w of [...wins].sort(byRef)) {
        let ok = false;
        for (const action of ['window.close', 'win.close']) { try { if ((await a11y('act', { ref: w.ref, action })).ok) { ok = true; break; } } catch { /* no such action */ } }
        if (ok) closed++; else left.push(w);
      }
      if (!left.length) return { closed, via: 'accessibility' };
      await guardInput();
      const act = await activeWindows().catch(() => []);
      const mine = act.filter((w) => appMatchesWindow(app, w));
      if (left.length > 1 || !mine.length || (act.length > mine.length && !force)) {
        return { closed, error: 'focus_unverified', active: act.map((w) => `${w.app}: ${w.name}`).slice(0, 4), hint: `focus ${app.name} (window_focus), confirm with a screenshot, then call again with force=true` };
      }
      await input.send({ op: 'key', keys: 'alt+F4' });
      return { closed: closed + 1, via: 'alt+F4' };
    },
    async shell_run({ command, cwd, timeoutMs }) { return runShell({ command, cwd: cwd ? homePath(cwd) : HOME, timeoutMs }); },
    async file_read({ path, maxBytes = 65_536, offset = 0 }) {
      const real = homePath(path); const st = statSync(real);
      if (st.isDirectory()) return { path: real, dir: readdirSync(real, { withFileTypes: true }).slice(0, 300).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)) };
      const n = Math.max(1, Math.min(Number(maxBytes) || 65_536, 512 * 1024));
      const buf = readFileSync(real).subarray(Number(offset) || 0, (Number(offset) || 0) + n);
      if (buf.includes(0)) return { path: real, size: st.size, binary: true, note: 'binary file: open it with an app (open_target) instead' };
      return { path: real, size: st.size, text: buf.toString('utf8'), truncated: st.size > (Number(offset) || 0) + n };
    },
    async file_write({ path, text, append = false }) {
      const real = homePath(path, { mustExist: false });
      const s = String(text ?? ''); if (s.length > 2_000_000) throw new Error('text too large (2 MB max)');
      mkdirSync(dirname(real), { recursive: true });
      const existed = existsSync(real);
      if (append) appendFileSync(real, s); else writeFileSync(real, s);
      return { path: real, bytes: Buffer.byteLength(s), ...(existed && !append ? { overwrote: true } : {}), ...(append ? { appended: true } : {}) };
    },
    // Deleting = moving to the Trash (recoverable). Permanent deletion only goes through shell_run, which asks the user.
    async file_trash({ path }) { const real = homePath(path); await exec('gio', ['trash', real]); return { trashed: real }; },
  });
}
export { resolve };
