#!/usr/bin/env python3
"""Friday voice worker: Whisper speech-to-text (faster-whisper) + text-to-speech.
TTS engines: "expressive" = Chatterbox Nano (ONNX, CPU): performs inline tags like [laugh] [sigh] [whispering] in a
voice cloned from a Kokoro-made reference (synthetic, no real person); "kokoro" = Kokoro (flat, fast) and the fallback.
JSON-lines protocol on stdin/stdout, one request -> one response, models load lazily on first use.
  {"id":1,"op":"stt","wav":"/path.wav","lang":"en","prompt":"..."}   -> {"id":1,"ok":true,"text":"..."}
  {"id":2,"op":"tts","text":"...","voice":"af_heart:60,af_nicole:40","speed":0.95,"out":"/path.wav",
   "engine":"expressive","pitch":1.12}                                -> {"id":2,"ok":true,"engine":"expressive"}
  {"id":3,"op":"warm","engine":"expressive","voice":"...","pitch":1.12,"stt":false} -> loads the TTS engine (and Whisper
                                                                          with "stt":true) ahead of the first sentence
  {"id":3,"op":"status"}                                              -> {"id":3,"ok":true,...}
"""
import json, os, sys, time

ROOT = os.environ.get("FRIDAY_VOICE_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "voice"))
MODELS = os.path.join(ROOT, "models")
STT_MODEL = os.environ.get("FRIDAY_STT_MODEL", "small")
KOKORO_ONNX = os.environ.get("FRIDAY_TTS_ONNX", os.path.join(MODELS, "kokoro-v1.0.onnx"))
KOKORO_VOICES = os.environ.get("FRIDAY_TTS_VOICES", os.path.join(MODELS, "voices-v1.0.bin"))
THREADS = int(os.environ.get("FRIDAY_VOICE_THREADS", "4"))
CBX_DIR = os.environ.get("FRIDAY_TTS_EXPRESSIVE", os.path.join(MODELS, "chatterbox-nano"))
CBX_FILES = {"enc": "onnx/speech_encoder.onnx", "emb": "onnx/embed_tokens.onnx", "lm": "onnx/language_model_int8_mixed.onnx",
             "dec": "onnx/conditional_decoder_int8.onnx", "tok": "tokenizer.json"}
def cpu_quota():
    """CPUs this container may use (cgroup v2 cpu.max), else the machine's count."""
    try:
        q, p = open("/sys/fs/cgroup/cpu.max").read().split()[:2]
        if q != "max": return max(1, int(int(q) // int(p)))
    except Exception: pass
    return os.cpu_count() or 4
# More threads than the CPU quota makes ONNX Runtime stall under throttling (measured: 2.6x vs 0.68x real time).
CBX_THREADS = int(os.environ.get("FRIDAY_TTS_THREADS") or min(6, cpu_quota()))
# The reference the expressive voice is cloned from (rendered by Kokoro, so it is a synthetic voice).
REF_TEXT = "Hey you! I was just thinking about you, you know? Come on, tell me everything, I want to hear all of it. You're kind of cute when you're nervous."

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

import re
TAG_RE = re.compile(r"\[([A-Za-z][A-Za-z ]{1,20})\]")
EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")
BRACKETS_RE = re.compile(r"\[[^\[\]]{1,80}\]")   # any bracketed aside, e.g. a stage direction
LINK_RE = re.compile(r"\[([^\[\]]{1,80})\]\([^)\s]{1,300}\)")  # markdown link -> just its text
STAR_RE = re.compile(r"\*([^*\n]{1,60})\*")
# Feelings written as emoji or *actions* become sounds she can perform; everything else is dropped, never read.
EMOJI_TAGS = {"[laugh]": "😂🤣😆😹", "[chuckle]": "😏😜😝😛😉",
              "[sigh]": "😩😔🙄", "[gasp]": "😱😲😮😳"}
ACTION_TAGS = [(re.compile(r"\b(laugh|giggl|cackl|snort)", re.I), "[laugh]"), (re.compile(r"\b(chuckl|smirk|grin)", re.I), "[chuckle]"),
               (re.compile(r"\bsigh", re.I), "[sigh]"), (re.compile(r"\bgasp", re.I), "[gasp]"), (re.compile(r"\bgroan", re.I), "[groan]"),
               (re.compile(r"\bwhisper", re.I), "[whispering]")]

def feelings_to_tags(text):
    def action(m):
        for rx, tag in ACTION_TAGS:
            if rx.search(m.group(1)): return f" {tag} "
        return " "
    text = STAR_RE.sub(action, LINK_RE.sub(r"\1", text))
    for tag, chars in EMOJI_TAGS.items():  # one sound per kind is plenty; the rest of the emoji are dropped
        text = re.sub("[" + chars + "]+", f" {tag} ", text, count=1)
    return text

def plain(text):
    """Text for an engine without tags: drop [tags] and emoji."""
    return re.sub(r"\s+", " ", EMOJI_RE.sub("", BRACKETS_RE.sub(" ", STAR_RE.sub(" ", LINK_RE.sub(r"\1", text))))).strip()

def kokoro_tts(text, voice, speed):
    k = kokoro()
    samples, rate = k.create(plain(text) or "…", voice=voice_style(k, voice or "af_heart"), speed=float(speed or 1.0), lang="en-us")
    return samples, rate

def cbx_ready():
    return all(os.path.exists(os.path.join(CBX_DIR, f)) for f in CBX_FILES.values())

class Expressive:
    """Chatterbox Nano on ONNX Runtime (CPU). Voice conditioning is computed once per voice and cached on disk."""
    SR, START, STOP, SILENCE, HEAD = 24000, 6561, 6562, 4299, 64

    def __init__(self):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.ort = ort
        so = ort.SessionOptions(); so.intra_op_num_threads = CBX_THREADS; so.inter_op_num_threads = 1
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")  # spinning threads burn the CPU quota
        self.so = so
        mk = lambda key: ort.InferenceSession(os.path.join(CBX_DIR, CBX_FILES[key]), so, providers=["CPUExecutionProvider"])
        self.emb, self.lm, self.dec = mk("emb"), mk("lm"), mk("dec")
        self.tok = Tokenizer.from_file(os.path.join(CBX_DIR, CBX_FILES["tok"]))
        with open(os.path.join(CBX_DIR, CBX_FILES["tok"]), encoding="utf-8") as f:
            self.tags = {t["content"] for t in json.load(f).get("added_tokens", []) if t["content"].startswith("[")}
        self.kv = [i for i in self.lm.get_inputs() if "past_key_values" in i.name]
        self.kv_heads = self.kv[0].shape[1]
        self.conds = {}

    def cond(self, voice, pitch):
        import hashlib
        import numpy as np
        key = f"{voice}@{float(pitch):.3f}"
        if key in self.conds: return self.conds[key]
        os.makedirs(os.path.join(CBX_DIR, "voices"), exist_ok=True)
        path = os.path.join(CBX_DIR, "voices", hashlib.sha1(key.encode()).hexdigest()[:16] + ".npz")
        if not os.path.exists(path):
            ref, rate = kokoro_tts(REF_TEXT, voice, 1.0)
            ref = np.asarray(ref, dtype=np.float32)
            if float(pitch) != 1.0:  # resample: higher pitch (and a touch faster), a younger/cuter timbre
                n = int(len(ref) / float(pitch))
                ref = np.interp(np.linspace(0, len(ref) - 1, n), np.arange(len(ref)), ref).astype(np.float32)
            if rate != self.SR:
                n = int(len(ref) * self.SR / rate)
                ref = np.interp(np.linspace(0, len(ref) - 1, n), np.arange(len(ref)), ref).astype(np.float32)
            enc = self.ort.InferenceSession(os.path.join(CBX_DIR, CBX_FILES["enc"]), self.so, providers=["CPUExecutionProvider"])
            a, b, c, d = enc.run(None, {"audio_values": ref[np.newaxis, :]})
            del enc  # ~550 MB; only needed once per voice
            np.savez(path + ".part.npz", cond=a, prompt=b, spk=c, feat=d); os.replace(path + ".part.npz", path)
        z = np.load(path)
        self.conds[key] = (z["cond"], z["prompt"], z["spk"], z["feat"])
        return self.conds[key]

    def clean(self, text):
        # Known tags stay (the model performs them); anything else in brackets and emoji would be read out.
        text = feelings_to_tags(text)
        text = BRACKETS_RE.sub(lambda m: f" {m.group(0).lower()} " if m.group(0).lower() in self.tags else " ", text)
        text = EMOJI_RE.sub("", text)
        return re.sub(r"\s+", " ", text).strip()

    def chunks(self, text, limit=240):
        parts, cur = [], ""
        for sent in re.findall(r"[^.!?]+[.!?]*[\"')\]]*\s*", text) or [text]:
            tag_only = not TAG_RE.sub("", sent).strip()  # a lone [sigh] belongs to the sentence before it
            if cur and not tag_only and len(cur) + len(sent) > limit: parts.append(cur.strip()); cur = ""
            cur += sent
        if cur.strip(): parts.append(cur.strip())
        return [p for p in parts if TAG_RE.sub("", p).strip() or p in self.tags]

    def one(self, text, cond, rng):
        import numpy as np
        cond_emb, prompt, spk, feat = cond
        ids = np.array([self.tok.encode(text).ids], dtype=np.int64)
        x = np.concatenate((cond_emb, self.emb.run(None, {"input_ids": ids})[0]), axis=1)
        bs, sl, _ = x.shape
        past = {i.name: np.zeros([bs, self.kv_heads, 0, self.HEAD], dtype=np.float16 if i.type == "tensor(float16)" else np.float32) for i in self.kv}
        mask = np.ones((bs, sl), dtype=np.int64); pos = np.arange(sl, dtype=np.int64)[None, :]
        gen = np.array([[self.START]], dtype=np.int64)
        for _ in range(min(1000, 120 + 4 * len(text))):  # ~25 tokens/s of audio; the cap stops a runaway
            logits, *present = self.lm.run(None, dict(inputs_embeds=x, attention_mask=mask, position_ids=pos, **past))
            lg = logits[0, -1, :].astype(np.float64)
            seen = gen[0]  # repetition penalty 1.2, then temperature 0.8 + top-p 0.95 (Chatterbox Turbo's defaults)
            lg[seen] = np.where(lg[seen] < 0, lg[seen] * 1.2, lg[seen] / 1.2)
            z = lg / 0.8; z -= z.max(); p = np.exp(z); p /= p.sum()
            order = np.argsort(-p); keep = order[: int(np.searchsorted(np.cumsum(p[order]), 0.95)) + 1]
            nxt = int(rng.choice(keep, p=p[keep] / p[keep].sum()))
            gen = np.concatenate((gen, [[nxt]]), axis=1)
            if nxt == self.STOP: break
            x = self.emb.run(None, {"input_ids": np.array([[nxt]], dtype=np.int64)})[0]
            mask = np.concatenate([mask, np.ones((bs, 1), dtype=np.int64)], axis=1); pos = pos[:, -1:] + 1
            for j, key in enumerate(past): past[key] = present[j]
        speech = gen[:, 1:]
        if speech.shape[1] and speech[0, -1] == self.STOP: speech = speech[:, :-1]
        speech = np.concatenate([prompt, speech, np.full((1, 3), self.SILENCE, dtype=np.int64)], axis=1)
        return self.dec.run(None, dict(speech_tokens=speech, speaker_embeddings=spk, speaker_features=feat))[0].squeeze(0)

    def say(self, text, voice, pitch):
        import numpy as np
        cond = self.cond(voice, pitch)
        rng = np.random.default_rng()
        gap = np.zeros(int(self.SR * 0.18), dtype=np.float32)
        out = []
        for part in self.chunks(self.clean(text)):
            out += [self.one(part, cond, rng).astype(np.float32), gap]
        if not out: raise ValueError("nothing to say")
        return np.concatenate(out[:-1]), self.SR

_expressive = None
def expressive():
    global _expressive
    if _expressive is None: _expressive = Expressive()
    return _expressive

def tts(req):
    import soundfile as sf
    engine = "kokoro"
    if req.get("engine") == "expressive" and cbx_ready():
        try:
            samples, rate = expressive().say(req["text"], req.get("voice") or "af_heart", float(req.get("pitch") or 1.0))
            engine = "expressive"
        except Exception as e:  # never go silent: fall back to Kokoro
            sys.stderr.write(f"expressive tts failed, using kokoro: {type(e).__name__}: {e}\n")
            samples, rate = kokoro_tts(req["text"], req.get("voice"), req.get("speed"))
    else:
        samples, rate = kokoro_tts(req["text"], req.get("voice"), req.get("speed"))
    sf.write(req["out"], samples, rate)
    return {"rate": rate, "seconds": round(len(samples) / rate, 2), "engine": engine}

def warm(req):
    if req.get("stt"): whisper()  # the laptop key warms Whisper while you are still talking
    if req.get("engine") == "expressive" and cbx_ready():
        expressive().cond(req.get("voice") or "af_heart", float(req.get("pitch") or 1.0))
        return {"engine": "expressive"}
    kokoro(); return {"engine": "kokoro"}

def status(_):
    return {"stt_model": STT_MODEL, "stt_loaded": _whisper is not None, "tts_loaded": _kokoro is not None,
            "tts_files": os.path.exists(KOKORO_ONNX) and os.path.exists(KOKORO_VOICES),
            "expressive_files": cbx_ready(), "expressive_loaded": _expressive is not None}

OPS = {"stt": stt, "tts": tts, "warm": warm, "status": status}

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
