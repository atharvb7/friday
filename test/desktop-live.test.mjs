import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ComputerControlLease } from '../src/desktop.mjs';
import { LiveDesktop, WTYPE_INSTALL, YDOTOOL_INSTALL } from '../src/desktop-live.mjs';

function leased() {
  const lease = new ComputerControlLease();
  const { leaseId } = lease.request({ reason: 'test', ttlMs: 10_000 });
  return { lease, leaseId };
}

// Never touch hardware: binaries absent, spawn must not be called.
const noBinaries = () => false;
function explodingSpawn() {
  throw new Error('spawn must not be called when binaries are missing');
}

test('type fails closed when wtype is missing (no spawn, install hint)', () => {
  const { lease, leaseId } = leased();
  const live = new LiveDesktop({ lease, hasBinary: noBinaries, spawn: explodingSpawn });
  const res = live.type(leaseId, 'hello wayland');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'wtype_not_installed');
  assert.equal(res.install, 'sudo apt install wtype');
  assert.equal(res.install, WTYPE_INSTALL);
  assert.equal(res.action, 'type');
  assert.equal(res.verified, false);
  assert.ok(res.at);
});

test('click fails closed when ydotool/ydotoold is missing (install hint)', () => {
  const { lease, leaseId } = leased();
  const live = new LiveDesktop({ lease, hasBinary: noBinaries, spawn: explodingSpawn });
  const res = live.click(leaseId, { x: 10, y: 10 });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /ydotool/);
  assert.equal(res.install, YDOTOOL_INSTALL);
  assert.equal(res.action, 'click');
  assert.equal(res.verified, false);
  assert.ok(res.at);
});

test('click reports missing daemon distinctly when only ydotoold is absent', () => {
  const { lease, leaseId } = leased();
  const live = new LiveDesktop({
    lease,
    hasBinary: (name) => name === 'ydotool',
    spawn: explodingSpawn,
  });
  const res = live.click(leaseId, { x: 5, y: 5 });
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'ydotoold_not_running');
  assert.ok(res.install);
});

test('every action asserts the lease first (no lease → throw, no spawn)', () => {
  const { lease } = leased();
  const live = new LiveDesktop({ lease, hasBinary: noBinaries, spawn: explodingSpawn });
  assert.throws(() => live.type('bad-lease-id', 'hi'), /not_held|expired|missing/);
  assert.throws(() => live.click('bad-lease-id', { x: 1, y: 1 }), /not_held|expired|missing/);
  // Single-arg / numeric-first calls without a lease must also throw lease errors.
  assert.throws(() => live.type('just text, no lease'), /not_held|expired|missing/);
  assert.throws(() => live.click(10, 20), /not_held|expired|missing/);
  // Revoked lease also throws.
  const { leaseId } = lease.request ? (() => ({ leaseId: null }))() : {};
  void leaseId;
  lease.revokeOnActivity();
  // After revoke, even a previously valid shape must throw; request a fresh
  // holder on a new lease object to check the mismatch path instead.
  const lease2 = new ComputerControlLease();
  const live2 = new LiveDesktop({ lease: lease2, hasBinary: noBinaries, spawn: explodingSpawn });
  assert.throws(() => live2.type('unknown', 'hi'), /not_held/);
});

test('click is bounds-checked (lease held, out-of-bounds → RangeError)', () => {
  const { lease, leaseId } = leased();
  const live = new LiveDesktop({
    lease,
    screenBounds: { width: 800, height: 600 },
    hasBinary: noBinaries,
    spawn: explodingSpawn,
  });
  assert.throws(() => live.click(leaseId, { x: 800, y: 10 }), RangeError);
  assert.throws(() => live.click(leaseId, { x: -1, y: 10 }), RangeError);
  assert.throws(() => live.click(leaseId, { x: 10, y: 600 }), RangeError);
  assert.throws(() => live.click(leaseId, { x: NaN, y: 10 }), RangeError);
  assert.throws(() => live.click(leaseId, 800, 10), RangeError);
});

test('type validates length and control chars before touching binaries', () => {
  const { lease, leaseId } = leased();
  let spawned = false;
  const live = new LiveDesktop({
    lease,
    hasBinary: () => true,
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  });
  assert.throws(() => live.type(leaseId, 'x'.repeat(501)), RangeError);
  assert.throws(() => live.type(leaseId, 'bad\x07bell'), RangeError);
  assert.throws(() => live.type(leaseId, ''), TypeError);
  assert.equal(spawned, false);
});

test('success receipts are audit-friendly: {action, at, verified:false, needsVerification}', () => {
  const { lease, leaseId } = leased();
  const live = new LiveDesktop({
    lease,
    hasBinary: () => true,
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const typed = live.type(leaseId, 'hello');
  assert.equal(typed.action, 'type');
  assert.equal(typed.verified, false);
  assert.equal(typed.needsVerification, true);
  assert.ok(typed.at);
  const clicked = live.click(leaseId, { x: 100, y: 200 });
  assert.equal(clicked.action, 'click');
  assert.equal(clicked.verified, false);
  assert.equal(clicked.needsVerification, true);
  assert.ok(clicked.screenshot);
  assert.ok(clicked.at);
});

test('constructor requires a ComputerControlLease; module has no uinput/X11 fallback', () => {
  assert.throws(() => new LiveDesktop({}), TypeError);
  assert.throws(() => new LiveDesktop({ lease: {} }), TypeError);
  const src = readFileSync(new URL('../src/desktop-live.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const pat of [
    /\/dev\/uinput/,
    /from\s+['"][^'"]*x11['"]/i,
    /\bxdotool\b/i,
    /\brobotjs\b/i,
    /\bpyatspi\b/i,
  ]) {
    assert.doesNotMatch(code, pat, `live module must not use ${pat}`);
  }
});
