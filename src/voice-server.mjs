// Server-side voice for devices without a browser (ESP32 desk companion, phone
// shortcuts). Engines are optional local CLIs so nothing heavy stays resident:
//   STT: whisper.cpp  (FRIDAY_WHISPER_BIN + FRIDAY_WHISPER_MODEL, e.g. ggml-base.en.bin ~150 MB RAM while running)
//   TTS: Piper        (FRIDAY_PIPER_BIN + FRIDAY_PIPER_MODEL, ~60 MB voice)
// Audio is processed through a temp dir that is deleted immediately (no raw audio retention).
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_AUDIO = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export class VoiceServer {
  constructor({ env = process.env, governor = null }) {
    Object.assign(this, { governor });
    this.whisper = { bin: env.FRIDAY_WHISPER_BIN || null, model: env.FRIDAY_WHISPER_MODEL || null };
    this.piper = { bin: env.FRIDAY_PIPER_BIN || null, model: env.FRIDAY_PIPER_MODEL || null };
  }

  status() {
    const ok = (e, m) => Boolean(e.bin && e.model && existsSync(e.bin) && existsSync(e.model));
    return { stt: ok(this.whisper) ? 'ready' : 'not_installed', tts: ok(this.piper) ? 'ready' : 'not_installed' };
  }

  #admit() {
    if (!this.governor) return { release() {} };
    const lease = this.governor.acquire('voice');
    if (!lease.allowed) throw Object.assign(new Error(`voice_unavailable:${lease.reason}`), { code: 'busy' });
    return lease;
  }

  async transcribe(wav) {
    if (this.status().stt !== 'ready') throw Object.assign(new Error('stt_not_installed'), { code: 'unavailable' });
    if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > MAX_AUDIO || wav.toString('ascii', 0, 4) !== 'RIFF') throw new TypeError('expected a WAV file (<=4 MB)');
    const lease = this.#admit(); const dir = mkdtempSync(join(tmpdir(), 'friday-stt-'));
    try {
      const f = join(dir, 'in.wav'); writeFileSync(f, wav, { mode: 0o600 });
      const out = await new Promise((res, rej) => execFile(this.whisper.bin, ['-m', this.whisper.model, '-f', f, '-nt', '-np'], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (e, so) => (e ? rej(new Error('stt_failed')) : res(so))));
      return out.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    } finally { rmSync(dir, { recursive: true, force: true }); lease.release(); }
  }

  async speak(text) {
    if (this.status().tts !== 'ready') throw Object.assign(new Error('tts_not_installed'), { code: 'unavailable' });
    const t = String(text ?? '').replace(/[`*#>|_]/g, '').trim().slice(0, 1500);
    if (!t) throw new TypeError('text required');
    const lease = this.#admit(); const dir = mkdtempSync(join(tmpdir(), 'friday-tts-'));
    try {
      const out = join(dir, 'out.wav');
      await new Promise((res, rej) => {
        const p = spawn(this.piper.bin, ['--model', this.piper.model, '--output_file', out], { stdio: ['pipe', 'ignore', 'ignore'], timeout: TIMEOUT_MS });
        p.on('error', rej); p.on('close', (c) => (c === 0 ? res() : rej(new Error('tts_failed'))));
        p.stdin.on('error', () => {}); p.stdin.end(t);
      });
      return readFileSync(out);
    } finally { rmSync(dir, { recursive: true, force: true }); lease.release(); }
  }
}
