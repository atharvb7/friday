// src/desktop-live.mjs — OPTIONAL live Wayland actuation (fail-closed).
//
// Production path (Ubuntu 26.04, GNOME, Wayland):
// - Preferred: XDG Desktop Portal RemoteDesktop session (PipeWire + portal
//   input) with an explicit one-time user grant and restore-token handling.
//   This module does NOT implement the portal session itself; it shells out
//   to the user-space helpers below which themselves speak Wayland protocols.
// - Typing helper: `wtype` (Wayland text input, wlroots/GNOME compatible).
// - Pointer helper: `ydotool` + running `ydotoold` daemon (generic uinput
//   backend driven via its own socket — NOT raw /dev/uinput writes here).
// - GNOME Settings → Accessibility must enable any on-screen-keyboard /
//   remote-input assistance the compositor requires; the compositor still
//   prompts for the RemoteDesktop grant on first use.
// - Lock-screen / suspend limits: while the session is locked or suspended,
//   the compositor drops input grants. All actions then fail (non-zero exit
//   or portal denial) and callers MUST treat the receipt as unverified and
//   re-take a screenshot after unlock. Nothing here unlocks the screen.
//
// Safety contract (mirrors src/desktop.mjs stubs):
// - Every action calls lease.assertHeld(leaseId) FIRST. No lease → throw.
// - Coordinates are bounds-checked against screenBounds (default 1920x1080).
// - Text is validated: string, 1..500 chars, no C0/C1 control chars.
// - If the required binary is absent, fail CLOSED with
//   { status:'failed', error:'*_not_installed', install:'sudo apt install …' }.
//   There is NO silent fallback, NO uinput/X11/xdotool path.
// - Even on success the receipt is audit-friendly and UNVERIFIED:
//   { action, at, verified:false, needsVerification:true, … } plus a
//   screenshot hint. Callers must capture a portal ScreenCast screenshot to
//   verify any visible effect.

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { ComputerControlLease, DEFAULT_SCREEN_BOUNDS } from './desktop.mjs';

export const WTYPE_INSTALL = 'sudo apt install wtype';
export const YDOTOOL_INSTALL = 'sudo apt install ydotool';
export const MAX_TYPE_CHARS = 500;

// Control chars forbidden in typed text (C0 block incl. \n\t excepted? —
// we forbid ALL of \x00-\x08, \x0B, \x0C, \x0E-\x1F, \x7F to keep wtype argv
// safe; callers needing Enter should use a key action, not type()).
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function defaultHasBinary(name) {
  if (typeof name !== 'string' || !name) return false;
  // Reject path separators: only bare binary names are looked up on PATH.
  if (name.includes('/') || name.includes('\0')) return false;
  const path = process.env.PATH ?? '/usr/bin:/bin';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    try {
      accessSync(`${dir}/${name}`, constants.X_OK);
      return true;
    } catch {
      // try next PATH entry
    }
  }
  return false;
}

function assertScreenBounds(x, y, bounds) {
  const { width, height } = bounds ?? {};
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError('screenBounds must define positive width/height');
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError('explicit finite {x, y} coordinates are required');
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new RangeError(`coordinates {x:${x}, y:${y}} outside bounds ${width}x${height}`);
  }
}

function assertTypeText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('text must be a non-empty string');
  }
  if (text.length > MAX_TYPE_CHARS) {
    throw new RangeError(`text must be <= ${MAX_TYPE_CHARS} chars`);
  }
  if (CONTROL_CHAR_RE.test(text)) {
    throw new RangeError('text contains forbidden control characters');
  }
}

