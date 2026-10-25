// Skills: folders with SKILL.md (frontmatter: name, description). Shipped skills
// live in <repo>/skills, user-installed ones in <data>/skills. They are loaded
// only when relevant: the model sees a one-line index, then calls skill_load.
// The same folders are synced into Friday's DSH home so the background agent
// sees them natively.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const MAX_SKILL_BYTES = 256 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const REF_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.(md|txt|json|csv)$/i;
const MAX_REF_CHARS = 40_000;
const BRIEF_MAX = 120;
const refDir = (p) => ['references', 'reference'].map((d) => join(p, d)).find((d) => existsSync(d) && !lstatSync(d).isSymbolicLink() && statSync(d).isDirectory()) ?? null;
// "When the user wants X. Also use when..." -> "When the user wants X"
const brief = (d) => { const first = String(d).split(/(?<=[.!?])\s+|\s+Use (?:when|this|for)\b/)[0].replace(/[.!?]$/, ''); return first.length > BRIEF_MAX ? `${first.slice(0, BRIEF_MAX - 1).replace(/\s+\S*$/, '')}…` : first; };

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
    const dir = refDir(s.path);
    const refs = dir ? readdirSync(dir).filter((f) => REF_RE.test(f)).slice(0, 30) : [];
    return { name, description: s.description, instructions: parsed.body, references: refs, ...(refs.length ? { references_hint: 'Open one with skill_load {name, reference}.' } : {}) };
  }

  // One reference file of a skill (references/ or reference/), by bare file name only.
  reference(name, file) {
    const s = this.list().find((x) => x.name === name);
    if (!s) return null;
    const dir = refDir(s.path); const f = String(file ?? '').trim();
    if (!dir || !REF_RE.test(f)) return { error: 'reference_not_found' };
    const p = join(dir, f);
    if (!existsSync(p) || lstatSync(p).isSymbolicLink() || !statSync(p).isFile()) return { error: 'reference_not_found', available: readdirSync(dir).filter((x) => REF_RE.test(x)).slice(0, 30) };
    const text = readFileSync(p, 'utf8');
    return { name, reference: f, text: text.slice(0, MAX_REF_CHARS), ...(text.length > MAX_REF_CHARS ? { truncated: true } : {}) };
  }

  // Transport helpers (used to ship skills to the isolated agent container). Never follow symlinks.
  readDir(dir) { return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink() && !e.name.startsWith('.')).map((e) => ({ name: e.name, path: join(dir, e.name), isDirectory: e.isDirectory(), size: e.isFile() ? statSync(join(dir, e.name)).size : 0 })); }
  readFile(p) { return readFileSync(p); }

  // One compact line per skill for the system prompt: the description's first sentence, clipped, so every
  // skill stays visible (the full description and body arrive with skill_load).
  index(maxChars = 5000) {
    let out = '';
    for (const s of this.list()) { const line = `- ${s.name}: ${brief(s.description)}\n`; if (out.length + line.length > maxChars) break; out += line; }
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
