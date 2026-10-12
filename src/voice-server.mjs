// Server-side voice. Preferred engine: the Python worker (Whisper STT + Kokoro TTS, see voice/engine.py),
// started on demand. Fallback engines: whisper.cpp / Piper CLIs (FRIDAY_WHISPER_*, FRIDAY_PIPER_*).
// Audio is processed through a temp dir that is deleted immediately (no raw audio retention).
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonWorker } from './voice-worker.mjs';

const MAX_AUDIO = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
export const DEFAULT_VOICE = { voice: 'af_heart:65,af_nicole:35', speed: 0.96 }; // soft + warm, a little playful

export class VoiceServer {
  constructor({ env = process.env, governor = null, dataDir = null, appRoot = null }) {
    Object.assign(this, { governor });
    this.whisper = { bin: env.FRIDAY_WHISPER_BIN || null, model: env.FRIDAY_WHISPER_MODEL || null };
    this.piper = { bin: env.FRIDAY_PIPER_BIN || null, model: env.FRIDAY_PIPER_MODEL || null };
    this.home = env.FRIDAY_VOICE_HOME || (dataDir ? join(dataDir, 'voice') : null);
    const python = env.FRIDAY_VOICE_PYTHON || (this.home ? join(this.home, 'venv', 'bin', 'python') : null);
    const script = appRoot ? join(appRoot, 'voice', 'engine.py') : null;
    this.sttModel = env.FRIDAY_STT_MODEL || 'small';
    this.pyEnabled = Boolean(python && script && existsSync(python) && existsSync(script) && env.FRIDAY_VOICE_ENGINE !== 'cli');
    this.worker = this.pyEnabled ? new PythonWorker({ python, script, env: { FRIDAY_VOICE_HOME: this.home, FRIDAY_STT_MODEL: this.sttModel } }) : null;
    this.models = this.home ? join(this.home, 'models') : null;
  }

  #pyStt() { return this.pyEnabled && this.models && existsSync(join(this.models, 'whisper')) && readdirSync(join(this.models, 'whisper')).length > 0; }
  #pyTts() { return this.pyEnabled && this.models && existsSync(join(this.models, 'kokoro-v1.0.onnx')) && existsSync(join(this.models, 'voices-v1.0.bin')); }
  #cli(e) { return Boolean(e.bin && e.model && existsSync(e.bin) && existsSync(e.model)); }

  status() {
    return {
      stt: this.#pyStt() || this.#cli(this.whisper) ? 'ready' : 'not_installed',
      tts: this.#pyTts() || this.#cli(this.piper) ? 'ready' : 'not_installed',
      engine: this.#pyStt() || this.#pyTts() ? 'whisper+kokoro' : (this.#cli(this.whisper) || this.#cli(this.piper)) ? 'cli' : 'none',
      sttModel: this.#pyStt() ? this.sttModel : null, loaded: this.worker?.running ?? false,
    };
  }

  // One voice job at a time: later requests (the next sentence of a long reply, prefetched while the first plays)
  // wait their turn instead of being rejected.
  async #admit(maxWaitMs = 60_000) {
    if (!this.governor) return { release() {} };
    const start = Date.now();
    for (;;) {
      const lease = this.governor.acquire('voice');
      if (lease.allowed) return lease;
      if (Date.now() - start > maxWaitMs) throw Object.assign(new Error(`voice_unavailable:${lease.reason}`), { code: 'busy' });
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async transcribe(wav, { prompt = '', language = 'en' } = {}) {
    if (this.status().stt !== 'ready') throw Object.assign(new Error('stt_not_installed'), { code: 'unavailable' });
    if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > MAX_AUDIO || wav.toString('ascii', 0, 4) !== 'RIFF') throw new TypeError('expected a WAV file (<=8 MB)');
    const lease = await this.#admit(); const dir = mkdtempSync(join(tmpdir(), 'friday-stt-'));
    try {
      const f = join(dir, 'in.wav'); writeFileSync(f, wav, { mode: 0o600 });
      if (this.#pyStt()) {
        const r = await this.worker.call({ op: 'stt', wav: f, lang: language, prompt });
        if (!r.ok) { console.error(`voice stt error: ${r.error}`); throw new Error('stt_failed'); }
        return r.text.replace(/\s+/g, ' ').trim();
      }
      const out = await new Promise((res, rej) => execFile(this.whisper.bin, ['-m', this.whisper.model, '-f', f, '-nt', '-np'], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (e, so) => (e ? rej(new Error('stt_failed')) : res(so))));
      return out.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    } finally { rmSync(dir, { recursive: true, force: true }); lease.release(); }
  }

  async speak(text, { voice = DEFAULT_VOICE.voice, speed = DEFAULT_VOICE.speed } = {}) {
    if (this.status().tts !== 'ready') throw Object.assign(new Error('tts_not_installed'), { code: 'unavailable' });
    const t = String(text ?? '').replace(/[`*#>|_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!t) throw new TypeError('text required');
    if (!/^[a-z]{2}_[a-z]+(:\d{1,3})?(,[a-z]{2}_[a-z]+(:\d{1,3})?){0,3}$/.test(voice)) throw new TypeError('invalid voice');
    const sp = Math.min(1.3, Math.max(0.7, Number(speed) || 1));
    const lease = await this.#admit(); const dir = mkdtempSync(join(tmpdir(), 'friday-tts-'));
    try {
      const out = join(dir, 'out.wav');
      if (this.#pyTts()) {
        const r = await this.worker.call({ op: 'tts', text: t, voice, speed: sp, out });
        if (!r.ok) { console.error(`voice tts error: ${r.error}`); throw new Error('tts_failed'); }
        return readFileSync(out);
      }
      await new Promise((res, rej) => {
        const p = spawn(this.piper.bin, ['--model', this.piper.model, '--output_file', out], { stdio: ['pipe', 'ignore', 'ignore'], timeout: TIMEOUT_MS });
        p.on('error', rej); p.on('close', (c) => (c === 0 ? res() : rej(new Error('tts_failed'))));
        p.stdin.on('error', () => {}); p.stdin.end(t);
      });
      return readFileSync(out);
    } finally { rmSync(dir, { recursive: true, force: true }); lease.release(); }
  }

  stop() { this.worker?.stop(); }
}
