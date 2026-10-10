// Desktop helpers for the laptop node. Only capabilities that can actually work on
// this machine are advertised; nothing here injects raw mouse/keyboard input.
import { execFile } from 'node:child_process';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, checkFile } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = (cmd, args, timeout = 15_000) => new Promise((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => (e ? rej(Object.assign(new Error((err || e.message).toString().slice(0, 200)), { code: e.code })) : res(out.toString()))));

export async function atspiAvailable() {
  try { JSON.parse(await run('python3', [join(HERE, 'atspi-helper.py'), 'windows', '{}'], 8000)); return true; } catch { return false; }
}
const atspi = async (cmd, args) => { const out = JSON.parse(await run('python3', [join(HERE, 'atspi-helper.py'), cmd, JSON.stringify(args ?? {})])); if (out.error) throw new Error(out.error); return out; };

// ms since the user last touched keyboard/mouse (GNOME Mutter idle monitor), or null.
export async function idleMs() {
  try {
    const o = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor', '--object-path', '/org/gnome/Mutter/IdleMonitor/Core', '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'], 2000);
    const m = /uint64 (\d+)/.exec(o); return m ? Number(m[1]) : null;
  } catch { return null; }
}

export function defaultAllowedDirs() { return ['Downloads', 'Documents', 'Desktop', 'Pictures'].map((d) => join(homedir(), d)); }

export function makeDesktop({ allowedDirs }) {
  const walk = (dir, q, out, depth = 0) => {
    if (out.length >= 60 || depth > 4) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, q, out, depth + 1);
      else if (e.name.toLowerCase().includes(q)) { try { const s = statSync(p); out.push({ path: p, size: s.size, modified: s.mtime.toISOString() }); } catch {} }
    }
  };
  return {
    async windows_list() { return atspi('windows'); },
    async ui_tree({ ref }) { return atspi('tree', { ref: String(ref) }); },
    async ui_act({ ref, action }) { return atspi('act', { ref: String(ref), action }); },
    async ui_set_text({ ref, text }) { return atspi('set_text', { ref: String(ref), text: String(text) }); },
    async file_find({ query }) {
      const q = String(query ?? '').toLowerCase().trim();
      if (q.length < 2 || q.length > 100) throw new Error('query must be 2-100 chars');
      const out = [];
      for (const d of allowedDirs) { try { walk(realpathSync(d), q, out); } catch { /* dir missing */ } }
      return { files: out.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 20) };
    },
    async open_target({ target }) {
      const t = String(target ?? '');
      if (/^https?:\/\//i.test(t)) { await run('xdg-open', [checkUrl(t)]); return { opened: 'url' }; }
      const real = checkFile(t, allowedDirs); // only files under allowed dirs
      await run('xdg-open', [real]); return { opened: real.split('/').pop() };
    },
    async open_app({ id }) {
      if (!/^[a-zA-Z0-9._-]{2,80}$/.test(String(id))) throw new Error('invalid_app_id');
      await run('gio', ['launch', `/usr/share/applications/${id}.desktop`]); return { launched: id };
    },
  };
}
export { resolve };
