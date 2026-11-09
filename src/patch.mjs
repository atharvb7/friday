// Unified diffs (git diff output) for open-source contributions: parse, check against the contribution policy, and
// apply to the real upstream files. Applying is strict: every context and removed line must match the original exactly
// at the stated line, so the change Fridayy commits is exactly the diff the owner approved. No fuzz, no offsets.
import { createHash } from 'node:crypto';

export const PATCH_LIMITS = Object.freeze({ maxFiles: 8, maxChangedLines: 400, maxPatchBytes: 200_000 });
// Paths a contribution never touches: CI, lockfiles, licences, release metadata, vendored code, secrets.
const FORBIDDEN = [
  /^\.github\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//, /^\.travis\.yml$/, /^azure-pipelines\.yml$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|bun\.lockb)$/,
  /(^|\/)(LICEN[CS]E|COPYING|NOTICE)(\.[a-z]+)?$/i, /(^|\/)CODEOWNERS$/, /(^|\/)(CHANGELOG|HISTORY)(\.[a-z]+)?$/i,
  /(^|\/)(node_modules|vendor|third_party|dist|build)\//, /(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx)$/i,
];
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DOC_PATH = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;
// Credentials that must never leave in a public PR.
const SECRET_RE = /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|nvapi-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abp]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

const unquote = (p) => (p.startsWith('"') ? JSON.parse(p) : p);
const stripPrefix = (p) => (p === '/dev/null' ? null : unquote(p).replace(/^[ab]\//, ''));

// -> [{ path, oldPath, newPath, isNew, isDeleted, hunks: [{ oldStart, oldLines, newStart, newLines, lines: [{op:' '|'-'|'+', text, noEol}] }] }]
export function parsePatch(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) throw new Error('empty_patch');
  if (Buffer.byteLength(src) > PATCH_LIMITS.maxPatchBytes) throw new Error('patch_too_large');
  const lines = src.split('\n');
  const files = [];
  let f = null, h = null;
  const finishHunk = () => {
    if (!h) return;
    const old = h.lines.filter((l) => l.op !== '+').length, neu = h.lines.filter((l) => l.op !== '-').length;
    if (old !== h.oldLines || neu !== h.newLines) throw new Error(`hunk_counts_wrong in ${f.path} @@ -${h.oldStart}`);
    h = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      finishHunk();
      f = { path: null, oldPath: null, newPath: null, isNew: false, isDeleted: false, hunks: [] };
      files.push(f);
      continue;
    }
    if (!f) { if (!line.trim()) continue; throw new Error('patch_must_start_with_diff_git'); }
    if (h) {
      if (line.startsWith('\\ No newline at end of file')) { const last = h.lines.at(-1); if (last) last.noEol = true; continue; }
      const op = line[0];
      const oldSoFar = h.lines.filter((l) => l.op !== '+').length, newSoFar = h.lines.filter((l) => l.op !== '-').length;
      const room = { ' ': oldSoFar < h.oldLines && newSoFar < h.newLines, '-': oldSoFar < h.oldLines, '+': newSoFar < h.newLines };
      if ((op === ' ' || op === '-' || op === '+') && room[op]) { h.lines.push({ op, text: line.slice(1), noEol: false }); continue; }
      if (line === '' && room[' ']) { h.lines.push({ op: ' ', text: '', noEol: false }); continue; } // some tools drop the space on empty context lines
      finishHunk();
    }
    if (/^(old|new) mode |^similarity index |^rename (from|to) |^copy (from|to) /.test(line)) throw new Error(`unsupported_change (${line.split(' ').slice(0, 2).join(' ')}): renames and mode changes are not allowed`);
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) throw new Error('binary_change_not_allowed');
    if (line.startsWith('new file mode ')) { f.isNew = true; continue; }
    if (line.startsWith('deleted file mode ')) { f.isDeleted = true; continue; }
    if (line.startsWith('index ')) continue;
    if (line.startsWith('--- ')) { f.oldPath = stripPrefix(line.slice(4).replace(/\t.*$/, '')); continue; }
    if (line.startsWith('+++ ')) { f.newPath = stripPrefix(line.slice(4).replace(/\t.*$/, '')); f.path = f.newPath ?? f.oldPath; continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      if (!f.path) throw new Error('hunk_before_file_header');
      h = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!line.trim()) continue;
    throw new Error(`unexpected_patch_line: ${line.slice(0, 80)}`);
  }
  finishHunk();
  for (const x of files) {
    if (!x.path) throw new Error('file_without_path');
    if (x.oldPath && x.newPath && x.oldPath !== x.newPath) throw new Error('renames_not_allowed');
    if (!x.hunks.length && !x.isDeleted) throw new Error(`no_hunks for ${x.path}`);
  }
  if (!files.length) throw new Error('empty_patch');
  return files;
}

