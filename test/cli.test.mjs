import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../bin/friday.mjs', import.meta.url).pathname;
function run(dir, port, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_PORT: String(port), FRIDAY_NVIDIA_API_KEY: '' } });
}

test('cli lifecycle: offline -> start -> status -> stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-cli-'));
  const port = 43600 + Math.floor(Math.random() * 300);
  try {
    assert.equal(run(dir, port, 'status').status, 1);
    const up = run(dir, port, 'start');
    assert.equal(up.status, 0, up.stdout + up.stderr);
    assert.match(up.stdout, /Friday online\./);
    assert.match(run(dir, port, 'status').stdout, /Local model:\s+off/);
    assert.match(run(dir, port, 'stop').stdout, /Friday stopped/);
    assert.equal(run(dir, port, 'status').status, 1);
  } finally { run(dir, port, 'stop'); rmSync(dir, { recursive: true, force: true }); }
});

test('cli doctor never prints secret values and rejects unknown commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-cli-'));
  try {
    const d = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NVIDIA_API_KEY: 'nvapi-supersecretvalue123' } });
    assert.doesNotMatch(d.stdout, /supersecret/);
    assert.equal(spawnSync(process.execPath, [cli, 'bogus'], { encoding: 'utf8' }).status, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
