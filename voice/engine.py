#!/usr/bin/env python3
"""Friday voice worker: Whisper speech-to-text (faster-whisper) + Kokoro text-to-speech (kokoro-onnx).
JSON-lines protocol on stdin/stdout, one request -> one response, models load lazily on first use.
  {"id":1,"op":"stt","wav":"/path.wav","lang":"en","prompt":"..."}   -> {"id":1,"ok":true,"text":"..."}
  {"id":2,"op":"tts","text":"...","voice":"af_heart:60,af_nicole:40","speed":0.95,"out":"/path.wav"} -> {"id":2,"ok":true}
  {"id":3,"op":"status"}                                              -> {"id":3,"ok":true,...}
"""
import json, os, sys, time

ROOT = os.environ.get("FRIDAY_VOICE_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "voice"))
MODELS = os.path.join(ROOT, "models")
STT_MODEL = os.environ.get("FRIDAY_STT_MODEL", "small")
KOKORO_ONNX = os.environ.get("FRIDAY_TTS_ONNX", os.path.join(MODELS, "kokoro-v1.0.onnx"))
KOKORO_VOICES = os.environ.get("FRIDAY_TTS_VOICES", os.path.join(MODELS, "voices-v1.0.bin"))
THREADS = int(os.environ.get("FRIDAY_VOICE_THREADS", "4"))

_whisper = None
_kokoro = None

def whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        _whisper = WhisperModel(STT_MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS, download_root=os.path.join(MODELS, "whisper"))
    return _whisper

def kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(KOKORO_ONNX, KOKORO_VOICES)
    return _kokoro

def load_audio(path):
    """WAV -> float32 mono 16 kHz array (avoids PyAV decoding, which is version-fragile)."""
    import numpy as np, soundfile as sf
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != 16000:
        n = int(round(len(mono) * 16000 / rate))
        mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono).astype("float32")
    return mono

def stt(req):
    segments, info = whisper().transcribe(load_audio(req["wav"]), language=req.get("lang") or None, initial_prompt=req.get("prompt") or None,
                                          beam_size=5, vad_filter=True, vad_parameters={"min_silence_duration_ms": 500},
                                          condition_on_previous_text=False, temperature=0.0)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "duration": round(info.duration, 2)}

def voice_style(k, spec):
    """'af_heart' or a blend like 'af_heart:60,af_nicole:40'."""
    import numpy as np
    parts = [p.strip() for p in str(spec).split(",") if p.strip()]
    if len(parts) == 1 and ":" not in parts[0]:
        return parts[0]
    mix, total = None, 0.0
    for p in parts:
        name, _, w = p.partition(":")
        w = float(w or 1)
        v = k.get_voice_style(name) * w
        mix = v if mix is None else mix + v
        total += w
    return mix / total

def tts(req):
    import soundfile as sf
    k = kokoro()
    samples, rate = k.create(req["text"], voice=voice_style(k, req.get("voice") or "af_heart"), speed=float(req.get("speed") or 1.0), lang="en-us")
    sf.write(req["out"], samples, rate)
    return {"rate": rate, "seconds": round(len(samples) / rate, 2)}

def status(_):
    return {"stt_model": STT_MODEL, "stt_loaded": _whisper is not None, "tts_loaded": _kokoro is not None,
            "tts_files": os.path.exists(KOKORO_ONNX) and os.path.exists(KOKORO_VOICES)}

OPS = {"stt": stt, "tts": tts, "status": status}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        rid = None
        try:
            req = json.loads(line); rid = req.get("id")
            t0 = time.time()
            out = OPS[req["op"]](req)
            out.update({"id": rid, "ok": True, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # never die on a bad request
            out = {"id": rid, "ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}
        sys.stdout.write(json.dumps(out) + "\n"); sys.stdout.flush()

if __name__ == "__main__":
    main()
