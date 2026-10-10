// DSH execution adapter for Friday Core.
//
// SAFETY ASSUMPTION (must be honoured by the server):
//   The server MUST keep this adapter disabled — i.e. treat status() as
//   { ready: false } — until a restricted DSH profile has been explicitly
//   verified (no shell/browser/network privileges beyond the Friday policy).
//   This file defaults `restrictedVerified: false`, so status() reports
//   `dsh_profile_not_verified` until the caller opts in with
//   `new DshAdapter({ ..., restrictedVerified: true })` after that check.
//   Wiring a verified adapter into WorkerLoop is what flips /v1/status dsh:true.
//
// CLI ASSUMPTIONS (no live `dsh` binary was available while writing this):
//   - Binary is resolved via PATH as `dsh` (or explicit `dshPath` override).
//   - Invocation is headless through a named profile:
//       dsh --profile <profile> run --headless --no-browser --no-shell [--model <model>]
//     with the task instruction piped on stdin (avoids argv/ps exposure and
//     ARG_MAX issues). `--no-browser --no-shell` are best-effort restricted-
//     tool flags: they are always passed; if a future `dsh` rejects unknown
//     flags the child exits non-zero and run() maps it to a failed result
//     (never throws), so verification will surface the mismatch instead of
//     silently granting tools.
//   - Success = exit 0; stdout is the task output. Non-zero exit = failure;
//     stderr tail is passed through as the error after secret redaction.
//   - Isolation uses Friday-owned homes only: HOME, DSH_HOME and
//     DSH_AGENTS_HOME all point inside the provided `homeDir`. The global
//     ~/.config/dsh and personal sessions are never referenced.
//
// SECRET HANDLING:
//   - Child env is scrubbed: NVIDIA_API_KEY and any DSH_* entry inherited
//     from process.env are removed, except keys explicitly supplied via the
//     `allowEnv` allowlist object ({ NAME: value }). Only `allowEnv` values
//     plus the isolated home overrides are added back.
//   - Secrets are never logged. Returned output/error strings are redacted:
//     any known secret value is replaced with "[redacted]" before return.
//   - Callers must rotate any previously exposed NVIDIA key before reuse
//     (see handoff notes); this adapter cannot fix a leaked key, it only
//     avoids leaking further.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const KILL_GRACE_MS = 5_000;
const TRUNCATION_MARKER = '\n[truncated: output exceeded maxOutputBytes]\n';

// Names inherited from the parent env that must never reach the child
// unless explicitly listed in the `allowEnv` allowlist.
function isSensitiveName(name) {
  return name === 'NVIDIA_API_KEY' || name.startsWith('DSH_');
}

function collectSecretValues(extra = {}) {
  const values = new Set();
  for (const [k, v] of Object.entries(process.env)) {
    if (isSensitiveName(k) && typeof v === 'string' && v.length > 0) values.add(v);
  }
  for (const v of Object.values(extra)) {
    if (typeof v === 'string' && v.length > 0) values.add(v);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('[redacted]');
  }
  return out;
}

function truncateBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const markerBuf = Buffer.from(TRUNCATION_MARKER, 'utf8');
  const keep = Math.max(0, maxBytes - markerBuf.length);
  return buf.subarray(0, keep).toString('utf8') + TRUNCATION_MARKER;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function abortError(message = 'dsh_cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export class DshAdapter {
  constructor({ homeDir, profile, model, timeoutMs, maxOutputBytes, allowEnv, dshPath, restrictedVerified } = {}) {
    if (!homeDir || typeof homeDir !== 'string') throw new TypeError('homeDir is required');
    this.homeDir = homeDir;
    this.profile = profile ?? 'friday-restricted';
    this.model = model ?? null;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    // Explicit allowlist of env secrets to inject (e.g. { NVIDIA_API_KEY: '...' }).
    // Anything not listed here is stripped from the child env.
    this.allowEnv = { ...(allowEnv ?? {}) };
    this.dshPath = dshPath ?? null;
    this.restrictedVerified = restrictedVerified ?? false;

    // Isolated Friday home: create with 0700 if missing, always enforce 0700.
    mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    chmodSync(this.homeDir, 0o700);
  }

  resolveBinary() {
    if (this.dshPath) return isExecutable(this.dshPath) ? this.dshPath : null;
    // Honour PATH at call time so tests can override it with a fake `dsh`.
    // Spawn without shell so PATH lookup happens in the child_process layer;
    // pre-resolve here for an honest status()/run() without throwing.
    const fromPath = findOnPath('dsh');
    if (fromPath) return fromPath;
    // Fallback: probe `dsh --version` via PATH lookup (covers hashed shims).
    try {
      const probed = spawnSync('dsh', ['--version'], { stdio: 'ignore', timeout: 5000 });
      if (!probed.error) return 'dsh';
    } catch {
      // fall through to null
    }
    return null;
  }

  status() {
    try {
      const bin = this.resolveBinary();
      if (!bin) return { ready: false, reason: 'dsh_binary_missing' };
      if (!this.restrictedVerified) return { ready: false, reason: 'dsh_profile_not_verified' };
      return { ready: true };
    } catch {
      return { ready: false, reason: 'dsh_status_error' };
    }
  }

  buildChildEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (isSensitiveName(k)) continue;
      if (typeof v === 'string') env[k] = v;
    }
    // Explicit allowlist wins over the scrub.
    for (const [k, v] of Object.entries(this.allowEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
    // Isolated Friday home only — never ~/.config/dsh or personal sessions.
    env.HOME = this.homeDir;
    env.DSH_HOME = this.homeDir;
    env.DSH_AGENTS_HOME = join(this.homeDir, 'agents');
    return env;
  }

  buildArgs() {
    const args = ['--profile', String(this.profile), 'run', '--headless', '--no-browser', '--no-shell'];
    if (this.model) args.push('--model', String(this.model));
    return args;
  }

  run({ taskId, instruction, signal } = {}) {
    const binary = this.resolveBinary();
    if (!binary) return Promise.resolve({ status: 'failed', error: 'dsh_binary_missing' });
    if (signal?.aborted) return Promise.reject(abortError(signal.reason?.message ?? 'dsh_cancelled'));

    const secrets = collectSecretValues(this.allowEnv);
    const args = this.buildArgs();
    const childEnv = this.buildChildEnv();
    const timeoutMs = this.timeoutMs;
    const maxBytes = this.maxOutputBytes;

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(binary, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ status: 'failed', error: redact(`dsh_spawn_failed: ${err.message ?? err}`, secrets).slice(0, maxBytes) });
        return;
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      // Cap buffered bytes well above the return limit so error tails stay useful.
      const bufferCap = maxBytes * 4 + 4096;

      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      let graceTimer = null;
      let timeoutReportTimer = null;
      let abortRejectTimer = null;
      const cleanup = () => {
        clearTimeout(killTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (timeoutReportTimer) clearTimeout(timeoutReportTimer);
        if (abortRejectTimer) clearTimeout(abortRejectTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const killChild = (sig) => {
        try {
          if (child.exitCode === null) child.kill(sig);
        } catch {
          // ignore kill errors; exit handler reports the outcome
        }
      };

      const killTimer = setTimeout(() => {
        killChild('SIGTERM');
        // SIGTERM grace, then SIGKILL; report timeout (do not throw).
        graceTimer = setTimeout(() => killChild('SIGKILL'), KILL_GRACE_MS);
        // If the child ignores both signals, force the timeout report.
        timeoutReportTimer = setTimeout(() => {
          finishResolve({ status: 'failed', error: 'dsh_timeout' });
        }, KILL_GRACE_MS + 100);
      }, timeoutMs);

      const onAbort = () => {
        killChild('SIGTERM');
        graceTimer = setTimeout(() => killChild('SIGKILL'), KILL_GRACE_MS);
        // Worker contract: cancellation rejects with AbortError.
        // Wait briefly for the child to die, then reject.
        abortRejectTimer = setTimeout(() => finishReject(abortError(signal.reason?.message ?? 'dsh_cancelled')), 50);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        if (stdoutBytes < bufferCap) {
          stdout += s.slice(0, Math.max(0, bufferCap - stdoutBytes));
          stdoutBytes += Buffer.byteLength(s);
        }
      });
      child.stderr.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        if (stderrBytes < bufferCap) {
          stderr += s.slice(0, Math.max(0, bufferCap - stderrBytes));
          stderrBytes += Buffer.byteLength(s);
        }
      });
      child.on('error', (err) => {
        finishResolve({ status: 'failed', error: redact(`dsh_spawn_failed: ${err.message ?? err}`, secrets).slice(0, maxBytes) });
      });
      child.on('close', (code, sig) => {
        if (settled) return;
        if (signal?.aborted) {
          finishReject(abortError(signal.reason?.message ?? 'dsh_cancelled'));
          return;
        }
        if (sig) {
          // Killed by timeout path already handles reporting; otherwise map signals.
          finishResolve({ status: 'failed', error: 'dsh_timeout' });
          return;
        }
        if (code === 0) {
          finishResolve({ status: 'completed', output: truncateBytes(redact(stdout, secrets), maxBytes) });
        } else {
          const tail = redact(stderr.trim() || stdout.trim(), secrets);
          const label = `dsh_exit_${code ?? 'unknown'}`;
          const error = tail ? `${label}: ${tail}` : label;
          finishResolve({ status: 'failed', error: truncateBytes(error, maxBytes) });
        }
      });

      // Instruction via stdin (never argv). Task id is not passed to the
      // binary; it only scopes the Friday-side call. stdin errors (e.g.
      // EPIPE when a fast-exiting child never reads stdin) are benign.
      void taskId;
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(String(instruction ?? ''));
        child.stdin.end();
      } catch (err) {
        finishResolve({ status: 'failed', error: redact(`dsh_stdin_failed: ${err.message ?? err}`, secrets).slice(0, maxBytes) });
      }
    });
  }
}
