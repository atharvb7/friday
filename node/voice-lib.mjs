// Pure helpers for the push-to-talk key (node/voice-key.mjs): config, energy VAD, WAV encoding, "is this about the
// screen?", sentence chunking for speech, cue tones, notification text and the single-instance lock.
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Laptop voice = the server default (same soft Kokoro Heart + Nicole blend, 0.92): 0 word errors in every test run,
// 149 words/min, ~3x faster than real time on the laptop CPU (outputs/friday-voice-samples-v2). Kokoro drops voice tags
// silently. Overridable in ~/.friday-node/voice.json -> "voice": {...}.
export const LOCAL_VOICE = Object.freeze({ engine: 'kokoro', voice: 'af_heart:50,af_nicole:50', speed: 0.92, pitch: 1.0 });

export const DEFAULTS = Object.freeze({
  rate: 16000,
  maxSeconds: 30,        // hard cap on one recording
  silenceMs: 2200,       // this much quiet after speech ends the recording (1.3 s cut him off mid-sentence on 28 Oct:
                         // people pause 1-2 s while thinking "play... um... some lofi"); a second press still stops at once
  noSpeechMs: 6000,      // nothing said this long after the beep -> give up
  minSpeechMs: 350,      // shorter than this is a cough or a click, not a question
  followupMinutes: 10,   // presses within this window continue the same conversation
  lingerMinutes: 10,     // stay resident (models warm) this long after a turn; 0 = exit at once
  stt: 'auto',           // auto (laptop Whisper if installed, else server) | local | server
  tts: 'auto',           // auto (laptop voice if installed, else server) | local | server | off
  screen: 'auto',        // auto (only when the question is about the screen) | always | never
  screenMaxWidth: 1440,  // screenshot is downscaled to this width and sent as JPEG (~60-150 KB, ~1k model tokens)
  cues: true,
  volume: 0.25,          // cue loudness (0-1)
  voice: LOCAL_VOICE,
});

export function loadConfig({ env = process.env, home = homedir() } = {}) {
  const dir = env.FRIDAY_NODE_HOME ?? join(home, '.friday-node');
  const read = (f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return {}; } };
  const node = read('config.json'); const voice = read('voice.json');
  const cfg = { ...DEFAULTS, ...voice, voice: { ...LOCAL_VOICE, ...(voice.voice ?? {}) } };
  cfg.server = String(env.FRIDAY_VOICE_SERVER ?? voice.server ?? node.server ?? '').replace(/\/+$/, '');
  // The laptop node's own token usually has only read,node scopes; voice needs 'chat' (a separate device token).
  cfg.token = env.FRIDAY_VOICE_TOKEN ?? voice.token ?? node.token ?? '';
  cfg.tokenSource = env.FRIDAY_VOICE_TOKEN ? 'env' : voice.token ? 'voice.json' : node.token ? 'config.json' : 'none';
  cfg.localVoiceHome = env.FRIDAY_LOCAL_VOICE_HOME ?? voice.localVoiceHome ?? join(home, '.local', 'share', 'friday-voice');
  cfg.dir = dir;
  return cfg;
}

// ---------- audio ----------
export const dbfs = (samples) => {
  if (!samples.length) return -120;
  let s = 0; for (const v of samples) s += v * v;
  const rms = Math.sqrt(s / samples.length);
  return rms > 0 ? 20 * Math.log10(rms / 32768) : -120;
};

