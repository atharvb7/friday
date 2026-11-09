// Deterministic verification of a proposed open-source change — no language model involved.
// In a fresh clone at the exact upstream commit: run the setup commands, run the targeted test BEFORE the change (a bug
// fix's new test must fail there), apply the patch with `git apply`, then run the targeted test, the full suite and the
// linter AFTER it. Fridayy only trusts what these exit codes say, never the coding agent's own report of its tests.
// Runs inside the agent container (the container is the sandbox) or locally through a sandbox `wrap`.
// The commands get a minimal environment: no Fridayy secrets, no GitHub token.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLONE_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\.git$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TAIL = 3000;
export const VERIFY_LIMITS = Object.freeze({ setupMs: 12 * 60_000, stepMs: 10 * 60_000, totalMs: 30 * 60_000, maxSetup: 6, maxCmd: 500 });

// Python projects run inside a fresh virtualenv that Fridayy creates and activates (Debian's system pip refuses installs,
// PEP 668), so the agent's own "make a venv / activate it" steps are dropped: its venv path does not exist in a clean clone.
const VENV_PART = /^\s*(?:(?:python3?|uv)\s+(?:-m\s+)?venv\b.*|(?:source|\.)\s+\S*bin\/activate\s*)$/;
export function normalizeCmd(c) {
  if (!c) return c;
  return c.split('&&').filter((part) => !VENV_PART.test(part)).join('&&').trim() || null;
}
const PY_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'requirements-dev.txt', 'tox.ini'];

function checkCmd(c, name) {
  if (c === null || c === undefined || c === '') return null;
  if (typeof c !== 'string' || c.length > VERIFY_LIMITS.maxCmd || /[\0\r\n]/.test(c)) throw new TypeError(`${name}: one shell command line (<= ${VERIFY_LIMITS.maxCmd} chars)`);
  return c.trim();
}

export function validateVerifyRequest(r, { allowUrl = (u) => CLONE_URL_RE.test(u) } = {}) {
  if (!allowUrl(String(r?.cloneUrl ?? ''))) throw new TypeError('cloneUrl must be https://github.com/<owner>/<repo>.git');
  if (!SHA_RE.test(String(r?.baseSha ?? ''))) throw new TypeError('baseSha must be a full 40-character commit sha');
  const repro = checkCmd(r.repro, 'repro');
  if (repro) { // issue mode: show the bug happens on the upstream commit, no change applied
    if (r.patch) throw new TypeError('repro mode takes no patch');
    const setup = Array.isArray(r.setup) ? r.setup : [];
    if (setup.length > VERIFY_LIMITS.maxSetup) throw new TypeError(`setup: at most ${VERIFY_LIMITS.maxSetup} commands`);
    const expect = typeof r.expect === 'string' ? r.expect.trim().slice(0, 300) : '';
    if (expect.length < 8) throw new TypeError('expect: the exact error text (>= 8 chars) the bug prints');
    return { cloneUrl: r.cloneUrl, baseSha: r.baseSha, setup: setup.map((c, i) => checkCmd(c, `setup[${i}]`)).filter(Boolean), repro, expect };
  }
  if (typeof r.patch !== 'string' || !r.patch.trim() || r.patch.length > 400_000) throw new TypeError('patch: a non-empty unified diff');
  const setup = Array.isArray(r.setup) ? r.setup : [];
  if (setup.length > VERIFY_LIMITS.maxSetup) throw new TypeError(`setup: at most ${VERIFY_LIMITS.maxSetup} commands`);
  const out = { cloneUrl: r.cloneUrl, baseSha: r.baseSha, patch: r.patch, setup: setup.map((c, i) => checkCmd(c, `setup[${i}]`)).filter(Boolean),
    test: checkCmd(r.test, 'test'), suite: checkCmd(r.suite, 'suite'), lint: checkCmd(r.lint, 'lint'), testBefore: r.testBefore !== false };
  if (!out.test && !out.suite) throw new TypeError('need a test or suite command');
  return out;
}

function run(cmd, args, { cwd, env, timeoutMs, wrap }) {
  const started = Date.now();
  const spec = wrap ? wrap(cmd, args, cwd) : { cmd, args };
  return new Promise((resolve) => {
    let out = '', killed = false;
    let child;
    try { child = spawn(spec.cmd, spec.args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ exit: -1, ms: 0, tail: `spawn failed: ${e.message}` }); return; }
    const keep = (c) => { out += c.toString('utf8'); if (out.length > TAIL * 4) out = out.slice(-TAIL * 2); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit: -1, ms: Date.now() - started, tail: `spawn failed: ${e.message}` }); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      resolve({ exit: killed ? 124 : (code ?? (sig ? 128 : -1)), ms: Date.now() - started, timed_out: killed || undefined, tail: out.slice(-TAIL) });
    });
  });
}

