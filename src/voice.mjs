// src/voice.mjs — VoicePipeline interface stubs (pure logic only).
//
// Scope: state tracking + text chunking for a future voice loop.
// Explicitly NO mic / speaker / network / model downloads here:
// - no navigator.mediaDevices, no AudioContext, no fetch, no timers.
// - pushTranscript() validates text and emits an event (no STT).
// - requestSpeak() chunks text into <=200-char clauses and returns them
//   (no TTS audio is synthesized; the caller would speak them later).
// - bargeIn() only clears the pending clause queue (no audio ducking).
// - Consequential utterances NEVER speak directly: the helper returns
//   { needsVisualConfirm: true } so the dashboard must show visual UI first.

export const VOICE_STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking']);

export const MAX_CLAUSE_CHARS = 200;
const MAX_TEXT_CHARS = 20000;

// Split on sentence boundaries first, then pack greedily so every clause
// is <= MAX_CLAUSE_CHARS. Pure string logic, no locale model needed.
export function chunkText(text) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?;]+[.!?;]+["'”’)]?\s*|[^.!?;]+$/g) ?? [normalized];
  const clauses = [];
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= MAX_CLAUSE_CHARS) {
      clauses.push(s);
      continue;
    }
    // Long sentence: split on commas/colons first, then on words.
    const parts = s.split(/(?<=[,:])\s+|\s+/);
    let current = '';
    for (const part of parts) {
      if (!part) continue;
      // Single token longer than the cap: hard-slice it (no other option).
      if (part.length > MAX_CLAUSE_CHARS) {
        if (current) {
          clauses.push(current);
          current = '';
        }
        for (let i = 0; i < part.length; i += MAX_CLAUSE_CHARS) {
          clauses.push(part.slice(i, i + MAX_CLAUSE_CHARS));
        }
        continue;
      }
      const next = current ? `${current} ${part}` : part;
      if (next.length <= MAX_CLAUSE_CHARS) {
        current = next;
      } else {
        clauses.push(current);
        current = part;
      }
    }
    if (current) clauses.push(current);
  }
  return clauses;
}

function assertUtterance(text, { allowEmpty = false } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const trimmed = text.trim();
  if (!allowEmpty && !trimmed) throw new TypeError('text must be non-empty');
  if (trimmed.length > MAX_TEXT_CHARS) throw new TypeError('text too long');
  return trimmed;
}

export class VoicePipeline {
  constructor() {
    this.state = 'idle';
    this.config = Object.freeze({ vad: null, stt: null, tts: null });
    this.pending = [];
    this.listeners = new Set();
  }

  getState() {
    return this.state;
  }

  getConfig() {
    return this.config;
  }

  getPending() {
    return this.pending.map((entry) => ({ ...entry }));
  }

  // Store backend *names* only (e.g. { vad: 'silero', stt: 'whisper-tiny', tts: 'piper' }).
  // No models are loaded, no devices opened, no network calls made.
  configure({ vad = null, stt = null, tts = null } = {}) {
    for (const [key, value] of Object.entries({ vad, stt, tts })) {
      if (value !== null && (typeof value !== 'string' || !value.trim())) {
        throw new TypeError(`${key} must be a non-empty string or null`);
      }
    }
    const next = (name) => (typeof name === 'string' ? name.trim() : null);
    this.config = Object.freeze({ vad: next(vad), stt: next(stt), tts: next(tts) });
    this.#emit({ type: 'configured', config: { ...this.config } });
    return this.getConfig();
  }

  subscribe(cb) {
    if (typeof cb !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  startListening() {
    this.#setState('listening', 'start_listening');
    return this.state;
  }

  // Validate a transcript string (as if produced by STT elsewhere) and emit it.
  // Moves listening/idle -> thinking. Pure: does not touch any audio input.
  pushTranscript(text) {
    const clean = assertUtterance(text);
    if (!['idle', 'listening', 'thinking'].includes(this.state)) {
      throw new RangeError(`invalid_transition: pushTranscript not allowed while ${this.state}`);
    }
    this.#setState('thinking', 'transcript');
    const event = Object.freeze({ type: 'transcript', text: clean });
    this.#emit(event);
    return event;
  }

  // Chunk text for speech WITHOUT synthesizing audio. Returns
  // [{ clause, index }]. Queues clauses as pending and moves to speaking.
  requestSpeak(text) {
    const clean = assertUtterance(text);
    if (!['idle', 'listening', 'thinking', 'speaking'].includes(this.state)) {
      throw new RangeError(`invalid_transition: requestSpeak not allowed while ${this.state}`);
    }
    const clauses = chunkText(clean).map((clause, index) => ({ clause, index }));
    if (clauses.length === 0) throw new TypeError('text must be non-empty');
    this.pending = clauses.map((entry) => ({ ...entry }));
    this.#setState('speaking', 'speak_requested');
    return clauses.map((entry) => ({ ...entry }));
  }

  // Cancel pending speech (e.g. user started talking over playback).
  // Pure queue clear + state -> listening. Returns number of clauses dropped.
  bargeIn() {
    const dropped = this.pending.length;
    this.pending = [];
    if (['speaking', 'thinking'].includes(this.state)) {
      this.#setState('listening', 'barge_in');
    }
    this.#emit({ type: 'barge_in', dropped });
    return dropped;
  }

  // Mark speech output as fully played (called by a future audio layer).
  markSpokeDone() {
    this.pending = [];
    this.#setState('idle', 'spoke_done');
    return this.state;
  }

  // Consequential utterances (anything that could authorize, commit, or send
  // something on the user's behalf) MUST be visually confirmed first. This
  // helper never queues audio and never changes state; the dashboard must
  // render the returned text and only call requestSpeak() after explicit UI
  // confirmation.
  proposeConsequentialUtterance(text) {
    const clean = assertUtterance(text);
    return Object.freeze({
      needsVisualConfirm: true,
      text: clean,
      clauses: chunkText(clean).map((clause, index) => ({ clause, index })),
    });
  }

  #setState(next, reason) {
    if (!VOICE_STATES.includes(next)) throw new RangeError(`unknown voice state: ${next}`);
    const from = this.state;
    this.state = next;
    this.#emit({ type: 'state', from, to: next, reason });
  }

  #emit(event) {
    const frozen = Object.isFrozen(event) ? event : Object.freeze({ ...event });
    for (const cb of [...this.listeners]) {
      try {
        cb(frozen);
      } catch {
        // Listener errors never break pipeline logic.
      }
    }
  }
}
