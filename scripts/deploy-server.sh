#!/usr/bin/env bash
# Deploy/update Friday on a Docker host over SSH.  Usage: scripts/deploy-server.sh user@host [branch]
# First run: clones the repo, creates the server .env from your local .env (keys only), builds and starts the stack.
# Later runs: git pull + rebuild + restart.  Data lives in ~/friday-data on the server (never in the repo).
set -euo pipefail
HOST="${1:?usage: deploy-server.sh user@host [branch]}"; BRANCH="${2:-develop}"
REPO="${FRIDAY_REPO:-https://github.com/atharvb7/friday.git}"
SSH=(ssh -o BatchMode=yes "$HOST")

"${SSH[@]}" "set -e; [ -d ~/friday/.git ] || git clone --branch '$BRANCH' '$REPO' ~/friday; cd ~/friday && git fetch origin && git checkout '$BRANCH' && git pull --ff-only origin '$BRANCH'; mkdir -p ~/friday-data && chmod 700 ~/friday-data"

# Server .env: ONLY the keys the containers need (never the laptop's paths), plus a generated agent secret.
if ! "${SSH[@]}" '[ -f ~/friday/.env ]'; then
  KEYS='^(FRIDAY_NVIDIA_API_KEY|FRIDAY_NEMOTRON_[A-Z_]*|SERPAPI_API_KEY|FRIDAY_JEV_[A-Z_]*|GITHUB_TOKEN|FRIDAY_PUSH_SUBJECT)='
  { grep -E "$KEYS" "$(dirname "$0")/../.env" || true; echo "FRIDAY_AGENT_SECRET=$(openssl rand -hex 32)"; echo "FRIDAY_DATA=/home/${HOST%%@*}/friday-data"; echo "TZ=Asia/Kolkata"; } \
    | "${SSH[@]}" 'umask 177; cat > ~/friday/.env'
  echo "created server .env (mode 600)"
fi

"${SSH[@]}" 'cd ~/friday && docker compose up -d --build 2>&1 | tail -15'
"${SSH[@]}" 'cd ~/friday && docker compose ps'
