// test/codework.test.mjs — coverage for isolated coding workspaces:
// traversal blocked, symlink escape blocked, allowlist enforced, diff works,
// timeout + output caps, happy-path isolation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeWork } from '../src/codework.mjs';

function makeWork() {
  const baseDir = mkdtempSync(join(tmpdir(), 'friday-codework-'));
  return { baseDir, work: new CodeWork({ baseDir }), cleanup: () => rmSync(baseDir, { recursive: true, force: true }) };
}

function gitInit(dir) {
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000 });
  assert.equal(run(['init']).status, 0);
  assert.equal(run(['config', 'user.email', 'test@example.com']).status, 0);
  assert.equal(run(['config', 'user.name', 'Test']).status, 0);
  assert.equal(run(['add', '-A']).status, 0);
  assert.equal(run(['commit', '-m', 'init']).status, 0);
}

test('createWorkspace isolates: distinct dirs, files invisible across workspaces', () => {
  const { work, cleanup } = makeWork();
  try {
    const a = work.createWorkspace();
    const b = work.createWorkspace();
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.path, b.path);
    work.writeFile(a.id, 'hello.txt', 'hi a');
    // Missing in the sibling workspace: surfaces ENOENT (same as file.read
    // in tools.mjs for a nonexistent path), proving no cross-visibility.
    assert.throws(() => work.readFile(b.id, 'hello.txt'), /ENOENT/);
    const back = work.readFile(a.id, 'hello.txt');
    assert.equal(back.bytes, 'hi a');
    assert.equal(back.truncated, false);
    assert.match(back.previewHash, /^[0-9a-f]{64}$/);
  } finally {
    cleanup();
  }
});

test('writeFile/readFile block traversal and absolute escapes', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    assert.throws(() => work.writeFile(ws.id, '../evil.txt', 'x'), TypeError);
    assert.throws(() => work.writeFile(ws.id, '../../evil.txt', 'x'), TypeError);
    assert.throws(() => work.writeFile(ws.id, '/etc/passwd', 'x'), TypeError);
    assert.throws(() => work.readFile(ws.id, '..'), TypeError);
    assert.throws(() => work.readFile(ws.id, '/etc/hostname'), TypeError);
    assert.throws(() => work.writeFile('..', 'evil.txt', 'x'), TypeError);
  } finally {
    cleanup();
  }
});

test('symlink escape is blocked for read and write', () => {
  const { baseDir, work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    const outside = join(baseDir, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(ws.path, 'link.txt'));
    assert.throws(() => work.readFile(ws.id, 'link.txt'), TypeError);
    symlinkSync('/etc', join(ws.path, 'etclink'));
    assert.throws(() => work.writeFile(ws.id, 'etclink/evil.txt', 'x'), TypeError);
  } finally {
    cleanup();
  }
});

test('runTests enforces the allowlist and rejects shell metacharacters', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    assert.throws(() => work.runTests(ws.id, 'rm -rf /'), TypeError);
    assert.throws(() => work.runTests(ws.id, 'node -e "process.exit(0)"'), TypeError);
    assert.throws(() => work.runTests(ws.id, 'npm test; echo pwned'), TypeError);
    assert.throws(() => work.runTests(ws.id, 'npm test | tee out'), TypeError);
    assert.throws(() => work.runTests(ws.id, 'npm test && echo pwned'), TypeError);
    assert.throws(() => work.runTests(ws.id, '$(whoami)'), TypeError);
  } finally {
    cleanup();
  }
});

test('runTests happy path: npm test runs locally and captures output', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    work.writeFile(ws.id, 'package.json', JSON.stringify({ scripts: { test: 'node -e "console.log(\'hello-test\')"' } }));
    const result = work.runTests(ws.id, 'npm test');
    assert.equal(result.status, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.match(result.stdout, /hello-test/);
    assert.deepEqual(result.argv, ['npm', 'test']);
  } finally {
    cleanup();
  }
});

test('runTests happy path: node --test discovers a passing test file', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    mkdirSync(join(ws.path, 'test'), { recursive: true });
    work.writeFile(ws.id, 'test/sample.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passes', () => { assert.equal(1 + 1, 2); });\n");
    const result = work.runTests(ws.id, 'node --test');
    assert.equal(result.status, 0);
    assert.equal(result.timedOut, false);
  } finally {
    cleanup();
  }
});

test('runTests timeout kills a hanging command and reports timedOut', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    work.writeFile(ws.id, 'package.json', JSON.stringify({ scripts: { test: 'node -e "setTimeout(() => {}, 30000)"' } }));
    const result = work.runTests(ws.id, 'npm test', { timeoutMs: 800 });
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs >= 700);
  } finally {
    cleanup();
  }
});

test('runTests truncates output at 32KB', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    work.writeFile(ws.id, 'package.json', JSON.stringify({ scripts: { test: 'node -e "process.stdout.write(\'y\'.repeat(100000))"' } }));
    const result = work.runTests(ws.id, 'npm test');
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 32768);
  } finally {
    cleanup();
  }
});

test('runTests honors a pre-aborted AbortSignal and validates timeoutMs', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    const controller = new AbortController();
    controller.abort(new Error('stop now'));
    assert.throws(() => work.runTests(ws.id, 'npm test', { signal: controller.signal }), /stop now/);
    assert.throws(() => work.runTests(ws.id, 'npm test', { timeoutMs: 5 }), TypeError);
    assert.throws(() => work.runTests(ws.id, 'npm test', { timeoutMs: 999999 }), TypeError);
  } finally {
    cleanup();
  }
});

test('gitDiff reports local changes via git diff --no-color', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    work.writeFile(ws.id, 'app.txt', 'version one\n');
    gitInit(ws.path);
    work.writeFile(ws.id, 'app.txt', 'version two\n');
    const { diff, truncated } = work.gitDiff(ws.id);
    assert.equal(truncated, false);
    assert.match(diff, /version two/);
    assert.doesNotMatch(diff, /\x1b\[/);
  } finally {
    cleanup();
  }
});

test('writeFile validates content size and readFile validates maxBytes', () => {
  const { work, cleanup } = makeWork();
  try {
    const ws = work.createWorkspace();
    assert.throws(() => work.writeFile(ws.id, 'big.txt', 'x'.repeat(1048576 + 1)), TypeError);
    assert.throws(() => work.writeFile(ws.id, 'obj.txt', { not: 'a string' }), TypeError);
    work.writeFile(ws.id, 'small.txt', 'abc');
    assert.throws(() => work.readFile(ws.id, 'small.txt', 0), TypeError);
    assert.throws(() => work.readFile(ws.id, 'small.txt', 999999), TypeError);
    const capped = work.readFile(ws.id, 'small.txt', 2);
    assert.equal(capped.bytes, 'ab');
    assert.equal(capped.truncated, true);
  } finally {
    cleanup();
  }
});
