import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResources } from '../src/resources.mjs';
import { ResourceGovernor } from '../src/resource-governor.mjs';

function fixture({ availableGiB = 8, some = 0, full = 0, currentGiB = 1, highGiB = 8, maxGiB = 10 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'friday-resources-'));
  const proc = join(root, 'proc');
  const cg = join(root, 'cgroup');
  mkdirSync(join(proc, 'self'), { recursive: true });
  mkdirSync(join(proc, 'pressure'), { recursive: true });
  mkdirSync(cg, { recursive: true });
  const gib = 1024 ** 3;
  writeFileSync(join(proc, 'meminfo'), `MemTotal:       14336 kB\nMemAvailable: ${Math.floor(availableGiB * gib / 1024)} kB\nSwapTotal: 4194304 kB\nSwapFree: 3000000 kB\n`);
  writeFileSync(join(proc, 'pressure/memory'), `some avg10=${some} avg60=0.00 avg300=0.00 total=4\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`);
  writeFileSync(join(cg, 'memory.current'), String(Math.floor(currentGiB * gib)));
  writeFileSync(join(cg, 'memory.high'), highGiB === null ? 'max' : String(Math.floor(highGiB * gib)));
  writeFileSync(join(cg, 'memory.max'), maxGiB === null ? 'max' : String(Math.floor(maxGiB * gib)));
  writeFileSync(join(cg, 'memory.pressure'), 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
  return {
    root, proc, cg,
    snapshot: () => readResources({ procRoot: proc, cgroupPath: cg, process: { memoryUsage: () => ({ rss: 10 }) }, now: () => 0 }),
    setAvailable(value) { writeFileSync(join(proc, 'meminfo'), `MemTotal: 14336 kB\nMemAvailable: ${Math.floor(value * gib / 1024)} kB\nSwapTotal: 4194304 kB\nSwapFree: 3000000 kB\n`); },
  };
}

test('resource snapshot reads host PSI, available RAM, and cgroup v2 limits', () => {
  const f = fixture({ availableGiB: 3, some: 4, currentGiB: 7, highGiB: 8, maxGiB: 10 });
  try {
    const result = f.snapshot();
    assert.equal(result.availableBytes, 3 * 1024 ** 3);
    assert.equal(result.pressureSomeAvg10, 4);
    assert.equal(result.cgroup.currentBytes, 7 * 1024 ** 3);
    assert.equal(result.cgroup.highBytes, 8 * 1024 ** 3);
    assert.equal(result.cgroup.maxBytes, 10 * 1024 ** 3);
    assert.equal(result.mode, 'constrained');
    assert.equal(result.localModelEnabled, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('governor escalates immediately, restricts worker classes, and clears with hysteresis', () => {
  const f = fixture({ availableGiB: 3.5 });
  try {
    let now = 10_000;
    const governor = new ResourceGovernor({ readSnapshot: f.snapshot, now: () => now, thresholds: { clearForMs: 500 } });
    assert.equal(governor.sample().mode, 'constrained');
    assert.equal(governor.canAdmit('browser').allowed, false);
    assert.equal(governor.canAdmit('interactive').allowed, true);
    f.setAvailable(8);
    assert.equal(governor.sample().mode, 'constrained');
    now += 499;
    assert.equal(governor.sample().mode, 'constrained');
    now += 1;
    assert.equal(governor.sample().mode, 'normal');
    assert.equal(governor.canAdmit('local-model').allowed, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('cgroup pressure and emergency host pressure suspend nonessential workers immediately', () => {
  const f = fixture({ availableGiB: 1, currentGiB: 9.9, maxGiB: 10 });
  try {
    const governor = new ResourceGovernor({ readSnapshot: f.snapshot });
    assert.equal(governor.sample().mode, 'emergency');
    assert.equal(governor.canAdmit('interactive').allowed, false);
    assert.equal(governor.pressureActions().emergencyTerminate, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('telemetry is persisted as bounded newline-delimited snapshots', () => {
  const f = fixture();
  const telemetryPath = join(f.root, 'data', 'memory.jsonl');
  try {
    const governor = new ResourceGovernor({ readSnapshot: f.snapshot, telemetryPath });
    governor.sample();
    governor.sample();
    const lines = readFileSync(telemetryPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).mode, 'normal');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
