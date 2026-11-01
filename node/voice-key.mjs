#!/usr/bin/env node
// Friday push-to-talk for the laptop. Bound to a GNOME custom shortcut (node/voice-key-install.sh), so it works whatever
// app is focused:
//   press      -> beep, listen (stops on ~2.2 s of silence, at 30 s, or when you press again) -> beep
//              -> transcribe (laptop Whisper if installed, else the server) -> screenshot only if the question is about
//                 the screen -> Friday answers (server brain, 'voice' channel) -> spoken here (laptop voice if installed,
//                 else the server's voice) + a notification with the transcript and the answer.
//   press while she thinks = cancel; press while she talks = stop talking and listen again.
// One resident instance: a second launch finds the lock and signals it (SIGUSR1 = press, SIGUSR2 = press + screenshot),
// then exits. The resident instance keeps Whisper/the voice warm for `lingerMinutes`, then exits.
//
//   node voice-key.mjs                 press (what the shortcut runs)
//   node voice-key.mjs --screen        press, and always attach a screenshot
//   node voice-key.mjs --status        show what it would use (server, token source, local STT/TTS); no secrets printed
//   node voice-key.mjs --say "text"    speak text with the configured voice (test the voice, no server needed)
//   node voice-key.mjs --wav f.wav     use a recording instead of the mic (smoke tests)
//   node voice-key.mjs --text "..."    skip recording and transcription (smoke tests)
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PythonWorker } from '../src/voice-worker.mjs';
import { acquireLock, cueWav, DEFAULTS, loadConfig, releaseLock, Vad, wavFromPcm16 } from './voice-lib.mjs';
import { VoiceSession } from './voice-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'voice', 'engine.py');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const log = (...a) => console.error(new Date().toISOString(), 'voice-key:', ...a); // events only, never transcripts
const cfg = loadConfig();
const RUN = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : tmpdir();
const LOCK = join(RUN, 'friday-voice-key.pid');
const STATE = join(cfg.dir, 'voice-state.json');

// ---------- what is available ----------
const py = join(cfg.localVoiceHome, 'venv', 'bin', 'python');
const models = join(cfg.localVoiceHome, 'models');
const has = (...f) => existsSync(join(models, ...f));
const localEngine = existsSync(py) && existsSync(ENGINE);
const localStt = localEngine && has('whisper') && readdirSync(join(models, 'whisper')).length > 0;
const localTts = localEngine && has('kokoro-v1.0.onnx') && has('voices-v1.0.bin');
const useLocalStt = cfg.stt === 'local' || (cfg.stt === 'auto' && localStt);
const useLocalTts = cfg.tts === 'local' || (cfg.tts === 'auto' && localTts);

if (flag('status')) {
  console.log(JSON.stringify({ server: cfg.server || null, token: cfg.token ? `set (from ${cfg.tokenSource})` : 'MISSING', stt: useLocalStt ? `laptop (${cfg.localVoiceHome})` : 'server', tts: cfg.tts === 'off' ? 'off' : useLocalTts ? `laptop ${cfg.voice.engine} ${cfg.voice.voice} x${cfg.voice.speed}` : 'server', screen: cfg.screen, lock: LOCK }, null, 2));
  process.exit(0);
}

// ---------- single instance ----------
// Handlers go in BEFORE the lock exists: a fast second press must never hit the default SIGUSR1 action (terminate).
let session = null; const early = [];
process.on('SIGUSR1', () => (session ? session.press() : early.push({})));
process.on('SIGUSR2', () => (session ? session.press({ screen: 'always' }) : early.push({ screen: 'always' })));
const isOurs = (pid) => { try { process.kill(pid, 0); return /voice-key\.mjs/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; } };
const SAY = flag('say') ? (opt('say') || 'Hi, I am Friday.') : null; // a voice check never takes the lock (or signals the resident instance)
const lock = SAY !== null ? { owner: true } : acquireLock(LOCK, { isOurs });
if (!lock.owner) {
  if (lock.pid) { try { process.kill(lock.pid, flag('screen') ? 'SIGUSR2' : 'SIGUSR1'); process.exit(0); } catch { /* it just exited */ } }
  log('could not take the lock'); process.exit(1);
}

const tmp = mkdtempSync(join(RUN, 'friday-voice-'));
const children = new Set();
let worker = null;
function cleanup() { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } worker?.stop(); rmSync(tmp, { recursive: true, force: true }); releaseLock(LOCK); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(0); });
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } releaseLock(LOCK); });

// ---------- side effects ----------
function run(cmd, argv, { input = null, signal = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = execFile(cmd, argv, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, ...(signal ? { signal } : {}) }, (e, out, err) => { children.delete(c); e ? reject(Object.assign(e, { stderr: String(err ?? '') })) : resolve(out); });
    children.add(c);
    if (input) c.stdin.end(input);
  });
}
let seq = 0;
const tmpFile = (ext, buf) => { const f = join(tmp, `${++seq}.${ext}`); writeFileSync(f, buf, { mode: 0o600 }); return f; };

