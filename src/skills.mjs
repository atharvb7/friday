// Skills: folders with SKILL.md (frontmatter: name, description). Shipped skills
// live in <repo>/skills, user-installed ones in <data>/skills. They are loaded
// only when relevant: the model sees a one-line index, then calls skill_load.
// The same folders are synced into Friday's DSH home so the background agent
// sees them natively.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const MAX_SKILL_BYTES = 256 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function parseSkill(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
  if (!NAME_RE.test(meta.name ?? '') || !meta.description) return null;
  return { name: meta.name, description: meta.description, body: m[2].trim() };
}

export class Skills {
  constructor({ roots }) { this.roots = roots.map((r) => resolve(r)); }

  list() {
    const found = new Map();
    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const f = join(root, d.name, 'SKILL.md');
        try {
          if (!existsSync(f) || statSync(f).size > MAX_SKILL_BYTES) continue;
          const s = parseSkill(readFileSync(f, 'utf8'));
          if (s && s.name === d.name) found.set(s.name, { name: s.name, description: s.description, path: join(root, d.name), source: root });
        } catch { /* skip unreadable skill */ }
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  load(name) {
    const s = this.list().find((x) => x.name === name);
    if (!s) return null;
    const parsed = parseSkill(readFileSync(join(s.path, 'SKILL.md'), 'utf8'));
    const refs = existsSync(join(s.path, 'references')) ? readdirSync(join(s.path, 'references')).slice(0, 20) : [];
    return { name, description: s.description, instructions: parsed.body, references: refs };
  }

  // Transport helpers (used to ship skills to the isolated agent container). Never follow symlinks.
  readDir(dir) { return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink() && !e.name.startsWith('.')).map((e) => ({ name: e.name, path: join(dir, e.name), isDirectory: e.isDirectory(), size: e.isFile() ? statSync(join(dir, e.name)).size : 0 })); }
  readFile(p) { return readFileSync(p); }

  // One compact line per skill for the system prompt.
  index(maxChars = 1400) {
    let out = ''; 
    for (const s of this.list()) { const line = `- ${s.name}: ${s.description}\n`; if (out.length + line.length > maxChars) break; out += line; }
    return out.trim();
  }

  // Install from a local folder after sanity checks (no symlinks, size cap, valid SKILL.md).
  install(srcDir, destRoot) {
    const src = resolve(srcDir);
    const skill = parseSkill(readFileSync(join(src, 'SKILL.md'), 'utf8'));
    if (!skill) throw new TypeError('invalid SKILL.md (needs name + description frontmatter)');
    let total = 0;
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (lstatSync(p).isSymbolicLink()) throw new TypeError('symlinks are not allowed in skills'); if (e.isDirectory()) walk(p); else { total += statSync(p).size; if (total > 5 * 1024 * 1024) throw new TypeError('skill too large'); } } };
    walk(src);
    if (basename(src) !== skill.name) { /* folder name may differ; installed under skill.name */ }
    mkdirSync(destRoot, { recursive: true, mode: 0o700 });
    const dest = join(resolve(destRoot), skill.name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    return { name: skill.name, hasScripts: existsSync(join(dest, 'scripts')) };
  }

  // Mirror all skills into a DSH home so the agent runtime sees them (own copy; nothing shared with the user's DSH).
  syncTo(dshSkillsDir) {
    mkdirSync(dshSkillsDir, { recursive: true, mode: 0o700 });
    for (const s of this.list()) { const dest = join(dshSkillsDir, s.name); rmSync(dest, { recursive: true, force: true }); cpSync(s.path, dest, { recursive: true }); }
  }
}
