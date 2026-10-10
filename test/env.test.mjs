import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../src/env.mjs';

test('env file loads keys, real env wins, empties skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-env-'));
  try {
    const p = join(dir, '.env');
    writeFileSync(p, '# comment\nFRIDAY_TEST_A=hello\nFRIDAY_TEST_B="quoted value"\nFRIDAY_TEST_EMPTY=\nBAD LINE\n');
    chmodSync(p, 0o600);
    delete process.env.FRIDAY_TEST_A;
    process.env.FRIDAY_TEST_B = 'real-wins';
    const out = loadEnvFile(p);
    assert.equal(out.loaded, true);
    assert.equal(process.env.FRIDAY_TEST_A, 'hello');
    assert.equal(process.env.FRIDAY_TEST_B, 'real-wins');
    assert.ok(!('FRIDAY_TEST_EMPTY' in process.env));
    assert.equal(loadEnvFile(join(dir, 'missing')).loaded, false);
    delete process.env.FRIDAY_TEST_A;
    delete process.env.FRIDAY_TEST_B;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
