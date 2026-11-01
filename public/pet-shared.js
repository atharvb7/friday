// public/pet-shared.js — Friday's screen-pet state logic, shared by the 2D portrait pet (pet-2d.js) and the
// companion mapping (src/companion.mjs). Pure: no DOM, no fetch, so node tests import it directly.
// (The old 3D Megaman viewer and its three.js vendor bundle were removed on 28 Oct 2026: 2.1 MB, a third of the
// repo, and broken since the CSP blocked its textures.)

export const PET_STATES = Object.freeze([
  'sleeping', 'listening', 'thinking', 'acting',
  'waiting', 'blocked', 'offline', 'done',
]);

export const BLINK_MIN_MS = 2000;
export const BLINK_MAX_MS = 5000;

/** Randomised blink gap in [BLINK_MIN_MS, BLINK_MAX_MS]. Pure + injectable. */
export function nextBlinkDelay(rand = Math.random) {
  const r = typeof rand === 'function' ? rand() : Math.random();
  const clamped = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  return Math.round(BLINK_MIN_MS + clamped * (BLINK_MAX_MS - BLINK_MIN_MS));
}

/** True when the URL search string requests compact "sit on screen" mode. */
export function isCompactMode(search = '') {
  const s = String(search ?? '');
  return /(?:\?|&)compact=1(?:&|$)/.test(s);
}

// What she says per state (shared by the 3D viewer and the 2D portrait pet).
export const PET_LINES = Object.freeze({
  sleeping: ['Zzz… tap Wave to wake me up.', 'Resting… I am still watching your tasks.'],
  listening: ['Mm-hm, I am listening…', 'Go on, tell me everything.'],
  thinking: ['Hmm… let me think this through properly.', 'Give me a second, cutie… I mean, boss.'],
  acting: ['On it! Watch me work.', 'Doing the thing right now~'],
  waiting: ['I need your okay before I touch that — check the approval card?', 'This one is consequential… your call, boss.'],
  blocked: ['Stuck. Something needs you — I paused instead of guessing.', 'I hit a wall and stopped safely. Tell me how to proceed?'],
  offline: ['I lost the laptop link… still here, just sleepy.', 'Connection gone — I will wait right here.'],
  done: ['Done~! Check the receipt, all verified.', 'Finished! Was I good? …Don’t answer that.'],
});
export function lineFor(state, rand = Math.random) {
  const arr = PET_LINES[state] ?? PET_LINES.sleeping;
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

/**
 * Pure state -> pose map. No THREE, no DOM, no fetch.
 * Returns a frozen descriptor the animator interprets each frame.
 * Fields: emoji, label, breathHz, breathAmp, head{pitch,roll,yaw},
 * lean (forward +z tilt rad), wave, nod, shake, jump, grey, note.
 */
export function poseFor(state) {
  const s = String(state ?? '');
  switch (s) {
    case 'sleeping':
      return Object.freeze({ state: s, emoji: '😴', label: 'Sleeping',
        breathHz: 0.15, breathAmp: 0.02, head: Object.freeze({ pitch: 0.35, roll: 0, yaw: 0 }),
        lean: 0.12, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: 'sit pose, slow breath' });
    case 'listening':
      return Object.freeze({ state: s, emoji: '👂', label: 'Listening',
        breathHz: 0.25, breathAmp: 0.015, head: Object.freeze({ pitch: 0.1, roll: -0.15, yaw: -0.3 }),
        lean: 0.22, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: 'lean forward, head turned (hand-to-ear-ish; no IK)' });
    case 'thinking':
      return Object.freeze({ state: s, emoji: '💭', label: 'Thinking',
        breathHz: 0.2, breathAmp: 0.012, head: Object.freeze({ pitch: 0.05, roll: 0.3, yaw: 0.1 }),
        lean: 0.05, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: 'head tilt' });
    case 'acting':
      return Object.freeze({ state: s, emoji: '🐾', label: 'Acting',
        breathHz: 0.3, breathAmp: 0.02, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0.08, wave: true, nod: false, shake: false, jump: false, grey: false,
        note: 'wave (R UpperArm_035 z + Forearm_036 x, 2s sine)' });
    case 'waiting':
      return Object.freeze({ state: s, emoji: '⏳', label: 'Waiting for approval',
        breathHz: 0.22, breathAmp: 0.012, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0.1, wave: false, nod: true, shake: false, jump: false, grey: false,
        note: 'slow nod (Head_031 x)' });
    case 'blocked':
      return Object.freeze({ state: s, emoji: '⛔', label: 'Stopped',
        breathHz: 0.18, breathAmp: 0.01, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0, wave: false, nod: false, shake: true, jump: false, grey: false,
        note: 'head shake (Head_031 yaw sine)' });
    case 'offline':
      return Object.freeze({ state: s, emoji: '📴', label: 'Offline',
        breathHz: 0.1, breathAmp: 0.005, head: Object.freeze({ pitch: 0.3, roll: 0, yaw: 0 }),
        lean: 0, wave: false, nod: false, shake: false, jump: false, grey: true,
        note: 'grey out (frozen, desaturated)' });
    case 'done':
      return Object.freeze({ state: s, emoji: '✅', label: 'Done',
        breathHz: 0.3, breathAmp: 0.02, head: Object.freeze({ pitch: -0.1, roll: 0, yaw: 0 }),
        lean: -0.05, wave: true, nod: false, shake: false, jump: true, grey: false,
        note: 'jump (root y hop) + wave' });
    default:
      return Object.freeze({ state: 'unknown', emoji: '❓', label: 'Unknown',
        breathHz: 0.2, breathAmp: 0.012, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: `unmapped state "${s}" -> idle` });
  }
}
