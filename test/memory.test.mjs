import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Memory } from '../src/memory.mjs';

test('explicit memories are searchable and forgettable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-memory-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const memory = new Memory(store);
    const saved = memory.create({ content: 'I prefer PostgreSQL for large projects', source: 'explicit_user' });
    assert.equal(memory.search('PostgreSQL')[0].id, saved.id);
    assert.equal(memory.delete(saved.id), true);
    assert.equal(memory.search('PostgreSQL').length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
