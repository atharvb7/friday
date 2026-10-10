// src/desktop.mjs — Friday desktop-control stubs (NO real actuation).
//
// Wayland portal + AT-SPI matrix requirement:
// - Real pointer/keyboard injection on this laptop (Ubuntu 26.04, GNOME, Wayland)
//   MUST go through the XDG RemoteDesktop portal session (PipeWire + portal
//   input) with an explicit one-time user grant and persistent restore-token
//   handling. Raw uinput / X11 / xdotool injection is FORBIDDEN.
// - Real semantic inspection MUST go through AT-SPI and is only permitted for
//   applications covered by a tested per-app coverage matrix (Files,
//   Chrome/Chromium, Terminal, Settings, editors, ...). Until an app is both
//   allowlisted AND verified, inspection must fail closed.
// - This module therefore exposes ONLY a single-holder lease plus stubs that
//   never touch hardware. PortalInput.click/key always return
//   { needsVerification: true, injected: false } and never inject input.
// - No imports of child_process, uinput, X11, or portal bindings live here.

import { randomUUID } from 'node:crypto';

export const MAX_LEASE_TTL_MS = 60_000;
export const FRIDAY_ALLOWLIST = Object.freeze([]);
export const DEFAULT_SCREEN_BOUNDS = Object.freeze({ width: 1920, height: 1080 });

function assertReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError('reason must be a non-empty string');
  }
}

function assertTtl(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new RangeError(`ttlMs must be an integer in [1, ${MAX_LEASE_TTL_MS}]`);
  }
}

function assertBounds(x, y, bounds) {
  const { width, height } = bounds ?? {};
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError('screen bounds must define positive width/height');
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError('explicit finite {x, y} coordinates are required');
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new RangeError(`coordinates {x:${x}, y:${y}} outside bounds ${width}x${height}`);
  }
}

// Single-holder, expiring, revocable lease guarding any future desktop actuation.
// Only one active (unexpired, unrevoked, unreleased) lease may exist at a time.
// Physical user activity must call revokeOnActivity() to cancel the holder.
export class ComputerControlLease {
  constructor({ now = Date.now, maxTtlMs = MAX_LEASE_TTL_MS } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
    this.maxTtlMs = maxTtlMs;
    this.holder = null; // { leaseId, expiresAt, reason, revoked }
  }

  #pruneExpired() {
    if (this.holder && this.now() >= this.holder.expiresAt) {
      this.holder = null;
    }
  }

  hasActive() {
    this.#pruneExpired();
    return this.holder !== null && this.holder.revoked !== true;
  }

  // Primary entry point: grant a lease only when no active lease exists.
  request({ reason, ttlMs = 10_000 } = {}) {
    assertReason(reason);
    assertTtl(ttlMs);
    if (ttlMs > this.maxTtlMs) throw new RangeError('ttlMs exceeds configured maximum');
    this.#pruneExpired();
    if (this.holder) throw new Error('control_lease_active: single holder already holds the lease');
    const leaseId = randomUUID();
    const expiresAt = this.now() + ttlMs;
    this.holder = { leaseId, expiresAt, reason, revoked: false };
    return { leaseId, expiresAt };
  }

  // Alias with identical single-holder semantics (convenience holder API).
  acquire({ reason = 'acquire', ttlMs = 10_000 } = {}) {
    return this.request({ reason, ttlMs });
  }

  release(leaseId = null) {
    this.#pruneExpired();
    if (!this.holder) return false;
    if (leaseId !== null && leaseId !== this.holder.leaseId) {
      throw new Error('control_lease_mismatch: cannot release another holder');
    }
    this.holder = null;
    return true;
  }

  // Physical user activity (keyboard/mouse at the laptop) always cancels.
  revokeOnActivity({ source = 'physical_input' } = {}) {
    if (!this.holder) return false;
    this.holder = null;
    this.lastRevocation = { at: this.now(), source };
    return true;
  }

  assertHeld(leaseId) {
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
      throw new Error('control_lease_not_held: missing leaseId');
    }
    const current = this.holder;
    if (!current || current.revoked === true) {
      throw new Error('control_lease_not_held: revoked or released');
    }
    if (leaseId !== current.leaseId) {
      throw new Error('control_lease_not_held: unknown leaseId');
    }
    if (this.now() >= current.expiresAt) {
      this.holder = null;
      throw new Error('control_lease_expired');
    }
    return { leaseId: current.leaseId, expiresAt: current.expiresAt, remainingMs: current.expiresAt - this.now() };
  }
}

// AT-SPI semantic-inspection stub. Fails closed until an app is both
// allowlisted and explicitly marked verified (tested coverage matrix).
export class AtSpiDriver {
  constructor({ allowlist = FRIDAY_ALLOWLIST, verified = [] } = {}) {
    this.allowlist = Object.freeze([...allowlist]);
    this.verified = new Set(verified);
  }

  inspect(appName) {
    if (typeof appName !== 'string' || appName.length === 0) {
      throw new TypeError('appName must be a non-empty string');
    }
    const allowed = this.allowlist.includes(appName) && this.verified.has(appName);
    if (!allowed) {
      return { status: 'failed', error: 'atspi_not_verified', app: appName, injected: false };
    }
    // Real AT-SPI reads are not implemented in this stub stage.
    return { status: 'failed', error: 'atspi_not_verified', app: appName, injected: false };
  }
}

// Wayland RemoteDesktop portal input stub. Never injects; validates the lease
// and explicit coordinates, then returns a needs-verification receipt.
export class PortalInput {
  constructor({ lease, screenBounds = DEFAULT_SCREEN_BOUNDS } = {}) {
    if (!(lease instanceof ComputerControlLease)) throw new TypeError('lease must be a ComputerControlLease');
    const { width, height } = screenBounds ?? {};
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('screenBounds must define positive width/height');
    }
    this.lease = lease;
    this.screenBounds = { width, height };
  }

  click(leaseId, { x, y, button = 'left' } = {}) {
    this.lease.assertHeld(leaseId);
    assertBounds(x, y, this.screenBounds);
    if (!['left', 'right', 'middle'].includes(button)) throw new RangeError('unsupported button');
    // STUB: no portal session opened, no input injected.
    return { status: 'staged', needsVerification: true, injected: false, action: 'click', x, y, button };
  }

  key(leaseId, { key, modifiers = [] } = {}) {
    this.lease.assertHeld(leaseId);
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('key must be a non-empty string');
    if (!Array.isArray(modifiers)) throw new TypeError('modifiers must be an array');
    // STUB: no portal session opened, no input injected.
    return { status: 'staged', needsVerification: true, injected: false, action: 'key', key, modifiers: [...modifiers] };
  }
}