// Energy VAD over 30 ms frames. The first ~240 ms calibrate the noise floor (median, ignoring the digital zeros a
// stream starts with); afterwards the floor follows the room (fast down, slowly up, so a fan becomes "quiet" within
// seconds but a sentence barely moves it). Speech = 3 consecutive frames 10 dB over the floor, threshold kept within
// [-50, -30] dBFS. Measured on this laptop's digital mic: room -48 dBFS -> threshold -38. Once he is talking the bar
// drops to 6 dB over the floor (hysteresis), so soft trailing words ("...and play stuff") are not taken for silence.
const CALIBRATION_FRAMES = 8;
export class Vad {
  constructor({ rate = 16000, frameMs = 30, silenceMs = DEFAULTS.silenceMs, noSpeechMs = DEFAULTS.noSpeechMs, minSpeechMs = DEFAULTS.minSpeechMs, maxMs = DEFAULTS.maxSeconds * 1000 } = {}) {
    Object.assign(this, { rate, frameMs, silenceMs, noSpeechMs, minSpeechMs, maxMs });
    this.frameLen = Math.round(rate * frameMs / 1000);
    this.pending = []; this.frames = 0; this.floor = null; this.calib = []; this.voicedRun = 0; this.quietRun = 0;
    this.speechStartFrame = null; this.speechFrames = 0; this.lastVoicedFrame = null; this.allZero = true; this.done = null;
  }
  get elapsedMs() { return this.frames * this.frameMs; }
  get threshold() { return Math.min(-30, Math.max(-50, (this.floor ?? -60) + (this.speechStartFrame === null ? 10 : 6))); }
  // samples: Int16Array (any length). Returns null while recording should continue, else { reason }.
  push(samples) {
    if (this.done) return this.done;
    for (const v of samples) this.pending.push(v);
    while (this.pending.length >= this.frameLen && !this.done) this.#frame(this.pending.splice(0, this.frameLen));
    return this.done;
  }
  #frame(f) {
    this.frames += 1;
    if (this.allZero && f.some((v) => v !== 0)) this.allZero = false;
    const db = dbfs(f);
    let voiced = false;
    if (this.frames <= CALIBRATION_FRAMES) {
      if (db > -85) this.calib.push(db);
      if (this.frames === CALIBRATION_FRAMES) { const c = this.calib.sort((a, b) => a - b); this.floor = c.length ? c[Math.floor(c.length / 2)] : null; }
    } else {
      voiced = db > this.threshold;
      if (db > -85) {
        if (this.floor === null) this.floor = db;
        else if (db < this.floor) this.floor += 0.3 * (db - this.floor);
        // after he starts talking the floor creeps up only slowly: soft words just under the bar must not raise it
        // (it climbed -50 -> -45 dB inside one soft phrase and cut "...and play stuff" off)
        else this.floor += (voiced || this.speechStartFrame !== null ? 0.004 : 0.05) * (db - this.floor);
      }
    }
    if (voiced) { this.voicedRun += 1; this.quietRun = 0; } else { this.voicedRun = 0; this.quietRun += 1; }
    if (voiced) { if (this.speechStartFrame === null && this.voicedRun >= 3) { this.speechStartFrame = this.frames - 3; this.speechFrames = 2; } if (this.speechStartFrame !== null) { this.speechFrames += 1; this.lastVoicedFrame = this.frames; } }
    const ms = this.elapsedMs;
    if (this.allZero && ms >= 1000) this.done = { reason: 'mic_silent' };
    else if (this.speechStartFrame !== null && this.quietRun * this.frameMs >= this.silenceMs) this.done = { reason: 'silence' };
    else if (this.speechStartFrame === null && ms >= this.noSpeechMs) this.done = { reason: 'no_speech' };
    else if (ms >= this.maxMs) this.done = { reason: 'max' };
  }
  // After stopping: was anything worth sending said? Also where to cut (keep 300 ms before speech, 400 ms after).
  summary() {
    const speechMs = this.speechFrames * this.frameMs;
    const heard = this.speechStartFrame !== null && speechMs >= this.minSpeechMs;
    const from = heard ? Math.max(0, this.speechStartFrame - 10) * this.frameLen : 0;
    const to = heard ? Math.min(this.frames, (this.lastVoicedFrame ?? this.frames) + 14) * this.frameLen : 0;
    return { heard, speechMs, from, to, micSilent: this.allZero && this.frames > 0, floorDb: this.floor };
  }
}

export function wavFromPcm16(pcm, rate = 16000, channels = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Soft sine cues with short fades (no clicks): start = rising, stop = falling, error = low double blip.
export function cueWav(kind, { rate = 24000, volume = 0.25 } = {}) {
  const notes = { start: [[660, 70], [880, 90]], stop: [[880, 70], [660, 90]], error: [[330, 110], [0, 60], [330, 110]], cancel: [[520, 80]] }[kind] ?? [[660, 80]];
  const out = [];
  for (const [hz, ms] of notes) {
    const n = Math.round(rate * ms / 1000); const fade = Math.round(rate * 0.012);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / fade, (n - 1 - i) / fade);
      out.push(hz ? Math.round(Math.sin(2 * Math.PI * hz * i / rate) * env * volume * 32767) : 0);
    }
  }
  return wavFromPcm16(Int16Array.from(out), rate);
}

