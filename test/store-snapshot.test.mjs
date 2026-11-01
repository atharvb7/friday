import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SNAPSHOT_KEEP, codeVersion } from '../src/store.mjs';

test('store: an existing database is copied once per code version before it is opened for changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-snap-'));
  const path = join(dir, 'friday.sqlite');
  const snaps = () => readdirSync(join(dir, 'snapshots')).filter((f) => f.endsWith('.db')).sort();
  try {
    let s = new Store(path);
    assert.equal(s.snapshot, null, 'a brand-new database has nothing to save');
    s.createTask({ title: 'before deploy', instruction: 'x' });
    s.close();

    s = new Store(path); // first start of this code version on an existing database
    assert.ok(s.snapshot && s.snapshot.endsWith('.db'));
    s.db.exec("UPDATE tasks SET title='damaged by a bad backfill'");
    s.close();
    const copy = new DatabaseSync(join(dir, 'snapshots', snaps()[0]), { readOnly: true });
    assert.equal(copy.prepare('SELECT title FROM tasks').get().title, 'before deploy');
    copy.close();
    assert.equal(readFileSync(join(dir, 'snapshots', 'code-version'), 'utf8').trim(), codeVersion());

    // Same code restarting (or crash-looping) never replaces the good copy.
    s = new Store(path); assert.equal(s.snapshot, null); s.close();
    assert.equal(snaps().length, 1);

    // Each new version adds one; only the newest few are kept.
    for (let i = 0; i < SNAPSHOT_KEEP + 2; i++) {
      writeFileSync(join(dir, 'snapshots', 'code-version'), `older-${i}\n`);
      s = new Store(path); assert.ok(s.snapshot); s.close();
    }
    assert.equal(snaps().length, SNAPSHOT_KEEP);
    assert.equal(readdirSync(join(dir, 'snapshots')).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
