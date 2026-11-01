// public/voice.js — VoiceBar module (no build, browser-only at runtime).
//
// - Pure helpers at top (chunkSpeak, parseInterim): THREE/DOM-free, safe to
//   import in node for tests. They never touch document/window/navigator.
// - DOM + browser-audio wiring lives ONLY inside initVoiceBar()/speak() and
//   runs when those functions are called in a browser. Importing this module
//   has no side effects: no listeners, no timers, no fetch, no mic access.
//
// Expected element ids (see public/voice-snippet.html):
//   #voice-mic      — push-to-talk button (wired by initVoiceBar)
//   #voice-speaker   — speaker mute toggle (optional; wired if present)
//   #voice-status    — status line (optional; written if present)
//   #task-instruction— existing compose textarea (interim text goes here)
//   #toast           — existing toast node reused for friendly errors
//
// Stroage/network: none. Mic is only touched via Web Speech API after an
// explicit user gesture (mousedown on #voice-mic).

export const VOICE_MAX_CHUNK = 200;

/**
 * Split text into speech-friendly chunks, each <= max chars.
 * Pure string logic: sentence-aware, greedy word-pack, hard-slices
 * single tokens longer than max. Throws TypeError on non-string input.
 * Returns [] for blank input.
 */
export function chunkSpeak(text, max = 200) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const limit = Number(max) > 0 ? Math.floor(Number(max)) : VOICE_MAX_CHUNK;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?;]+[.!?;]+["'”’)]?\s*|[^.!?;]+$/g) ?? [normalized];
  const clauses = [];
  const pushTokens = (words) => {
    let current = '';
    for (const word of words) {
      if (!word) continue;
      if (word.length > limit) {
        if (current) {
          clauses.push(current);
          current = '';
        }
        for (let i = 0; i < word.length; i += limit) {
          clauses.push(word.slice(i, i + limit));
        }
        continue;
      }
      const next = current ? `${current} ${word}` : word;
      if (next.length <= limit) {
        current = next;
      } else {
        clauses.push(current);
        current = word;
      }
    }
    if (current) clauses.push(current);
  };
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= limit) {
      clauses.push(s);
      continue;
    }
    // Long sentence: prefer comma/colon breaks, else word boundaries.
    const parts = s.split(/(?<=[,:])\s+|\s+/);
    pushTokens(parts);
  }
  return clauses;
}

/**
 * Split a Web Speech API onresult event into interim vs final text.
 * Pure: accepts the event (or a plain { resultIndex, results } shape) and
 * returns { interim, final }. Never touches the DOM.
 *
 * Each entry of results looks like { isFinal, 0: { transcript } }.
 * Only results from resultIndex onward are read (matches the
 * SpeechRecognition spec for incremental onresult delivery).
 */
export function parseInterim(event) {
  if (!event || typeof event !== 'object') return { interim: '', final: '' };
  const results = event.results;
  if (!results || typeof results.length !== 'number') return { interim: '', final: '' };
  const from = Number(event.resultIndex) > 0 ? Math.floor(Number(event.resultIndex)) : 0;
  let interim = '';
  let final = '';
  for (let i = from; i < results.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    const alt = result[0];
    const transcript = typeof alt?.transcript === 'string' ? alt.transcript.trim() : '';
    if (!transcript) continue;
    if (result.isFinal) final += (final ? ' ' : '') + transcript;
    else interim += (interim ? ' ' : '') + transcript;
  }
  return { interim, final };
}

// ---------------------------------------------------------------------------
// Browser-only runtime below. Nothing here runs at import time.
// ---------------------------------------------------------------------------

const TOAST_MS = 3400;

function getDoc() {
  return typeof document === 'undefined' ? null : document;
}

function toast(message) {
  const doc = getDoc();
  if (!doc) return;
  try {
    const node = doc.querySelector('#toast');
    if (!node) return;
    node.textContent = String(message);
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.hidden = true;
    }, TOAST_MS);
  } catch {
    // Toast is best-effort; voice must never throw from UI feedback.
  }
}