// ---------- language ----------
// Only these get a screenshot (token-efficient: an image costs ~1k prompt tokens plus a vision call). Deliberately
// about deixis ("this error", "read this") and explicit screen words; "read this book later" style false positives are
// cheap, missing a real one is not.
const SCREEN_RE = [
  /\b(on|of|at) (my|the|this|your) (screen|display|monitor)\b/i,
  /\b(screen ?shot|screen ?grab|screen)\b.*\b(see|show|look|read|what|explain|check|tell)\b/i,
  /\b(see|show|look|read|what|explain|check|tell)\b.*\bscreen\b/i,
  /\b(this|that|these) (error|warning|message|popup|pop-up|dialog|window|page|tab|site|website|code|line|function|output|log|graph|chart|table|email|mail|text|paragraph|document|doc|pdf|slide|form|button|setting|notification|image|picture|photo|diagram|equation|question|problem|word)s?\b/i,
  /\b(read|summari[sz]e|translate|explain|describe|proofread)( out)? (this|that|it|these|what i'?m)\b/i,
  /\bwhat('?s| is| does| do)? (this|that) (say|mean|show|do)\b/i,
  /\bwhat am i (looking at|seeing)\b/i,
  /\b(can|do) you see\b/i,
  /\blook at (this|that|my|it)\b/i,
  /\bwhat('?s| is) (this|that)\??$/i,
];
export const needsScreen = (text) => SCREEN_RE.some((r) => r.test(String(text ?? '')));

// Chunks for sentence-by-sentence speech: the first chunk is one short sentence (fast start), later ones group
// sentences up to ~maxLen. Voice tags stay with their sentence.
export function speechChunks(text, maxLen = 220) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const sentences = t.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];
  const out = [];
  for (const s of sentences) {
    const last = out.at(-1);
    const tagOnly = /^(\[[a-z ]+\]\s*)+$/i.test(s);
    if (last !== undefined && (tagOnly || (out.length > 1 || last.length < 25) && last.length + s.length + 1 <= maxLen)) out[out.length - 1] = `${last} ${s}`;
    else out.push(s);
  }
  return out.flatMap((c) => (c.length <= maxLen * 2 ? [c] : c.match(new RegExp(`.{1,${maxLen}}(\\s|$)`, 'g')).map((x) => x.trim())));
}

const VOICE_TAGS = /\s*\[(?:laugh|chuckle|sigh|gasp|groan|sniff|cough|clear throat|shush|whispering|happy|sarcastic|surprised|dramatic|angry|crying|fear|narration|advertisement)\]\s*/gi;
export const stripTags = (t) => String(t ?? '').replace(VOICE_TAGS, ' ').replace(/\s{2,}/g, ' ').trim();
// GNOME notification bodies are markup: escape it, and keep them short.
export const notifyText = (t, max = 300) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return (s.length > max ? `${s.slice(0, max - 1)}…` : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

// Human message for a failure (what the notification says).
export function explainError(e) {
  const m = String(e?.message ?? e ?? '');
  if (e?.name === 'TimeoutError' || /due to timeout|timed? ?out/i.test(m)) return 'Friday’s server took too long to answer. Try again in a moment.';
  if (e?.name === 'AbortError' || /aborted|cancel/i.test(m)) return null;
  const cause = String(e?.cause?.code ?? e?.cause?.message ?? '');
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN|fetch failed|UND_ERR|socket/i.test(`${m} ${cause}`)) return 'Can’t reach Friday’s server (offline, or Tailscale is down).';
  if (/\b401\b|unauthorized/i.test(m)) return 'Friday rejected the voice token. Run node/voice-key-install.sh again with a new token.';
  if (/\b403\b|forbidden/i.test(m)) return 'This token can’t chat. Create a device with scopes read,chat and put its token in ~/.friday-node/voice.json.';
  if (/\b501\b|not_installed/i.test(m)) return 'Speech-to-text isn’t installed on the server (and not on this laptop).';
  if (/\b50[23]\b|busy/i.test(m)) return 'Friday is busy right now, try again in a moment.';
  if (/mic|pw-record|audio source/i.test(m)) return 'Microphone unavailable (busy, muted or missing).';
  return `Something went wrong: ${m.slice(0, 120)}`;
}

// ---------- single instance ----------
// The lock file holds the pid of the resident instance. A second press finds it and signals that process instead.
// isOurs(pid) must confirm the pid is alive AND is a voice-key process (pids get reused).
export function acquireLock(path, { pid = process.pid, isOurs }) {
  for (let i = 0; i < 3; i++) {
    try { const fd = openSync(path, 'wx', 0o600); writeSync(fd, String(pid)); closeSync(fd); return { owner: true }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let other = NaN; try { other = Number(readFileSync(path, 'utf8').trim()); } catch { /* vanished */ }
      if (Number.isInteger(other) && other > 0 && other !== pid && isOurs(other)) return { owner: false, pid: other };
      try { rmSync(path, { force: true }); } catch { /* raced */ }
    }
  }
  return { owner: false, pid: null };
}
export function releaseLock(path, pid = process.pid) {
  try { if (existsSync(path) && Number(readFileSync(path, 'utf8').trim()) === pid) rmSync(path, { force: true }); } catch { /* gone */ }
}
