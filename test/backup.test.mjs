import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';
import { createBackup, restoreBackup } from '../src/backup.mjs';

test('backup snapshots a live DB, excludes secrets by default, restores intact', () => {
  const a = mkdtempSync(join(tmpdir(), 'fb-a-'));
  const b = mkdtempSync(join(tmpdir(), 'fb-b-'));
  try {
    const store = new Store(join(a, 'friday.sqlite'));
    new Memory(store).create({ content: 'I prefer PostgreSQL' });
    store.createTask({ title: 't', instruction: 'i' });
    writeFileSync(join(a, 'access-token'), 'SECRET\n');
    mkdirSync(join(a, 'workspace')); writeFileSync(join(a, 'workspace', 'n.txt'), 'hi');
    const r = createBackup({ dataDir: a, outDir: join(a, 'backups') });
    store.close();
    assert.ok(!r.withSecrets && existsSync(r.file));
    restoreBackup({ file: r.file, dataDir: b });
    assert.ok(!existsSync(join(b, 'access-token')), 'secrets must not ride along by default');
    const s2 = new Store(join(b, 'friday.sqlite'));
    assert.equal(s2.countTasks(), 1);
    assert.equal(new Memory(s2).search('PostgreSQL').length, 1);
    s2.close();
    assert.throws(() => restoreBackup({ file: r.file, dataDir: b }), /not_empty/);
    restoreBackup({ file: r.file, dataDir: b, force: true });
    assert.ok(readdirSync(b).some((f) => f.startsWith('pre-restore-')), 'old DB moved aside, not deleted');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('backup retention keeps only the newest N', () => {
  const a = mkdtempSync(join(tmpdir(), 'fb-r-'));
  try {
    new Store(join(a, 'friday.sqlite')).close();
    for (let i = 0; i < 4; i++) createBackup({ dataDir: a, outDir: join(a, 'bk'), keep: 2, now: new Date(Date.UTC(2026, 0, 1 + i)) });
    assert.equal(readdirSync(join(a, 'bk')).length, 2);
  } finally { rmSync(a, { recursive: true, force: true }); }
});
