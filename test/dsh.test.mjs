import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { DshAdapter } from '../src/dsh.mjs';

function makeBin(scriptBody) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-dsh-bin-'));
  const binPath = join(dir, 'dsh');
  writeFileSync(binPath, scriptBody, { mode: 0o755 });
  chmodSync(binPath, 0o755);
  return dir;
}

function withPath(prependDirs, fn) {
  const prev = process.env.PATH ?? '';
  process.env.PATH = [...prependDirs, prev].filter(Boolean).join(delimiter);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = prev;
    });
}

function isolatedPath(fn) {
  // A PATH with no `dsh` on it: single empty tmp dir, no inherited entries.
  const empty = mkdtempSync(join(tmpdir(), 'friday-dsh-empty-'));
  const prev = process.env.PATH ?? '';
  process.env.PATH = empty;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = prev;
      rmSync(empty, { recursive: true, force: true });
    });
}

test('missing binary returns failed without throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-dsh-home-'));
  try {
    await isolatedPath(async () => {
      const adapter = new DshAdapter({ homeDir: join(home, 'isolated'), timeoutMs: 2000 });
      assert.deepEqual(adapter.status(), { ready: false, reason: 'dsh_binary_missing' });
      const result = await adapter.run({ taskId: 't1', instruction: 'hello' });
      assert.deepEqual(result, { status: 'failed', error: 'dsh_binary_missing' });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('timeout maps to dsh_timeout', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-dsh-home-'));
  const binDir = makeBin('#!/bin/sh\nsleep 30\n');
  try {
    await withPath([binDir], async () => {
      const adapter = new DshAdapter({
        homeDir: join(home, 'isolated'),
        timeoutMs: 300,
        restrictedVerified: true,
      });
      const started = Date.now();
      const result = await adapter.run({ taskId: 't-timeout', instruction: 'hang' });
      assert.deepEqual(result, { status: 'failed', error: 'dsh_timeout' });
      assert.ok(Date.now() - started < 15000, 'timeout path must not wait out the child');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('AbortSignal cancellation rejects with AbortError', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-dsh-home-'));
  const binDir = makeBin('#!/bin/sh\nsleep 30\n');
  try {
    await withPath([binDir], async () => {
      const adapter = new DshAdapter({
        homeDir: join(home, 'isolated'),
        timeoutMs: 30000,
        restrictedVerified: true,
      });
      const controller = new AbortController();
      const pending = adapter.run({ taskId: 't-cancel', instruction: 'work', signal: controller.signal });
      setTimeout(() => controller.abort(new Error('user stop')), 200);
      await assert.rejects(pending, (err) => {
        assert.equal(err.name, 'AbortError');
        assert.ok(err.message.length > 0);
        return true;
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('output beyond maxOutputBytes is truncated with a marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-dsh-home-'));
  // Emit ~20 KiB of stdout; adapter limit is 1 KiB.
  const binDir = makeBin('#!/bin/sh\nyes ABCDEFGH | head -c 20000\n');
  try {
    await withPath([binDir], async () => {
      const adapter = new DshAdapter({
        homeDir: join(home, 'isolated'),
        timeoutMs: 10000,
        maxOutputBytes: 1024,
        restrictedVerified: true,
      });
      const result = await adapter.run({ taskId: 't-trunc', instruction: 'big' });
      assert.equal(result.status, 'completed');
      assert.match(result.output, /\[truncated/);
      assert.ok(Buffer.byteLength(result.output, 'utf8') <= 1024, `got ${Buffer.byteLength(result.output)} bytes`);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('child env is scrubbed except for the explicit allowlist; home stays isolated', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-dsh-home-'));
  // Probe file receives the RAW child env (`env` output) via a non-sensitive
  // passthrough var, bypassing the adapter's output redaction so the test
  // observes what the child really received. ALLOWLIST_OK proves allowlist
  // passthrough without echoing the secret itself (redaction would mask it).
  const binDir = makeBin(
    '#!/bin/sh\n' +
      'if [ -n "$FRIDAY_DSH_TEST_PROBE" ]; then env > "$FRIDAY_DSH_TEST_PROBE"; fi\n' +
      'echo "HOME=$HOME"; echo "DSH_HOME=$DSH_HOME"; echo "KEY=${NVIDIA_API_KEY:-empty}"; echo "DSHV=${DSH_SECRET_TOKEN:-empty}"\n' +
      'if [ "$NVIDIA_API_KEY" = "explicit-key-abc" ]; then echo ALLOWLIST_OK; fi\n',
  );
  const prevKey = process.env.NVIDIA_API_KEY;
  const prevDsh = process.env.DSH_SECRET_TOKEN;
  const prevProbe = process.env.FRIDAY_DSH_TEST_PROBE;
  process.env.NVIDIA_API_KEY = 'super-secret-12345';
  process.env.DSH_SECRET_TOKEN = 'dsh-secret-67890';
  const probeFile = join(home, 'probe.env');
  process.env.FRIDAY_DSH_TEST_PROBE = probeFile;
  try {
    await withPath([binDir], async () => {
      const isolatedHome = join(home, 'isolated');
      const scrubbed = new DshAdapter({
        homeDir: isolatedHome,
        timeoutMs: 10000,
        maxOutputBytes: 8192,
        restrictedVerified: true,
      });
      const out = await scrubbed.run({ taskId: 't-env', instruction: 'env' });
      assert.equal(out.status, 'completed');
      assert.match(out.output, new RegExp(`HOME=${isolatedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(out.output, /KEY=empty/);
      // Raw child env (unredacted): secrets stripped, isolated home set.
      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(probeFile, 'utf8');
      assert.ok(!raw.includes('super-secret-12345'), 'NVIDIA_API_KEY must be scrubbed');
      assert.ok(!raw.includes('dsh-secret-67890'), 'DSH_* must be scrubbed');
      assert.match(raw, new RegExp(`^HOME=${isolatedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

      const allowed = new DshAdapter({
        homeDir: isolatedHome,
        timeoutMs: 10000,
        maxOutputBytes: 8192,
        restrictedVerified: true,
        allowEnv: { NVIDIA_API_KEY: 'explicit-key-abc' },
      });
      const out2 = await allowed.run({ taskId: 't-env2', instruction: 'env' });
      assert.equal(out2.status, 'completed');
      assert.ok(out2.output.includes('ALLOWLIST_OK'), 'allowlisted value must reach the child');
      // Inherited secret must not leak via the allowlist path either.
      const raw2 = readFileSync(probeFile, 'utf8');
      assert.ok(!raw2.includes('super-secret-12345'), 'inherited secret must not leak via allowlist path');

      // Isolated home is created 0700 and never points at the personal config.
      const mode = statSync(isolatedHome).mode & 0o777;
      assert.equal(mode, 0o700);
      assert.ok(!isolatedHome.includes('.config/dsh'));
    });
  } finally {
    if (prevKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prevKey;
    if (prevDsh === undefined) delete process.env.DSH_SECRET_TOKEN;
    else process.env.DSH_SECRET_TOKEN = prevDsh;
    if (prevProbe === undefined) delete process.env.FRIDAY_DSH_TEST_PROBE;
    else process.env.FRIDAY_DSH_TEST_PROBE = prevProbe;
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('non-zero exit maps to failed without throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-dsh-home-'));
  const binDir = makeBin('#!/bin/sh\necho "provider overloaded" >&2\nexit 3\n');
  try {
    await withPath([binDir], async () => {
      const adapter = new DshAdapter({
        homeDir: join(home, 'isolated'),
        timeoutMs: 10000,
        restrictedVerified: true,
      });
      const result = await adapter.run({ taskId: 't-err', instruction: 'fail' });
      assert.equal(result.status, 'failed');
      assert.match(result.error, /dsh_exit_3/);
      assert.match(result.error, /provider overloaded/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});