// Contribution policy. kind 'fix' needs a test file; 'docs' may only touch documentation; 'revision' (follow-up commit on an open PR) has no test rule.
export function checkPatchPolicy(files, { kind = 'fix', limits = PATCH_LIMITS } = {}) {
  const problems = [];
  if (files.length > limits.maxFiles) problems.push(`too many files (${files.length} > ${limits.maxFiles}); keep the change focused`);
  let changed = 0;
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.path)) problems.push(`${f.path} appears twice`);
    seen.add(f.path);
    if (/(^|\/)\.\.(\/|$)|^\//.test(f.path) || /[\0\r]/.test(f.path)) problems.push(`unsafe path ${f.path}`);
    if (FORBIDDEN.some((re) => re.test(f.path))) problems.push(`${f.path} must not be changed by a contribution (CI, lockfile, licence, changelog, vendored or secret file)`);
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.op !== ' ') changed++;
      if (l.op === '+' && SECRET_RE.test(l.text)) problems.push(`${f.path} adds what looks like a credential`);
      if (l.op === '+' && /[‪-‮⁦-⁩]/.test(l.text)) problems.push(`${f.path} adds hidden text-direction characters`);
    }
  }
  if (changed > limits.maxChangedLines) problems.push(`too many changed lines (${changed} > ${limits.maxChangedLines}); keep the change small`);
  const tests = files.some((f) => TEST_PATH.test(f.path));
  if (kind === 'fix' && !tests) problems.push('a fix must add or update a test that fails before the fix and passes after');
  if (kind === 'docs' && files.some((f) => !DOC_PATH.test(f.path))) problems.push('a docs change may only touch documentation files');
  return { ok: problems.length === 0, problems: [...new Set(problems)], changedLines: changed, testsTouched: tests };
}

// Apply one file's hunks to its original text (null for a new file). Returns the new text, or null for a deletion.
export function applyFilePatch(original, f) {
  if (f.isNew && original !== null && original !== undefined) throw new Error(`${f.path}: marked new but already exists upstream`);
  if (!f.isNew && (original === null || original === undefined)) throw new Error(`${f.path}: does not exist upstream`);
  const src = f.isNew ? '' : String(original);
  const hadEol = src === '' || src.endsWith('\n');
  const old = src === '' ? [] : (hadEol ? src.slice(0, -1) : src).split('\n');
  const out = [];
  let pos = 0; // index into old
  let newEol = hadEol;
  for (const h of f.hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < pos || start > old.length) throw new Error(`${f.path}: hunk @@ -${h.oldStart} is out of order or out of range`);
    while (pos < start) out.push(old[pos++]);
    for (const l of h.lines) {
      if (l.op === '+') { out.push(l.text); if (l.noEol) newEol = false; else if (pos >= old.length) newEol = true; continue; }
      if (old[pos] !== l.text) throw new Error(`${f.path}: line ${pos + 1} does not match the patch (expected ${JSON.stringify(l.text.slice(0, 60))}, upstream has ${JSON.stringify(String(old[pos] ?? '<end of file>').slice(0, 60))})`);
      if (l.op === ' ') { out.push(old[pos]); if (l.noEol) newEol = false; }
      pos++;
    }
  }
  while (pos < old.length) out.push(old[pos++]);
  if (f.isDeleted) { if (out.length) throw new Error(`${f.path}: deletion leaves lines behind`); return null; }
  if (!out.length) return '';
  return out.join('\n') + (newEol ? '\n' : '');
}

// The diff as a reviewer reads it: changed lines only plus context, capped for an approval card.
export function patchStats(files) {
  let add = 0, del = 0;
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) { if (l.op === '+') add++; else if (l.op === '-') del++; }
  return { files: files.map((f) => f.path), additions: add, deletions: del };
}
