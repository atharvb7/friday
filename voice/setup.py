#!/usr/bin/env python3
"""One-time model download for Friday voice (run with the voice venv's python). ~250 MB (small Whisper) + ~330 MB (Kokoro)."""
import os, sys, urllib.request
ROOT = os.environ.get("FRIDAY_VOICE_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "voice"))
MODELS = os.path.join(ROOT, "models"); os.makedirs(MODELS, exist_ok=True)
STT = os.environ.get("FRIDAY_STT_MODEL", "small")
BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = {"kokoro-v1.0.onnx": BASE + "kokoro-v1.0.onnx", "voices-v1.0.bin": BASE + "voices-v1.0.bin"}

def fetch(name, url):
    dest = os.path.join(MODELS, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000: print(f"have {name}"); return
    print(f"downloading {name} ..."); tmp = dest + ".part"
    urllib.request.urlretrieve(url, tmp); os.replace(tmp, dest); print(f"saved {name} ({os.path.getsize(dest)//1048576} MB)")

if __name__ == "__main__":
    for n, u in FILES.items(): fetch(n, u)
    from faster_whisper import WhisperModel
    print(f"fetching Whisper '{STT}' ...")
    WhisperModel(STT, device="cpu", compute_type="int8", download_root=os.path.join(MODELS, "whisper"))
    print("voice setup complete")
