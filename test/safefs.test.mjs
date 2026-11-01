import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegularFile, writeFileReplacing, ensureRealDir } from '../src/safefs.mjs';
import { ResearchMemory } from '../src/research-memory.mjs';
import { Store } from '../src/store.mjs';

test('safefs: symlinks, FIFOs and oversize files are never read; replacing a symlink never writes through it', () => {
  const d = mkdtempSync(join(tmpdir(), 'friday-sfs-'));
  try {
    writeFileSync(join(d, 'secret'), 'TOKEN'); writeFileSync(join(d, 'ok.txt'), 'hello');
    symlinkSync(join(d, 'secret'), join(d, 'link.txt'));
    assert.equal(readRegularFile(join(d, 'ok.txt'), 100).toString(), 'hello');
    assert.throws(() => readRegularFile(join(d, 'link.txt'), 100), /ELOOP|symbolic|NOFOLLOW/i);
    assert.equal(spawnSync('mkfifo', [join(d, 'fifo')]).status, 0);
    assert.throws(() => readRegularFile(join(d, 'fifo'), 100), /not_a_regular_file/); // must return immediately, not hang
    assert.throws(() => readRegularFile(join(d, 'ok.txt'), 2), /file_too_large/);
    writeFileReplacing(join(d, 'link.txt'), 'new');
    assert.equal(readFileSync(join(d, 'secret'), 'utf8'), 'TOKEN', 'symlink target untouched');
    assert.equal(lstatSync(join(d, 'link.txt')).isSymbolicLink(), false);
    // a symlinked directory is replaced, not followed
    mkdirSync(join(d, 'victim')); writeFileSync(join(d, 'victim', 'keep'), '1'); symlinkSync(join(d, 'victim'), join(d, 'skills'));
    ensureRealDir(join(d, 'skills'));
    assert.equal(lstatSync(join(d, 'skills')).isSymbolicLink(), false);
    assert.ok(existsSync(join(d, 'victim', 'keep')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('research ingest: an agent-planted symlink/FIFO cannot exfiltrate files or hang the server', () => {
  const d = mkdtempSync(join(tmpdir(), 'friday-sfs-'));
  try {
    const store = new Store(join(d, 'db.sqlite')); const rm = new ResearchMemory({ store });
    const ws = join(d, 'ws'); mkdirSync(ws);
    writeFileSync(join(d, 'access-token'), 'OWNER-TOKEN-VALUE');
    writeFileSync(join(ws, 'findings.json'), JSON.stringify({ topic: 'T', summary: 'S' }));
    symlinkSync(join(d, 'access-token'), join(ws, 'report.md'));
    const out = rm.ingestFromDir({ taskId: 't', dir: ws });
    assert.equal(rm.report(out.id), null, 'symlinked report is ignored, not stored');
    rmSync(join(ws, 'findings.json')); symlinkSync(join(d, 'access-token'), join(ws, 'findings.json'));
    assert.throws(() => rm.ingestFromDir({ taskId: 't', dir: ws }), (e) => !/OWNER-TOKEN/.test(e.message));
    rmSync(join(ws, 'findings.json')); spawnSync('mkfifo', [join(ws, 'findings.json')]);
    assert.throws(() => rm.ingestFromDir({ taskId: 't', dir: ws }), /findings.json/);
    store.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});
