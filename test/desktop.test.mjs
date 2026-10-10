import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ComputerControlLease, AtSpiDriver, PortalInput, MAX_LEASE_TTL_MS, FRIDAY_ALLOWLIST } from '../src/desktop.mjs';

function controllableClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('lease request grants a single holder; second request rejected', () => {
  const lease = new ComputerControlLease();
  const first = lease.request({ reason: 'demo task', ttlMs: 5000 });
  assert.ok(first.leaseId);
  assert.ok(first.expiresAt > Date.now());
  assert.throws(() => lease.request({ reason: 'other', ttlMs: 1000 }), /control_lease_active/);
  assert.throws(() => lease.acquire({ reason: 'other', ttlMs: 1000 }), /control_lease_active/);
});

test('expiry frees the holder and assertHeld throws control_lease_expired', () => {
  const clock = controllableClock();
  const lease = new ComputerControlLease({ now: clock.now });
  const { leaseId } = lease.request({ reason: 'short', ttlMs: 1000 });
  assert.doesNotThrow(() => lease.assertHeld(leaseId));
  clock.advance(1000);
  assert.throws(() => lease.assertHeld(leaseId), /control_lease_expired/);
  // Expired lease frees the single holder slot.
  const next = lease.request({ reason: 'after expiry', ttlMs: 1000 });
  assert.notEqual(next.leaseId, leaseId);
});

test('revokeOnActivity cancels the holder; new request succeeds', () => {
  const lease = new ComputerControlLease();
  const { leaseId } = lease.request({ reason: 'task', ttlMs: 10_000 });
  assert.equal(lease.revokeOnActivity(), true);
  assert.throws(() => lease.assertHeld(leaseId), /revoked|not_held/);
  const next = lease.request({ reason: 'after revoke', ttlMs: 1000 });
  assert.ok(next.leaseId);
  assert.equal(lease.revokeOnActivity({ source: 'mouse' }), true);
  assert.equal(lease.revokeOnActivity(), false); // nothing to revoke
});

test('assertHeld throws for unknown, mismatched, or released leases', () => {
  const lease = new ComputerControlLease();
  assert.throws(() => lease.assertHeld('nope'), /not_held/);
  assert.throws(() => lease.assertHeld(''), /not_held/);
  const { leaseId } = lease.request({ reason: 'x', ttlMs: 5000 });
  assert.throws(() => lease.assertHeld('00000000-0000-0000-0000-000000000000'), /not_held/);
  assert.equal(lease.release(leaseId), true);
  assert.throws(() => lease.assertHeld(leaseId), /revoked|not_held/);
  assert.equal(lease.release(), false); // idempotent no-op when empty
});

test('ttlMs is capped at 60000 and reason is required', () => {
  const lease = new ComputerControlLease();
  assert.throws(() => lease.request({ reason: 'x', ttlMs: MAX_LEASE_TTL_MS + 1 }), RangeError);
  assert.throws(() => lease.request({ reason: '', ttlMs: 1000 }), TypeError);
  assert.throws(() => lease.request({ ttlMs: 1000 }), TypeError);
  assert.throws(() => lease.request({ reason: 'x', ttlMs: 0 }), RangeError);
});

test('AtSpiDriver stub fails closed and never injects (default allowlist empty)', () => {
  assert.deepEqual([...FRIDAY_ALLOWLIST], []);
  const driver = new AtSpiDriver();
  for (const app of ['Files', 'Chrome', 'Terminal']) {
    const res = driver.inspect(app);
    assert.equal(res.status, 'failed');
    assert.equal(res.error, 'atspi_not_verified');
    assert.equal(res.injected, false);
  }
});

test('PortalInput requires a valid lease and always needs verification without injecting', () => {
  const lease = new ComputerControlLease();
  const portal = new PortalInput({ lease, screenBounds: { width: 800, height: 600 } });
  assert.throws(() => portal.click('bad-id', { x: 10, y: 10 }), /not_held/);
  assert.throws(() => portal.key('bad-id', { key: 'Enter' }), /not_held/);
  const { leaseId } = lease.request({ reason: 'portal task', ttlMs: 5000 });
  const c = portal.click(leaseId, { x: 10, y: 20 });
  assert.equal(c.needsVerification, true);
  assert.equal(c.injected, false);
  const k = portal.key(leaseId, { key: 'Enter' });
  assert.equal(k.needsVerification, true);
  assert.equal(k.injected, false);
});

test('PortalInput rejects missing or out-of-bounds coordinates', () => {
  const lease = new ComputerControlLease();
  const portal = new PortalInput({ lease, screenBounds: { width: 800, height: 600 } });
  const { leaseId } = lease.request({ reason: 'bounds', ttlMs: 5000 });
  assert.throws(() => portal.click(leaseId, { x: 800, y: 10 }), RangeError); // x == width excluded
  assert.throws(() => portal.click(leaseId, { x: -1, y: 10 }), RangeError);
  assert.throws(() => portal.click(leaseId, { x: 10, y: 600 }), RangeError);
  assert.throws(() => portal.click(leaseId, {}), RangeError);
  assert.throws(() => portal.click(leaseId, { x: NaN, y: 10 }), RangeError);
});

test('module performs no real input injection (no uinput/X11/child_process)', () => {
  const src = readFileSync(new URL('../src/desktop.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const pat of [/from\s+['"][^'"]*child_process['"]/, /require\s*\(\s*['"]child_process['"]/, /from\s+['"][^'"]*x11['"]/i, /\bopen\s*\(\s*['"]\/dev\/uinput['"]/, /\bxdotool\b/i, /\brobotjs\b/i]) {
    assert.doesNotMatch(code, pat, `executable code must not use ${pat}`);
  }
  // Stubs report non-injection at runtime (covered above); imports are crypto-only.
  assert.doesNotMatch(code, /^import\s+.*from\s+['"]node:(child_process|fs)['"]/m);
});
