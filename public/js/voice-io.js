// Browser audio for server-side voice: record (with silence auto-stop) -> 16 kHz mono WAV for Whisper,
// and play Kokoro speech sentence-by-sentence so the first words start quickly.
import { chunkSpeak } from '/voice.js';

export function floatToWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

async function toWav16k(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(audio.duration * 16000));
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
    return floatToWav((await off.startRendering()).getChannelData(0));
  } finally { ctx.close(); }
}

// Records until the user stops it or ~1.4 s of silence follows speech. Returns { stop, done: Promise<Blob|null> }.
export function startRecording({ onLevel = () => {}, maxMs = 60_000, silenceMs = 1400, threshold = 0.012 } = {}) {
  let stopFn = () => {};
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const rec = new MediaRecorder(stream); const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const ac = new AudioContext(); const an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an);
    const data = new Float32Array(an.fftSize);
    let spoke = false, lastVoice = Date.now(); const t0 = Date.now(); let stopped = false;
    const finished = new Promise((res) => { rec.onstop = res; });
    const tick = setInterval(() => {
      an.getFloatTimeDomainData(data); let sum = 0; for (const x of data) sum += x * x; const rms = Math.sqrt(sum / data.length);
      onLevel(rms);
      if (rms > threshold) { spoke = true; lastVoice = Date.now(); }
      if (!stopped && ((spoke && Date.now() - lastVoice > silenceMs) || Date.now() - t0 > maxMs)) stopFn();
    }, 80);
    stopFn = () => { if (stopped) return; stopped = true; clearInterval(tick); if (rec.state !== 'inactive') rec.stop(); };
    rec.start();
    await finished;
    stream.getTracks().forEach((t) => t.stop()); ac.close();
    if (!spoke) return null; // nothing but silence
    return toWav16k(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
  })();
  return { stop: () => stopFn(), done };
}

// Speak via the server (Kokoro). Fetches the next sentence while the current one plays. Returns { cancel, finished }.
export function speakServer(text, fetchWav) {
  let cancelled = false, current = null;
  const parts = chunkSpeak(String(text).replace(/[`*#>|_]/g, ''), 220).slice(0, 14);
  const finished = (async () => {
    let next = parts.length ? fetchWav(parts[0]) : null;
    for (let i = 0; i < parts.length && !cancelled; i++) {
      const blobP = next; next = i + 1 < parts.length ? fetchWav(parts[i + 1]) : null;
      let blob = await blobP; if (cancelled) return;
      if (!blob) { await new Promise((r) => setTimeout(r, 600)); if (cancelled) return; blob = await fetchWav(parts[i]); } // one retry
      if (!blob) continue; // skip a part that still failed instead of going silent for the rest
      const url = URL.createObjectURL(blob);
      await new Promise((resolve) => { current = new Audio(url); current.onended = current.onerror = () => { URL.revokeObjectURL(url); resolve(); }; current.play().catch(resolve); });
    }
  })();
  return { cancel() { cancelled = true; try { current?.pause(); } catch { /* ignore */ } }, finished };
}