function setStatus(message) {
  const doc = getDoc();
  if (!doc) return;
  try {
    const node = doc.querySelector('#voice-status');
    if (node) node.textContent = String(message);
  } catch {
    // ignore
  }
}

function getRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function isSecureOk() {
  try {
    if (typeof window !== 'undefined' && 'isSecureContext' in window) {
      return window.isSecureContext !== false;
    }
  } catch {
    // fall through to allow: some browsers lack the flag on localhost
  }
  return true;
}

function cancelSpeech() {
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } catch {
    // ignore
  }
}

let speakerMuted = false;

function isMuted() {
  try {
    const doc = getDoc();
    const toggle = doc?.querySelector('#voice-speaker');
    if (toggle?.getAttribute('aria-pressed') === 'true') return true;
  } catch {
    // ignore
  }
  return speakerMuted;
}

/**
 * Speak text via speechSynthesis, chunked to <= VOICE_MAX_CHUNK chars.
 * Barge-in safe: cancels any in-flight speech first. No-op (returning [])
 * when speechSynthesis is unavailable (e.g. node/tests) or muted.
 * Returns the chunk list actually queued.
 */
export function speak(text) {
  const chunks = chunkSpeak(String(text ?? ''));
  if (chunks.length === 0) return [];
  if (typeof window === 'undefined' || !window.speechSynthesis) return chunks;
  if (isMuted()) return chunks;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    let index = 0;
    const step = () => {
      if (isMuted()) {
        try {
          synth.cancel();
        } catch {
          // ignore
        }
        return;
      }
      if (index >= chunks.length) return;
      const utter = new window.SpeechSynthesisUtterance(chunks[index]);
      utter.rate = 1;
      utter.pitch = 1;
      index += 1;
      utter.onend = () => step();
      utter.onerror = () => {
        // Stop the chain on error; keep it silent (status line only).
        setStatus('Speech playback stopped.');
      };
      synth.speak(utter);
    };
    step();
  } catch {
    // Speech is enhancement-only; never throw into the app.
  }
  return chunks;
}

export function stopSpeaking() {
  cancelSpeech();
}

/**
 * Wire the VoiceBar controls.
 *
 * @param {{ onText?: (finalText: string) => void }} opts
 * @returns cleanup handle { stop, isSupported }
 */
