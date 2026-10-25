#!/usr/bin/env bash
# Copy Friday's artwork to the server checkout. It is git-ignored (owner-supplied art, artist unknown, public repo),
# so the normal git-based deploy never carries it. Run this, then scripts/deploy-server.sh rebuilds with it.
# Usage: scripts/deploy-art.sh user@host
set -euo pipefail
HOST="${1:?usage: deploy-art.sh user@host}"
cd "$(dirname "$0")/../public/assets"
FILES=(friday.webp friday-face.webp icon-192.png icon-512.png apple-touch-icon.png favicon-64.png)
for f in "${FILES[@]}"; do [ -f "$f" ] || { echo "missing public/assets/$f" >&2; exit 1; }; done
scp -q -o BatchMode=yes "${FILES[@]}" "$HOST:friday/public/assets/"
echo "copied ${#FILES[@]} art files to $HOST:~/friday/public/assets"