function play(wav, { signal = null } = {}) {
  const f = tmpFile('wav', wav);
  return run('pw-play', [f], { signal, timeoutMs: 5 * 60_000 }).catch((e) => { if (!signal?.aborted) throw new Error(`playback failed: ${String(e.stderr || e.message).slice(0, 100)}`); }).finally(() => rmSync(f, { force: true }));
}
const cues = {};
const cue = (kind) => (cfg.cues ? play(cues[kind] ??= cueWav(kind, { volume: cfg.volume })).catch(() => {}) : Promise.resolve());

async function notify({ title, body, transient = true, replace = null }) {
  const a = ['-a', 'Friday', '-p', '-i', 'audio-input-microphone', ...(transient ? ['-e'] : []), ...(replace ? ['-r', String(replace)] : []), title, body ?? ''];
  return Number(String(await run('notify-send', a, { timeoutMs: 5000 })).trim()) || null;
}
const closeNotification = (id) => run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications', '--method', 'org.freedesktop.Notifications.CloseNotification', String(id)], { timeoutMs: 3000 }).then(() => new Promise((r) => setTimeout(r, 300))).catch(() => {});

// Mic -> energy VAD. pw-record writes raw 16 kHz mono s16 to stdout; stopping = killing it.
function recordMic({ signal }) {
  const vad = new Vad({ rate: DEFAULTS.rate, silenceMs: cfg.silenceMs, noSpeechMs: cfg.noSpeechMs, minSpeechMs: cfg.minSpeechMs, maxMs: cfg.maxSeconds * 1000 });
  const chunks = []; let stderr = ''; let finished = false; let resolveDone; let watchdog = null; const started = Date.now();
  const done = new Promise((r) => { resolveDone = r; });
  const finish = (error = null) => {
    if (finished) return; finished = true; clearInterval(watchdog);
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const pcm = Buffer.concat(chunks); const s = vad.summary();
    resolveDone({ error, heard: s.heard, micSilent: s.micSilent, reason: vad.done?.reason ?? 'stopped', wav: s.heard ? wavFromPcm16(pcm.subarray(s.from * 2, s.to * 2 || pcm.length)) : null });
  };
  const child = spawn('pw-record', ['--raw', '--rate', String(DEFAULTS.rate), '--channels', '1', '--format', 's16', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let carry = Buffer.alloc(0);
  child.stdout.on('data', (b) => {
    if (finished) return;
    chunks.push(b);
    const buf = carry.length ? Buffer.concat([carry, b]) : b; const even = buf.length - (buf.length % 2);
    carry = buf.subarray(even);
    if (vad.push(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + even)))) finish();
  });
  child.stderr.on('data', (b) => { stderr += b; });
  child.on('error', (e) => finish(e.code === 'ENOENT' ? 'pw-record is not installed' : e.message));
  child.on('close', (code) => { children.delete(child); finish(finished || code === 0 || code === null ? null : `pw-record exited ${code}: ${stderr.trim().slice(0, 120) || 'no audio source'}`); });
  signal?.addEventListener('abort', () => finish(), { once: true });
  // No source (or a stuck one) sends no data at all: never wait forever for the VAD.
  watchdog = setInterval(() => {
    if (finished) return clearInterval(watchdog);
    if (!chunks.length && Date.now() - started > 2500) finish('no audio from the microphone (missing or in use?)');
    else if (Date.now() - started > cfg.maxSeconds * 1000 + 3000) finish();
  }, 250);
  return { stop: () => finish(), done };
}

// --wav: a recording instead of the mic (converted with ffmpeg, then the same VAD/trim as live audio).
function recordFile(path) {
  return () => {
    const done = (async () => {
      const pcm = await run('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(DEFAULTS.rate), '-f', 's16le', '-']);
      const vad = new Vad({ rate: DEFAULTS.rate, maxMs: 600_000, noSpeechMs: 600_000, silenceMs: 600_000 });
      vad.push(new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2))));
      const s = vad.summary();
      return { heard: s.heard, micSilent: s.micSilent, reason: 'file', wav: s.heard ? wavFromPcm16(pcm.subarray(s.from * 2, s.to * 2)) : null };
    })();
    return { stop() {}, done };
  };
}

// Server calls. Errors carry the HTTP status in the message so explainError can say something useful.
async function api(path, { body, type = 'application/json', signal, timeoutMs = 120_000, raw = false }) {
  if (!cfg.server) throw new Error('no server configured: pair the laptop node first (~/.friday-node/config.json)');
  const s = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const res = await fetch(cfg.server + path, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body, signal: s });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`server ${res.status}: ${j.error ?? res.statusText}`); }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