export function initVoiceBar({ onText } = {}) {
  const doc = getDoc();
  const noop = { stop: () => {}, isSupported: false };
  if (!doc) return noop;
  const mic = doc.querySelector('#voice-mic');
  const field = doc.querySelector('#task-instruction');
  if (!mic) return noop;

  const onFinal = typeof onText === 'function' ? onText : () => {};

  const Recognition = getRecognitionCtor();
  if (!Recognition) {
    mic.disabled = true;
    mic.title = 'Voice input is not supported in this browser (try Chrome on desktop/Android).';
    setStatus('Voice input not supported here.');
    wireSpeakerToggle(doc);
    return { stop: () => {}, isSupported: false };
  }

  if (!isSecureOk()) {
    mic.disabled = true;
    mic.title = 'Voice input needs HTTPS or localhost.';
    setStatus('Voice needs HTTPS or localhost.');
    toast('Voice input needs HTTPS or localhost — mic is disabled.');
    wireSpeakerToggle(doc);
    return { stop: () => {}, isSupported: false };
  }

  let rec = null;
  let listening = false;
  let baseText = '';
  let finalSoFar = '';

  const setMicUI = (active) => {
    try {
      mic.classList.toggle('live', active);
      mic.setAttribute('aria-pressed', String(active));
      mic.textContent = active ? '● Listening…' : '🎤 Speak';
    } catch {
      // ignore
    }
  };

  const start = (event) => {
    if (event?.preventDefault) event.preventDefault();
    if (listening) return;
    // Barge-in: mic start cancels any speech playback.
    cancelSpeech();
    try {
      baseText = field?.value ?? '';
      finalSoFar = '';
      rec = new Recognition();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;

      rec.onresult = (e) => {
        const { interim, final } = parseInterim(e);
        if (final) finalSoFar += (finalSoFar ? ' ' : '') + final;
        const combined = [finalSoFar, interim].filter(Boolean).join(' ');
        if (field && combined) {
          const prefix = baseText ? `${baseText} ` : '';
          field.value = `${prefix}${combined}`;
          try {
            field.dispatchEvent(new Event('input', { bubbles: true }));
          } catch {
            // ignore
          }
        }
      };

      rec.onerror = (e) => {
        const code = e?.error || '';
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          toast('Microphone blocked — allow mic access for this site, then try again.');
          setStatus('Mic permission denied.');
        } else if (code === 'audio-capture') {
          toast('No microphone found — check the device input.');
          setStatus('No microphone found.');
        } else if (code !== 'aborted' && code !== 'no-speech') {
          toast('Voice input had a hiccup — try again.');
          setStatus('Voice hiccup; try again.');
        }
      };

      rec.onend = () => {
        listening = false;
        setMicUI(false);
        setStatus('Voice ready.');
        const done = finalSoFar.trim();
        if (done) onFinal(done);
      };

      rec.start();
      listening = true;
      setMicUI(true);
      setStatus('Listening… release to stop.');
    } catch (err) {
      listening = false;
      setMicUI(false);
      const name = err?.name || '';
      if (name === 'NotAllowedError') {
        toast('Microphone blocked — allow mic access for this site, then try again.');
        setStatus('Mic permission denied.');
      } else if (name === 'InvalidStateError') {
        // Already started; harmless.
      } else {
        toast('Could not start voice input — try again.');
        setStatus('Voice could not start.');
      }
    }
  };

  const stop = () => {
    if (!listening || !rec) return;
    try {
      rec.stop();
    } catch {
      try {
        rec.abort?.();
      } catch {
        // ignore
      }
    }
    // onend resets UI + fires onFinal.
  };

  // Push-to-talk: press-and-hold. Click toggles for keyboard users.
  mic.addEventListener('mousedown', start);
  mic.addEventListener('touchstart', start, { passive: false });
  mic.addEventListener('mouseup', stop);
  mic.addEventListener('mouseleave', () => {
    if (listening) stop();
  });
  mic.addEventListener('touchend', stop);
  mic.addEventListener('touchcancel', stop);
  mic.addEventListener('click', (e) => {
    // Keyboard/AT click: toggle. Mouse users already handled via down/up,
    // so ignore clicks that follow a real press-hold cycle start+stop.
    if (e.detail === 0) {
      if (listening) stop();
      else start(e);
    }
  });
  mic.title = 'Hold to talk (interim shows in Instructions; release sends final)';

  const cleanupSpeaker = wireSpeakerToggle(doc);
  setStatus('Voice ready.');

  return {
    isSupported: true,
    stop: () => {
      try {
        mic.removeEventListener('mousedown', start);
        mic.removeEventListener('touchstart', start);
        mic.removeEventListener('mouseup', stop);
        mic.removeEventListener('touchend', stop);
        mic.removeEventListener('touchcancel', stop);
        if (listening && rec) rec.abort?.();
      } catch {
        // ignore
      }
      listening = false;
      setMicUI(false);
      cleanupSpeaker?.();
    },
  };
}

function wireSpeakerToggle(doc) {
  try {
    const toggle = doc.querySelector('#voice-speaker');
    if (!toggle) return () => {};
    const paint = () => {
      const muted = toggle.getAttribute('aria-pressed') === 'true';
      toggle.textContent = muted ? '🔇 Muted' : '🔊 Speak';
      toggle.title = muted ? 'Speech output off (click to enable)' : 'Speech output on (click to mute)';
    };
    const onClick = () => {
      const muted = toggle.getAttribute('aria-pressed') === 'true';
      toggle.setAttribute('aria-pressed', String(!muted));
      speakerMuted = !muted;
      if (!muted) cancelSpeech(); // muting stops playback immediately
      paint();
    };
    toggle.setAttribute('aria-pressed', 'false');
    paint();
    toggle.addEventListener('click', onClick);
    return () => toggle.removeEventListener('click', onClick);
  } catch {
    return () => {};
  }
}
