// test/tools.test.mjs — coverage for the Friday tool registry:
// traversal blocked, symlink escape blocked, oversized args rejected,
// happy paths, and approval binding (args change after approval fails).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effects } from '../src/effects.mjs';
import { Store } from '../src/store.mjs';
import { ToolRegistry } from '../src/tools.mjs';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-tools-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { dir, workspace };
}

function makeLedger(dir) {
  const store = new Store(join(dir, 'tools-test.sqlite'));
  const effects = new Effects(store);
  const task = store.createTask({ title: 'Tool test', instruction: 'Test only' });
  return { store, effects, task };
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('registers exactly the three read-only tools', () => {
  const { dir, workspace } = makeWorkspace();
  try {
    const registry = new ToolRegistry({ workspace });
    const listed = registry.list().sort((a, b) => (a.name < b.name ? -1 : 1));
    assert.deepEqual(listed, [
      { name: 'file.read', permission: 'safe' },
      { name: 'file.search', permission: 'safe' },
      { name: 'research.record', permission: 'safe' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file.search happy path returns [{path,size,mtime}] capped at limit', async () => {
  const { dir, workspace } = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'notes-alpha.txt'), 'alpha');
    writeFileSync(join(workspace, 'notes-beta.txt'), 'beta!');
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    writeFileSync(join(workspace, 'sub', 'notes-gamma.txt'), 'gamma');
    const registry = new ToolRegistry({ workspace });
    const out = await registry.run({ taskId: 't1', tool: 'file.search', args: { query: 'notes' } });
    assert.equal(out.ok, true);
    assert.equal(out.effectId, null);
    assert.ok(Array.isArray(out.result));
    assert.equal(out.result.length, 3);
    for (const entry of out.result) {
      assert.equal(typeof entry.path, 'string');
      assert.equal(typeof entry.size, 'number');
      assert.equal(typeof entry.mtime, 'string');
    }
    const paths = out.result.map((entry) => entry.path).sort();
    assert.deepEqual(paths, ['notes-alpha.txt', 'notes-beta.txt', 'sub/notes-gamma.txt']);
    const beta = out.result.find((entry) => entry.path === 'notes-beta.txt');
    assert.equal(beta.size, 5);

    const limited = await registry.run({
      taskId: 't1',
      tool: 'file.search',
      args: { query: 'notes', limit: 2 },
    });
    assert.equal(limited.result.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file.read happy path, truncation, and preview hash', async () => {
  const { dir, workspace } = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'hello.txt'), 'hello friday');
    const registry = new ToolRegistry({ workspace });
    const full = await registry.run({ taskId: 't1', tool: 'file.read', args: { path: 'hello.txt' } });
    assert.equal(full.ok, true);
    assert.equal(full.result.path, 'hello.txt');
    assert.equal(full.result.bytes, 'hello friday');
    assert.equal(full.result.truncated, false);
    assert.equal(full.result.previewHash, sha256('hello friday'));

    const partial = await registry.run({
      taskId: 't1',
      tool: 'file.read',
      args: { path: 'hello.txt', maxBytes: 5 },
    });
    assert.equal(partial.result.bytes, 'hello');
    assert.equal(partial.result.truncated, true);
    assert.equal(partial.result.previewHash, sha256('hello'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('research.record happy path validates https and caps without touching Memory', async () => {
  const { dir, workspace } = makeWorkspace();
  try {
    const registry = new ToolRegistry({ workspace });
    const out = await registry.run({
      taskId: 't1',
      tool: 'research.record',
      args: { source: 'https://example.com/article', title: 'Title', claim: 'A claim.' },
    });
    assert.equal(out.ok, true);
    assert.equal(typeof out.result.id, 'string');
    assert.equal(out.result.source, 'https://example.com/article');
    assert.equal(out.result.title, 'Title');
    assert.equal(out.result.claim, 'A claim.');
    assert.equal(typeof out.result.recordedAt, 'string');

    await assert.rejects(
      registry.run({ taskId: 't1', tool: 'research.record', args: { source: 'http://example.com/x', title: 'T', claim: 'C' } }),
      TypeError,
    );
    await assert.rejects(
      registry.run({ taskId: 't1', tool: 'research.record', args: { source: 'not a url', title: 'T', claim: 'C' } }),
      TypeError,
    );
    await assert.rejects(
      registry.run({ taskId: 't1', tool: 'research.record', args: { source: 'https://example.com/', title: '', claim: 'C' } }),
      TypeError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('traversal and absolute escape paths are blocked', async () => {
  const { dir, workspace } = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'ok.txt'), 'ok');
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    const registry = new ToolRegistry({ workspace });
    await assert.rejects(registry.run({ taskId: 't1', tool: 'file.read', args: { path: '../../etc/passwd' } }), TypeError);
    await assert.rejects(registry.run({ taskId: 't1', tool: 'file.read', args: { path: '/etc/passwd' } }), TypeError);
    await assert.rejects(
      registry.run({ taskId: 't1', tool: 'file.read', args: { path: 'sub/../../../etc/hostname' } }),
      TypeError,
    );
    await assert.rejects(registry.run({ taskId: 't1', tool: 'file.search', args: { query: 'x', root: '..' } }), TypeError);
    await assert.rejects(
      registry.run({ taskId: 't1', tool: 'file.search', args: { query: 'x', root: '/tmp' } }),
      TypeError,
    );
    // Absolute path inside the workspace stays usable.
    const inside = await registry.run({ taskId: 't1', tool: 'file.read', args: { path: join(workspace, 'ok.txt') } });
    assert.equal(inside.result.bytes, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlink escape is blocked for reads and searches', async () => {
  const { dir, workspace } = makeWorkspace();
  try {
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'top secret marker');
    symlinkSync(outside, join(workspace, 'link-dir'));
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link-file'));
    writeFileSync(join(workspace, 'plain.txt'), 'plain');
    const registry = new ToolRegistry({ workspace });

    await assert.rejects(registry.run({ taskId: 't1', tool: 'file.read', args: { path: 'link-file' } }), TypeError);
    await assert.rejects(
      registry.run({ taskId: 't1', tool: 'file.read', args: { path: 'link-dir/secret.txt' } }),
      TypeError,
    );
    await assert.rejects(registry.run({ taskId: 't1', tool: 'file.search', args: { query: 'secret', root: 'link-dir' } }), TypeError);

    // A workspace-wide search must not leak outside filenames or contents.
    const swept = await registry.run({ taskId: 't1', tool: 'file.search', args: { query: 'secret' } });
    assert.deepEqual(swept.result, []);
    const plain = await registry.run({ taskId: 't1', tool: 'file.read', args: { path: 'plain.txt' } });
    assert.equal(plain.result.bytes, 'plain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized and malformed args are rejected with TypeError', async () => {
  const { dir, workspace } = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'f.txt'), 'data');
    const registry = new ToolRegistry({ workspace });
    const run = (tool, args) => registry.run({ taskId: 't1', tool, args });

    await assert.rejects(run('file.read', { path: 'f.txt', maxBytes: 65537 }), TypeError);
    await assert.rejects(run('file.read', { path: 'f.txt', maxBytes: 1_000_000 }), TypeError);
    await assert.rejects(run('file.read', { path: 'f.txt', maxBytes: 0 }), TypeError);
    await assert.rejects(run('file.search', { query: 'x', limit: 51 }), TypeError);
    await assert.rejects(run('file.search', { query: 'x'.repeat(201) }), TypeError);
    await assert.rejects(run('file.search', { query: '   ' }), TypeError);
    await assert.rejects(
      run('research.record', { source: 'https://example.com/', title: 'x'.repeat(201), claim: 'C' }),
      TypeError,
    );
    await assert.rejects(
      run('research.record', { source: 'https://example.com/', title: 'T', claim: 'x'.repeat(2001) }),
      TypeError,
    );
    await assert.rejects(run('file.read', ['f.txt']), TypeError);
    await assert.rejects(run('file.read', null), TypeError);
    await assert.rejects(registry.run({ taskId: 't1', tool: 'file.delete', args: {} }), TypeError);
    await assert.rejects(registry.run({ taskId: '', tool: 'file.read', args: { path: 'f.txt' } }), TypeError);

    // Boundary values are accepted.
    const atCap = await run('file.read', { path: 'f.txt', maxBytes: 65536 });
    assert.equal(atCap.result.truncated, false);
    const limitCap = await run('file.search', { query: 'f', limit: 50 });
    assert.ok(limitCap.result.length <= 50);

    // Registry misuse is rejected.
    assert.throws(() => registry.register('Bad Name!', { handler: () => ({}), permission: 'safe' }), TypeError);
    assert.throws(() => registry.register('test.bad', { handler: 'nope', permission: 'safe' }), TypeError);
    assert.throws(() => registry.register('file.read', { handler: () => ({}), permission: 'safe' }), /already registered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gated tools run the full effect-ledger flow; safe tools skip it', async () => {
  const { dir, workspace } = makeWorkspace();
  const { store, effects, task } = makeLedger(dir);
  try {
    writeFileSync(join(workspace, 'seen.txt'), 'seen');
    const registry = new ToolRegistry({ workspace });
    registry.register('test.echo', { handler: (args) => ({ echo: args }), permission: 'approval' });

    const gated = await registry.run({ taskId: task.id, tool: 'test.echo', args: { msg: 'hi' }, effects });
    assert.equal(gated.ok, true);
    assert.equal(typeof gated.effectId, 'string');
    assert.deepEqual(gated.result, { echo: { msg: 'hi' } });
    assert.equal(effects.get(gated.effectId).status, 'verified_success');
    assert.deepEqual(effects.get(gated.effectId).receipt.result, gated.result);

    const before = effects.list(task.id).length;
    const safe = await registry.run({ taskId: task.id, tool: 'file.search', args: { query: 'seen' }, effects });
    assert.equal(safe.ok, true);
    assert.equal(safe.effectId, null);
    assert.equal(effects.list(task.id).length, before);

    await assert.rejects(registry.run({ taskId: task.id, tool: 'test.echo', args: { msg: 'hi' } }), TypeError);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approval binding: args changed after approval request fail', async () => {
  const { dir, workspace } = makeWorkspace();
  const { store, effects, task } = makeLedger(dir);
  try {
    const registry = new ToolRegistry({ workspace });
    registry.register('test.write', { handler: (args) => ({ wrote: args }), permission: 'approval' });

    await assert.rejects(
      registry.run({
        taskId: task.id,
        tool: 'test.write',
        args: { file: 'a.txt', content: 'original' },
        approvalArgs: { file: 'a.txt', content: 'tampered' },
        effects,
      }),
      /arguments changed/,
    );
    const stuck = effects.list(task.id).filter((effect) => effect.status === 'awaiting_approval');
    assert.equal(stuck.length, 1);
    assert.deepEqual(stuck[0].exact_args, { file: 'a.txt', content: 'original' });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace honors FRIDAY_WORKSPACE and module avoids shell and network', async () => {
  const { dir, workspace } = makeWorkspace();
  const previous = process.env.FRIDAY_WORKSPACE;
  try {
    process.env.FRIDAY_WORKSPACE = workspace;
    writeFileSync(join(workspace, 'env-note.txt'), 'via env');
    const registry = new ToolRegistry();
    const out = await registry.run({ taskId: 't-env', tool: 'file.search', args: { query: 'env-note' } });
    assert.ok(out.result.some((entry) => entry.path === 'env-note.txt'));

    const source = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
    for (const banned of ['child_process', 'execSync', 'spawn(', 'fetch(']) {
      assert.ok(!source.includes(banned), `tools module must not contain ${banned}`);
    }
  } finally {
    if (previous === undefined) delete process.env.FRIDAY_WORKSPACE;
    else process.env.FRIDAY_WORKSPACE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
