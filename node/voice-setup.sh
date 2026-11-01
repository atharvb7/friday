#!/usr/bin/env bash
# Installs the laptop's own voice for push-to-talk into ~/.local/share/friday-voice (override: FRIDAY_LOCAL_VOICE_HOME):
# Whisper 'small' (speech-to-text, ~250 MB) + Kokoro (her voice, ~330 MB) in a Python venv (~550 MB). CPU only; no sudo.
# With it, your audio never leaves the laptop and replies start faster; without it, voice-key.mjs uses the server.
#   ./voice-setup.sh                 # Whisper + Kokoro
#   ./voice-setup.sh --expressive    # also the Chatterbox Nano expressive voice (~1.2 GB, performs [laugh]/[sigh])
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${FRIDAY_LOCAL_VOICE_HOME:-$HOME/.local/share/friday-voice}"
EXPRESSIVE=0; [ "${1:-}" = "--expressive" ] && EXPRESSIVE=1
mkdir -p "$HOME_DIR"
if [ ! -x "$HOME_DIR/venv/bin/python" ]; then echo "Creating venv in $HOME_DIR/venv"; python3 -m venv "$HOME_DIR/venv"; fi
"$HOME_DIR/venv/bin/python" -m pip install --disable-pip-version-check -q faster-whisper kokoro-onnx soundfile numpy tokenizers $([ $EXPRESSIVE = 1 ] && echo onnxruntime)
FRIDAY_VOICE_HOME="$HOME_DIR" FRIDAY_VOICE_EXPRESSIVE=$EXPRESSIVE "$HOME_DIR/venv/bin/python" "$HERE/../voice/setup.py"
node "$HERE/voice-key.mjs" --say "Hi, I'm Friday. This is how I sound on your laptop." || true
node "$HERE/voice-key.mjs" --status
