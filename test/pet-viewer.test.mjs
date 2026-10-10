import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PET_STATES,
  BLINK_MIN_MS,
  BLINK_MAX_MS,
  nextBlinkDelay,
  isCompactMode,
  poseFor,
} from '../public/pet-viewer.js';

// No WebGL/THREE in these tests: poseFor/timing/compact parsing are pure.
// Proof: importing the module must not require a DOM or fetch.
test('pet-viewer imports cleanly without DOM/WebGL globals', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof globalThis.WebGLRenderingContext, 'undefined');
});

test('poseFor covers every Friday presence state with an emoji + note', () => {
  assert.deepEqual([...PET_STATES],
    ['sleeping', 'listening', 'thinking', 'acting', 'waiting', 'blocked', 'offline', 'done']);
  for (const s of PET_STATES) {
    const p = poseFor(s);
    assert.equal(p.state, s);
    assert.ok(typeof p.emoji === 'string' && p.emoji.length > 0, `${s} emoji`);
    assert.ok(typeof p.label === 'string' && p.label.length > 0, `${s} label`);
    assert.ok(Number.isFinite(p.breathHz) && p.breathHz > 0, `${s} breathHz`);
    assert.ok(Object.isFrozen(p), `${s} frozen`);
    assert.ok(Object.isFrozen(p.head), `${s} head frozen`);
    assert.ok(typeof p.note === 'string' && p.note.length > 0, `${s} note`);
  }
});

test('poseFor spot-checks: sleeping slow breath, acting waves, offline greys, done jumps', () => {
  assert.ok(poseFor('sleeping').breathHz <= 0.15);
  assert.equal(poseFor('acting').wave, true);
  assert.equal(poseFor('done').wave, true);
  assert.equal(poseFor('done').jump, true);
  assert.equal(poseFor('offline').grey, true);
  assert.equal(poseFor('waiting').nod, true);
  assert.equal(poseFor('blocked').shake, true);
  assert.ok(Math.abs(poseFor('thinking').head.roll) >= 0.2, 'thinking head tilt');
  assert.ok(poseFor('listening').lean >= 0.2, 'listening lean forward');
});

test('poseFor unknown state falls back honestly (never throws)', () => {
  const p = poseFor('bogus-state');
  assert.equal(p.state, 'unknown');
  assert.equal(p.emoji, '❓');
  assert.match(p.note, /bogus-state/);
  assert.doesNotThrow(() => poseFor(undefined));
  assert.doesNotThrow(() => poseFor(null));
});

test('blink delay stays in [2s, 5s] and honours injected randomness', () => {
  assert.equal(BLINK_MIN_MS, 2000);
  assert.equal(BLINK_MAX_MS, 5000);
  assert.equal(nextBlinkDelay(() => 0), 2000);
  assert.equal(nextBlinkDelay(() => 1), 5000);
  assert.equal(nextBlinkDelay(() => 0.5), 3500);
  for (let i = 0; i < 200; i++) {
    const d = nextBlinkDelay();
    assert.ok(d >= 2000 && d <= 5000, `blink out of range: ${d}`);
  }
});

test('isCompactMode parses ?compact=1 (Sit-on-screen popup)', () => {
  assert.equal(isCompactMode('?compact=1'), true);
  assert.equal(isCompactMode('?compact=1&foo=bar'), true);
  assert.equal(isCompactMode('?foo=bar&compact=1'), true);
  assert.equal(isCompactMode(''), false);
  assert.equal(isCompactMode('?compact=0'), false);
  assert.equal(isCompactMode('?compact=10'), false);
  assert.equal(isCompactMode(null), false);
});
