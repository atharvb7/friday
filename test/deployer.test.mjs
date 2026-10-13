import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarFiles, collect, plan } from '../deployer/lib.mjs';
import { Deployer } from '../src/deployer.mjs';

test('deployer: build context skips secrets/node_modules/symlinks, valid tar, app type detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-dep-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>'); writeFileSync(join(dir, '.env'), 'SECRET=1'); writeFileSync(join(dir, '.env.local'), 'X=1');
    mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', 'big.js'), 'x');
    mkdirSync(join(dir, 'assets/img'), { recursive: true }); writeFileSync(join(dir, 'assets/img/a.svg'), '<svg/>');
    symlinkSync('/etc/passwd', join(dir, 'leak'));
    const files = collect(dir);
    assert.deepEqual(files.map((f) => f.name).sort(), ['assets/img/a.svg', 'index.html']);
    assert.equal(plan(files).kind, 'static');
    const tarPath = join(dir, 'ctx.tar'); writeFileSync(tarPath, tarFiles(files));
    assert.deepEqual(execFileSync('tar', ['-tf', tarPath]).toString().trim().split('\n').sort(), ['assets/img/a.svg', 'index.html']);
    assert.equal(plan([{ name: 'package.json', data: Buffer.from('{}') }]).kind, 'node');
    assert.equal(plan([{ name: 'Dockerfile', data: Buffer.from('FROM x\nEXPOSE 5000\n') }]).port, 5000);
    assert.equal(plan([{ name: 'dist/index.html', data: Buffer.from('') }]).dockerfile.includes('COPY dist/'), true);
    assert.throws(() => plan([{ name: 'README.md', data: Buffer.from('') }]), /no Dockerfile/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deployer client: not configured is an honest error; sends the secret', async () => {
  assert.deepEqual(await new Deployer({}).list(), { error: 'deployer_not_configured' });
  let seen = null;
  const d = new Deployer({ url: 'http://deployer:4330/', secret: 's3cret', fetchImpl: async (u, o) => { seen = { u, o }; return { json: async () => ({ apps: [] }) }; } });
  assert.deepEqual(await d.list(), { apps: [] });
  assert.equal(seen.u, 'http://deployer:4330/apps'); assert.equal(seen.o.headers.Authorization, 'Bearer s3cret');
});