// Whisper leans towards words in this prompt. Short spoken commands carry little context ("play Starboy" was heard as
// "Police Starboy" and "Plishtarva", 28 Oct), so it lists the command verbs and app names he actually uses.
const sttPrompt = 'Friday, play Starboy on Brave. Pause the music. Open YouTube, Spotify, WhatsApp, VS Code on my laptop. What is on my screen? Remind me tomorrow. Atharv, yaar, accha, haan, bro.';
const pyWorker = () => (worker ??= new PythonWorker({ python: py, script: ENGINE, idleMs: Math.max(60_000, cfg.lingerMinutes * 60_000), timeoutMs: 120_000, env: { FRIDAY_VOICE_HOME: cfg.localVoiceHome, FRIDAY_STT_MODEL: cfg.sttModel ?? 'small', FRIDAY_VOICE_THREADS: String(cfg.sttThreads ?? 6), ...(cfg.ttsThreads ? { FRIDAY_TTS_THREADS: String(cfg.ttsThreads) } : {}) } }));

async function transcribe(wav, { signal }) {
  if (useLocalStt) {
    const f = tmpFile('wav', wav);
    try {
      const r = await pyWorker().call({ op: 'stt', wav: f, lang: 'en', prompt: sttPrompt });
      if (r.ok) return r.text; log('local stt failed, using the server:', r.error);
    } finally { rmSync(f, { force: true }); }
  }
  return (await api('/v1/voice/transcribe', { body: wav, type: 'audio/wav', signal, timeoutMs: 90_000 })).text;
}

async function screenshot() {
  const out = JSON.parse(String(await run('python3', [join(HERE, 'portal-screenshot.py'), '10'], { timeoutMs: 15_000 })));
  if (!out.path) throw new Error(out.error ?? 'screenshot failed');
  try {
    const jpg = await run('ffmpeg', ['-v', 'error', '-i', out.path, '-vf', `scale='min(${cfg.screenMaxWidth},iw)':-2`, '-q:v', '5', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']);
    return { mime: 'image/jpeg', data: jpg.toString('base64') };
  } finally { rmSync(out.path, { force: true }); } // the portal saved it in ~/Pictures; it was only for this question
}

const turn = (b, { signal }) => api('/v1/voice/turn', { body: b, signal, timeoutMs: 180_000 });

let localTtsBroken = false;
async function synth(text, { signal }) {
  if (useLocalTts && !localTtsBroken) {
    const out = join(tmp, `${++seq}-tts.wav`);
    try {
      const r = await pyWorker().call({ op: 'tts', text, out, engine: cfg.voice.engine, voice: cfg.voice.voice, speed: cfg.voice.speed, pitch: cfg.voice.pitch });
      if (r.ok) return readFileSync(out);
      log('local voice failed, using the server voice:', r.error); localTtsBroken = true;
    } catch (e) { log('local voice failed, using the server voice:', e.message); localTtsBroken = true; } finally { rmSync(out, { force: true }); }
  }
  return api('/v1/voice/speak', { body: { text }, signal, raw: true, timeoutMs: 90_000 });
}

// Speaking into a muted speaker wastes the synthesis; the notification says so instead.
const speakerMuted = () => run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeoutMs: 3000 }).then((o) => /MUTED/.test(String(o))).catch(() => false);

const conversation = {
  get() { try { const s = JSON.parse(readFileSync(STATE, 'utf8')); return Date.now() - s.at < cfg.followupMinutes * 60_000 ? s.conversationId : null; } catch { return null; } },
  set(id) { try { mkdirSync(cfg.dir, { recursive: true, mode: 0o700 }); writeFileSync(STATE, JSON.stringify({ conversationId: id, at: Date.now() }), { mode: 0o600 }); } catch { /* best effort */ } },
};

// ---------- go ----------
const deps = { cue, notify, closeNotification, record: opt('wav') ? recordFile(opt('wav')) : recordMic, transcribe, screenshot, turn, synth, play, speakerMuted, conversation, log };
if (opt('text')) { deps.record = () => ({ stop() {}, done: Promise.resolve({ heard: true, wav: Buffer.alloc(0) }) }); deps.transcribe = async () => opt('text'); }

if (SAY !== null) { // voice check: synthesise and play, nothing else
  const t0 = Date.now(); const wav = await synth(SAY, {}); log(`synthesised in ${Date.now() - t0} ms (${useLocalTts && !localTtsBroken ? 'laptop' : 'server'} voice)`);
  await play(wav); cleanup(); process.exit(0);
}

session = new VoiceSession(deps, { screen: cfg.screen, tts: cfg.tts });
if (useLocalStt || useLocalTts) pyWorker().call({ op: 'warm', stt: useLocalStt, engine: cfg.voice.engine, voice: cfg.voice.voice, pitch: cfg.voice.pitch }).catch(() => {});
session.press({ screen: flag('screen') ? 'always' : null });
for (const p of early) session.press(p); // a second press during start-up (debounced if it was a double tap)

// Stay resident while busy, then for lingerMinutes (models warm, follow-ups instant), then exit.
const linger = (flag('no-linger') || opt('wav') || opt('text') ? 0 : cfg.lingerMinutes) * 60_000;
let idleSince = Date.now();
const tick = setInterval(() => {
  if (session.state !== 'idle') { idleSince = Date.now(); return; }
  if (Date.now() - idleSince >= linger) { clearInterval(tick); releaseLock(LOCK); session.round?.finally(() => { cleanup(); process.exit(0); }); }
}, 500);
