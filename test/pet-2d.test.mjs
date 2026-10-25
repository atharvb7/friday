import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { bubbleFor, motionAt, PET_IMAGE } from '../public/pet-2d.js';
import { PET_STATES, PET_LINES, lineFor } from '../public/pet-viewer.js';

const ART = [PET_IMAGE, '/assets/friday-face.webp', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/apple-touch-icon.png', '/assets/favicon-64.png'];
const artHere = ART.every((f) => existsSync(new URL(`../public${f}`, import.meta.url)));

test('2D pet imports without a DOM; manifest points at her icons', () => {
  assert.equal(typeof document, 'undefined');
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.icons.map((i) => i.sizes), ['192x192', '512x512']);
});

// The artwork is git-ignored (public repo), so a clean clone has none of it.
test('her portrait and icons are all present', { skip: !artHere && 'artwork not in this checkout (see public/assets/ATTRIBUTION.md)' }, () => {
  for (const f of ART) assert.ok(existsSync(new URL(`../public${f}`, import.meta.url)), f);
});

test('bubbleFor: heart when done, thinking dots, zzz asleep/offline, none while listening', () => {
  assert.equal(bubbleFor('done').kind, 'heart');
  assert.equal(bubbleFor('thinking').kind, 'dots');
  assert.equal(bubbleFor('sleeping').kind, 'zzz');
  assert.equal(bubbleFor('offline').kind, 'zzz');
  assert.equal(bubbleFor('blocked').text, '!');
  assert.equal(bubbleFor('listening'), null);
});

test('motionAt: small, bounded motion for every state; hop lifts her, offline is still and grey', () => {
  for (const s of PET_STATES) {
    for (const t of [0, 0.7, 3.3, 10]) {
      const m = motionAt(s, t, { now: 0 });
      assert.ok(Math.abs(m.dx) <= 0.01 && Math.abs(m.dy) <= 0.05 && Math.abs(m.rot) <= 0.06 && Math.abs(m.sy - 1) <= 0.01, `${s}@${t}`);
    }
  }
  assert.ok(motionAt('listening', 0.2, { now: 100, hopUntil: 1000 }).dy < 0);
  assert.equal(motionAt('listening', 0.2, { now: 2000, hopUntil: 1000 }).dy, 0);
  const off = motionAt('offline', 5);
  assert.equal(off.grey, true);
  assert.equal(off.rot, 0);
});

test('shared pet lines cover every state', () => {
  for (const s of PET_STATES) assert.ok(PET_LINES[s]?.length && typeof lineFor(s, () => 0.5) === 'string', s);
});
