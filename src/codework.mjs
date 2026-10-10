// src/codework.mjs — isolated coding workspaces under data/workspaces/<uuid>.
//
// Safety rules (v1):
// - Every workspace is a fresh directory named by randomUUID() directly under
//   the base dir (default <appRoot>/data/workspaces).
// - All file paths go through the same confinement as tools.mjs: prefix guard
//   plus a realpath check, so traversal (`..`) and symlink escapes are
//   rejected. Workspace ids are restricted to `[A-Za-z0-9_-]` so `..`, `/`,
//   and absolute paths can never address another workspace.
// - gitDiff runs `git diff --no-color` via spawnSync with shell:false. No
//   network is ever used (purely local diff, GIT_TERMINAL_PROMPT=0).
// - runTests only runs an exact allowlist (`npm test`, `node --test`,
//   `python3 -m pytest -q`) via spawnSync with shell:false. Any shell
//   metacharacters are rejected before the allowlist lookup. Output is
//   capped at 32KB, default timeout 60s, and a pre-aborted AbortSignal throws
//   instead of running.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confineToWorkspace } from './tools.mjs';

export const MAX_FILE_READ_BYTES = 65536;
export const MAX_FILE_WRITE_BYTES = 1048576;
export const MAX_TEST_OUTPUT_BYTES = 32768;
export const TEST_TIMEOUT_MS = 60000;
export const GIT_DIFF_TIMEOUT_MS = 15000;

const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

// Exact command strings mapped to argv (run with shell:false, never a shell).
const ALLOWED_COMMANDS = new Map([
  ['npm test', ['npm', 'test']],
  ['node --test', ['node', '--test']],
  ['python3 -m pytest -q', ['python3', '-m', 'pytest', '-q']],
]);

// Rejected before the allowlist lookup; none of these appear in allowlisted
// commands, so legitimate calls never trip this check.
const SHELL_METACHARS_RE = /[;&|`$()<>\\\n\r'"#*?!~{}[\]]/;

function defaultBaseDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'workspaces');
}

function capOutput(text, max = MAX_TEST_OUTPUT_BYTES) {
  const input = typeof text === 'string' ? text : '';
  const buf = Buffer.from(input, 'utf8');
  if (buf.length <= max) return { text: input, truncated: false };
  return { text: buf.subarray(0, max).toString('utf8'), truncated: true };
}

export class CodeWork {
  constructor({ baseDir = null } = {}) {
    if (baseDir !== null && baseDir !== undefined) {
      if (typeof baseDir !== 'string' || !baseDir.trim() || baseDir.includes('\0')) {
        throw new TypeError('invalid baseDir');
      }
      this.baseDir = resolve(baseDir.trim());
    } else {
      this.baseDir = defaultBaseDir();
    }
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
  }

  createWorkspace() {
    const id = randomUUID();
    const dir = join(this.baseDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { id, path: realpathSync(dir) };
  }

  resolveWorkspaceDir(workspaceId) {
    if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) {
      throw new TypeError('invalid workspace id');
    }
    const resolved = resolve(this.baseDir, workspaceId);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + sep)) {
      throw new TypeError('workspace escapes base dir');
    }
    let real;
    try {
      real = realpathSync(resolved);
    } catch {
      throw new TypeError('unknown workspace');
    }
    if (real !== this.baseDir && !real.startsWith(this.baseDir + sep)) {
      throw new TypeError('workspace escapes base dir (symlink)');
    }
    let st;
    try {
      st = statSync(real);
    } catch {
      throw new TypeError('unknown workspace');
    }
    if (!st.isDirectory()) throw new TypeError('workspace is not a directory');
    // Direct children only: the id itself must be the final segment.
    if (dirname(real) !== realpathSync(this.baseDir)) throw new TypeError('invalid workspace id');
    return real;
  }

  writeFile(workspaceId, relPath, content) {
    const dir = this.resolveWorkspaceDir(workspaceId);
    const confined = confineToWorkspace(dir, relPath);
    if (typeof content !== 'string' || content.length > MAX_FILE_WRITE_BYTES) {
      throw new TypeError(`content must be a string up to ${MAX_FILE_WRITE_BYTES} chars`);
    }
    mkdirSync(dirname(confined.absolute), { recursive: true, mode: 0o700 });
    // Re-check after creating parents: a pre-existing symlink in the new
    // parent chain could otherwise redirect the write outside the workspace.
    const rechecked = confineToWorkspace(dir, relPath);
    writeFileSync(rechecked.absolute, content, { mode: 0o600 });
    return { workspaceId, path: rechecked.relative, bytes: Buffer.byteLength(content, 'utf8') };
  }

  readFile(workspaceId, relPath, maxBytes = 8192) {
    const dir = this.resolveWorkspaceDir(workspaceId);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_READ_BYTES) {
      throw new TypeError(`maxBytes must be 1..${MAX_FILE_READ_BYTES}`);
    }
    const confined = confineToWorkspace(dir, relPath);
    const fd = openSync(confined.absolute, 'r');
    try {
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) throw new TypeError('path is not a file');
      const toRead = Math.min(fileStat.size, maxBytes);
      const buffer = Buffer.alloc(toRead);
      if (toRead > 0) readSync(fd, buffer, 0, toRead, 0);
      return {
        workspaceId,
        path: confined.relative,
        bytes: buffer.toString('utf8'),
        truncated: fileStat.size > toRead,
        previewHash: createHash('sha256').update(buffer).digest('hex'),
      };
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Closing is best effort; the read already completed or threw.
      }
    }
  }

  gitDiff(workspaceId) {
    const dir = this.resolveWorkspaceDir(workspaceId);
    const started = Date.now();
    const result = spawnSync('git', ['diff', '--no-color'], {
      cwd: dir,
      timeout: GIT_DIFF_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error) throw new Error(`git diff failed: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`git diff failed: ${(result.stderr ?? '').trim().slice(0, 500)}`);
    }
    const capped = capOutput(result.stdout ?? '');
    return { workspaceId, diff: capped.text, truncated: capped.truncated, durationMs: Date.now() - started };
  }

  runTests(workspaceId, command, { timeoutMs = TEST_TIMEOUT_MS, signal = null } = {}) {
    const dir = this.resolveWorkspaceDir(workspaceId);
    if (typeof command !== 'string' || !command.trim() || command.length > 200) {
      throw new TypeError('invalid command');
    }
    if (signal !== null && signal !== undefined) {
      if (typeof signal !== 'object' || typeof signal.aborted !== 'boolean') {
        throw new TypeError('invalid signal');
      }
      if (signal.aborted) throw (signal.reason ?? new Error('aborted'));
    }
    if (SHELL_METACHARS_RE.test(command)) throw new TypeError('command contains shell metacharacters');
    const argv = ALLOWED_COMMANDS.get(command.trim());
    if (!argv) throw new TypeError('command not allowlisted');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) {
      throw new TypeError('timeoutMs must be 50..120000');
    }
    const started = Date.now();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: dir,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const durationMs = Date.now() - started;
    if (result.error && !result.signal && result.status === null) {
      throw new Error(`test spawn failed: ${result.error.message}`);
    }
    const out = capOutput(result.stdout ?? '');
    const err = capOutput(result.stderr ?? '');
    // spawnSync kills with SIGTERM on timeout; treat a termination signal that
    // arrives at/after the deadline as a timeout rather than a crash.
    const timedOut = result.signal != null && durationMs + 25 >= timeoutMs;
    return {
      workspaceId,
      command: command.trim(),
      argv: [...argv],
      status: result.status,
      signal: result.signal,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      timedOut,
      durationMs,
    };
  }
}
