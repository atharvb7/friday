#!/usr/bin/env bash
# Render systemd/friday.service.in into a user unit. Does NOT enable or start it
# unless --enable is passed. Usage: scripts/install-systemd.sh [--enable]
#   MEM_HIGH (default 4G) MEM_MAX (default 5G) PORT (default 4317) DATA_DIR
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s#@NODE@#$NODE_BIN#g" -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" \
    -e "s#@PORT@#${PORT:-4317}#g" -e "s#@MEM_HIGH@#${MEM_HIGH:-4G}#g" -e "s#@MEM_MAX@#${MEM_MAX:-5G}#g" \
    "$APP_DIR/systemd/friday.service.in" > "$UNIT_DIR/friday.service"
systemctl --user daemon-reload
echo "Installed $UNIT_DIR/friday.service (MemoryHigh=${MEM_HIGH:-4G} MemoryMax=${MEM_MAX:-5G})"
if [[ "${1:-}" == "--enable" ]]; then
  systemctl --user enable --now friday
  loginctl enable-linger "$USER" 2>/dev/null || echo "note: run 'sudo loginctl enable-linger $USER' so Friday survives logout"
else
  echo "Not enabled. Start with: systemctl --user start friday   (or re-run with --enable)"
fi
