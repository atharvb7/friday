// public/pet.js — tiny display-only pet renderer (currently unreferenced).
// No auto-init: importing this module touches no DOM, starts no timers,
// performs no fetch. A future dashboard change may import renderPet() and
// call it with PetStateMachine state (or /v1/status-derived state).
// This module NEVER grants authority; it only picks an emoji + label.

const PET_FACES = Object.freeze({
  sleeping: { emoji: '😴', label: 'Sleeping' },
  listening: { emoji: '👂', label: 'Listening' },
  thinking: { emoji: '💭', label: 'Thinking' },
  acting: { emoji: '🐾', label: 'Acting' },
  waiting: { emoji: '⏳', label: 'Waiting for approval' },
  blocked: { emoji: '⛔', label: 'Stopped' },
  offline: { emoji: '📴', label: 'Offline' },
  done: { emoji: '✅', label: 'Done' },
});

export function renderPet(state) {
  const face = PET_FACES[String(state)] ?? { emoji: '❓', label: 'Unknown' };
  return { emoji: face.emoji, label: face.label };
}

export const PET_STATES = Object.freeze(Object.keys(PET_FACES));