// -> { ok, verdict, steps: [{ name, cmd, exit, ms, tail }], error? }
// verdict: 'verified' | 'reproduced' (repro mode) | 'not_reproduced' (test passed before the change) | 'failing_after' | 'setup_failed' | 'patch_failed' | 'error'
export async function runVerify(request, { workRoot, id, wrap = null, passEnv = {}, limits = VERIFY_LIMITS, allowUrl } = {}) {
  const r = validateVerifyRequest(request, allowUrl ? { allowUrl } : {}); // allowUrl: tests only (local file:// repos)
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) throw new TypeError('invalid verify id');
  const root = join(workRoot, '_verify', id);
  const repo = join(root, 'repo');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  const env = { ...passEnv, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', CI: '1',
    GIT_TERMINAL_PROMPT: '0', npm_config_cache: join(root, 'home', '.npm'), npm_config_audit: 'false', npm_config_fund: 'false', PIP_CACHE_DIR: join(root, 'home', '.pip'), PYTHONDONTWRITEBYTECODE: '1' };
  const steps = [];
  const deadline = Date.now() + limits.totalMs;
  const left = (ms) => Math.max(1000, Math.min(ms, deadline - Date.now()));
  const step = async (name, cmd, args, timeoutMs, cwd = repo) => {
    const res = await run(cmd, args, { cwd, env, timeoutMs: left(timeoutMs), wrap });
    const s = { name, cmd: cmd === 'bash' ? args[1] : [cmd, ...args].join(' '), ...res };
    steps.push(s);
    return s;
  };
  const sh = (name, c, ms) => step(name, 'bash', ['-c', c], ms); // bash: agents write `source x` and other bashisms
  try {
    for (const [n, a] of [['git_init', ['init', '-q']], ['git_remote', ['remote', 'add', 'origin', r.cloneUrl]], ['git_fetch', ['fetch', '-q', '--depth', '1', 'origin', r.baseSha]], ['git_checkout', ['checkout', '-q', 'FETCH_HEAD']]]) {
      const s = await step(n, 'git', a, 5 * 60_000);
      if (s.exit !== 0) return { ok: false, verdict: 'error', steps, error: `${n} failed` };
    }
    if (PY_MARKERS.some((f) => existsSync(join(repo, f)))) {
      const venv = join(root, 'venv');
      const s = await step('python_venv', 'python3', ['-m', 'venv', venv], 2 * 60_000);
      if (s.exit === 0) Object.assign(env, { VIRTUAL_ENV: venv, PATH: `${join(venv, 'bin')}:${env.PATH}` });
    }
    for (const [i, raw] of r.setup.entries()) {
      const c = normalizeCmd(raw);
      if (!c) continue;
      const s = await sh(`setup_${i + 1}`, c, limits.setupMs);
      if (s.exit !== 0) return { ok: false, verdict: 'setup_failed', steps, error: `setup command failed: ${c}` };
    }
    for (const k of ['repro', 'test', 'suite', 'lint']) if (r[k]) r[k] = normalizeCmd(r[k]) ?? r[k];
    if (r.repro) {
      const s = await sh('repro', r.repro, limits.stepMs);
      const seen = s.exit !== 0 && !s.timed_out && s.tail.includes(r.expect);
      return seen ? { ok: true, verdict: 'reproduced', steps } : { ok: false, verdict: 'not_reproduced', steps, error: s.exit === 0 ? 'the command succeeded on the upstream commit' : 'the command failed, but without the expected error text' };
    }
    let before = null;
    if (r.test && r.testBefore) before = await sh('test_before', r.test, limits.stepMs);
    const patchFile = join(root, 'change.patch');
    writeFileSync(patchFile, r.patch.endsWith('\n') ? r.patch : `${r.patch}\n`);
    const check = await step('apply_check', 'git', ['apply', '--check', '--whitespace=nowarn', patchFile], 60_000);
    if (check.exit !== 0) return { ok: false, verdict: 'patch_failed', steps, error: 'the patch does not apply to the upstream commit' };
    const apply = await step('apply', 'git', ['apply', '--whitespace=nowarn', patchFile], 60_000);
    if (apply.exit !== 0) return { ok: false, verdict: 'patch_failed', steps, error: 'git apply failed' };
    const after = r.test ? await sh('test_after', r.test, limits.stepMs) : null;
    const suite = r.suite && r.suite !== r.test ? await sh('suite_after', r.suite, limits.stepMs) : null;
    const lint = r.lint ? await sh('lint_after', r.lint, limits.stepMs) : null;
    if (before && before.exit === 0) return { ok: false, verdict: 'not_reproduced', steps, error: 'the targeted test already passes without the change, so it does not prove the fix' };
    if ((after && after.exit !== 0) || (suite && suite.exit !== 0)) return { ok: false, verdict: 'failing_after', steps, error: 'tests fail with the change applied' };
    if (lint && lint.exit !== 0) return { ok: false, verdict: 'failing_after', steps, error: 'the linter fails with the change applied' };
    return { ok: true, verdict: 'verified', steps };
  } catch (e) {
    return { ok: false, verdict: 'error', steps, error: String(e.message).slice(0, 300) };
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
