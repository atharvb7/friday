import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { VoiceServer, DEFAULT_VOICE } from '../../src/voice-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = '/usr/bin/google-chrome';
const HAVE_VOICE = existsSync(join(ROOT, 'data', 'voice', 'models', 'kokoro-v1.0.onnx')) && existsSync(join(ROOT, 'data', 'voice', 'venv', 'bin', 'python'));
const PORT = 43491;

test('REAL voice loop in Chrome: fake microphone says a sentence -> Whisper transcribes into the box; Kokoro speech comes back as audio', { skip: !existsSync(CHROME) || !HAVE_VOICE, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-vui-'));
  const vs = new VoiceServer({ env: {}, dataDir: join(ROOT, 'data'), appRoot: ROOT });
  const sentence = 'Remind me to call my sister tomorrow evening';
  const raw = join(dir, 'raw.wav'); writeFileSync(raw, await vs.speak(sentence, { voice: 'af_heart', speed: 1 })); vs.stop();
  const fake = join(dir, 'mic.wav'); // speech followed by 4 s of silence so the recorder's pause detector fires
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', 'apad=pad_dur=4', '-ar', '48000', '-ac', '1', fake]);
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_VOICE_HOME: join(ROOT, 'data', 'voice'), FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_NVIDIA_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`; let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext(); await ctx.grantPermissions(['microphone'], { origin: base });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((t) => localStorage.setItem('friday.token', t), token);
    await page.goto(base + '/#chat'); await page.waitForSelector('.composer textarea');
    await page.waitForFunction(async () => (await (await fetch('/v1/voice/status', { headers: { Authorization: `Bearer ${localStorage.getItem('friday.token')}` } })).json()).stt === 'ready');
    // stop the auto-submit from needing a brain: we only check what lands in the box before/while submitting
    await page.evaluate(() => { const ta = document.querySelector('.composer textarea'); window.__seen = []; new MutationObserver(() => {}).observe(ta, { attributes: true }); const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); Object.defineProperty(ta, 'value', { get() { return d.get.call(this); }, set(v) { if (v) window.__seen.push(v); d.set.call(this, v); } }); });
    await page.locator('.composer .act.mic').click();
    await page.waitForFunction(() => window.__seen.length > 0, null, { timeout: 90_000 });
    const heard = (await page.evaluate(() => window.__seen))[0];
    assert.match(heard.toLowerCase(), /remind me to call my sister tomorrow evening/, `Whisper heard: ${heard}`);
    // TTS through the same API the UI uses: returns a real WAV
    const wav = await page.evaluate(async () => { const r = await fetch('/v1/voice/speak', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('friday.token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hi there' }) }); const b = new Uint8Array(await r.arrayBuffer()); return { ok: r.ok, riff: String.fromCharCode(...b.slice(0, 4)), n: b.length }; });
    assert.deepEqual([wav.ok, wav.riff], [true, 'RIFF']); assert.ok(wav.n > 10_000);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 6000); }); rmSync(dir, { recursive: true, force: true }); }
});
