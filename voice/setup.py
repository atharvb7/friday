#!/usr/bin/env python3
"""One-time model download for Friday voice (run with the voice venv's python). ~250 MB (small Whisper) + ~330 MB (Kokoro)
+ ~1.2 GB expressive voice (Chatterbox Nano ONNX, MIT; skip with FRIDAY_VOICE_EXPRESSIVE=0)."""
import os, sys, urllib.request
ROOT = os.environ.get("FRIDAY_VOICE_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "voice"))
MODELS = os.path.join(ROOT, "models"); os.makedirs(MODELS, exist_ok=True)
STT = os.environ.get("FRIDAY_STT_MODEL", "small")
BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = {"kokoro-v1.0.onnx": BASE + "kokoro-v1.0.onnx", "voices-v1.0.bin": BASE + "voices-v1.0.bin"}
# Chatterbox Nano, CPU-speed ONNX layout (community export of ResembleAI/chatterbox-nano), pinned to the tested revision.
CBX = "https://huggingface.co/KitsuMate/chatterbox-nano-v2-onnx/resolve/851210533a5bcb4ad78e3ada6d527482dd1a31e7/"
CBX_FILES = ["tokenizer.json", "onnx/speech_encoder.onnx", "onnx/embed_tokens.onnx", "onnx/language_model_int8_mixed.onnx",
             "onnx/language_model_int8_mixed.onnx.data", "onnx/conditional_decoder_int8.onnx", "onnx/conditional_decoder_int8.onnx.data"]

def fetch(name, url):
    dest = os.path.join(MODELS, name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 100_000: print(f"have {name}"); return
    print(f"downloading {name} ..."); tmp = dest + ".part"
    urllib.request.urlretrieve(url, tmp); os.replace(tmp, dest); print(f"saved {name} ({os.path.getsize(dest)//1048576} MB)")

if __name__ == "__main__":
    for n, u in FILES.items(): fetch(n, u)
    if os.environ.get("FRIDAY_VOICE_EXPRESSIVE", "1") != "0":
        for f in CBX_FILES: fetch(os.path.join("chatterbox-nano", f), CBX + f)
    from faster_whisper import WhisperModel
    print(f"fetching Whisper '{STT}' ...")
    WhisperModel(STT, device="cpu", compute_type="int8", download_root=os.path.join(MODELS, "whisper"))
    print("voice setup complete")
