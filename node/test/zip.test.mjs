import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipFolder } from '../zip.mjs';
import { reelFolder } from '../reel-edit.mjs';

test('zip: valid archive of all photos/videos (unzip verifies CRCs), skips symlinks/hidden; reel folders confined to friday-media', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fn-zip-'));
  try {
    const dl = join(dir, 'Downloads'); const reel = join(dl, 'friday-media', 'reel-test'); mkdirSync(join(reel, 'sub'), { recursive: true });
    writeFileSync(join(reel, 'clip1.png'), Buffer.alloc(5000, 7)); writeFileSync(join(reel, 'clip1.mp4'), Buffer.alloc(70000, 3)); writeFileSync(join(reel, 'sub', 'note.txt'), 'hi ✨');
    writeFileSync(join(reel, '.hidden'), 'x'); symlinkSync('/etc/passwd', join(reel, 'leak'));
    assert.equal(reelFolder('reel-test', dl), reel);
    assert.throws(() => reelFolder('/etc', dl), /inside Downloads\/friday-media/);
    assert.throws(() => reelFolder('../../', dl), /inside|not found/);
    const { zip, count } = zipFolder(reel);
    assert.equal(count, 3);
    const z = join(dir, 'out.zip'); writeFileSync(z, zip);
    assert.match(execFileSync('unzip', ['-t', z]).toString(), /No errors detected/);
    const list = execFileSync('unzip', ['-Z1', z]).toString().trim().split('\n').sort();
    assert.deepEqual(list, ['clip1.mp4', 'clip1.png', 'sub/note.txt']);
    execFileSync('unzip', ['-q', z, '-d', join(dir, 'x')]);
    assert.equal(readFileSync(join(dir, 'x', 'sub', 'note.txt'), 'utf8'), 'hi ✨');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