export class LiveDesktop {
  constructor({ lease, screenBounds = DEFAULT_SCREEN_BOUNDS, hasBinary = defaultHasBinary, spawn = spawnSync } = {}) {
    if (!(lease instanceof ComputerControlLease)) {
      throw new TypeError('lease must be a ComputerControlLease');
    }
    const { width, height } = screenBounds ?? {};
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('screenBounds must define positive width/height');
    }
    if (typeof hasBinary !== 'function') throw new TypeError('hasBinary must be a function');
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    this.lease = lease;
    this.screenBounds = { width, height };
    this.hasBinary = hasBinary;
    this.spawn = spawn;
  }

  // Type text via `wtype <text>`. Lease is asserted before anything else.
  type(leaseId, text) {
    this.lease.assertHeld(leaseId);
    assertTypeText(text);
    const at = new Date().toISOString();
    if (!this.hasBinary('wtype')) {
      return {
        status: 'failed',
        error: 'wtype_not_installed',
        install: WTYPE_INSTALL,
        action: 'type',
        at,
        verified: false,
        needsVerification: true,
      };
    }
    let result;
    try {
      result = this.spawn('wtype', [text], { encoding: 'utf8', timeout: 5000 });
    } catch (error) {
      return {
        status: 'failed',
        error: `wtype_spawn_failed: ${error?.message ?? error}`,
        action: 'type',
        at,
        verified: false,
        needsVerification: true,
      };
    }
    if (result?.error) {
      return {
        status: 'failed',
        error: `wtype_spawn_failed: ${result.error.message ?? result.error}`,
        action: 'type',
        at,
        verified: false,
        needsVerification: true,
      };
    }
    if (typeof result?.status === 'number' && result.status !== 0) {
      return {
        status: 'failed',
        error: `wtype_exit_${result.status}: ${(result.stderr ?? '').toString().slice(0, 200)}`,
        action: 'type',
        at,
        verified: false,
        needsVerification: true,
      };
    }
    return {
      status: 'ok',
      action: 'type',
      at,
      verified: false,
      needsVerification: true,
      chars: text.length,
      screenshot: 'capture a portal ScreenCast screenshot to verify the typed text',
    };
  }

  // Click via `ydotool mousemove` + `ydotool click`. Lease first, then bounds.
  // Accepts click(leaseId, { x, y }) or click(leaseId, x, y).
  click(leaseId, xOrCoords, yMaybe) {
    this.lease.assertHeld(leaseId);
    let x;
    let y;
    if (typeof xOrCoords === 'object' && xOrCoords !== null) {
      ({ x, y } = xOrCoords);
    } else if (typeof xOrCoords === 'number' && typeof yMaybe === 'number') {
      x = xOrCoords;
      y = yMaybe;
    } else if (xOrCoords !== undefined || yMaybe !== undefined) {
      // Partial / malformed coords object — let the bounds check throw.
      x = xOrCoords?.x ?? xOrCoords;
      y = xOrCoords?.y ?? yMaybe;
    } else {
      throw new RangeError('explicit finite {x, y} coordinates are required');
    }
    assertScreenBounds(x, y, this.screenBounds);
    const at = new Date().toISOString();
    const failBase = {
      action: 'click',
      at,
      verified: false,
      x,
      y,
    };
    if (!this.hasBinary('ydotool')) {
      return {
        ...failBase,
        status: 'failed',
        error: 'ydotool_not_installed',
        install: YDOTOOL_INSTALL,
      };
    }
    if (!this.hasBinary('ydotoold')) {
      return {
        ...failBase,
        status: 'failed',
        error: 'ydotoold_not_running',
        install: YDOTOOL_INSTALL,
        hint: 'start the daemon first (ydotoold runs as a user service), then retry',
      };
    }
    try {
      const move = this.spawn('ydotool', ['mousemove', '-x', String(x), '-y', String(y)], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (move?.error) {
        return { ...failBase, status: 'failed', error: `ydotool_spawn_failed: ${move.error.message ?? move.error}` };
      }
      if (typeof move?.status === 'number' && move.status !== 0) {
        return { ...failBase, status: 'failed', error: `ydotool_mousemove_exit_${move.status}` };
      }
      const click = this.spawn('ydotool', ['click', '1'], { encoding: 'utf8', timeout: 5000 });
      if (click?.error) {
        return { ...failBase, status: 'failed', error: `ydotool_spawn_failed: ${click.error.message ?? click.error}` };
      }
      if (typeof click?.status === 'number' && click.status !== 0) {
        return { ...failBase, status: 'failed', error: `ydotool_click_exit_${click.status}` };
      }
    } catch (error) {
      return { ...failBase, status: 'failed', error: `ydotool_spawn_failed: ${error?.message ?? error}` };
    }
    return {
      status: 'ok',
      action: 'click',
      x,
      y,
      at,
      verified: false,
      needsVerification: true,
      injected: true,
      screenshot: 'capture a portal ScreenCast screenshot to verify pointer position and click effect',
    };
  }
}
