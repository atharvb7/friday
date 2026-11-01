#!/usr/bin/env bash
# Binds Friday push-to-talk (node/voice-key.mjs) to a GNOME custom keyboard shortcut. Re-running updates it.
#   FRIDAY_VOICE_TOKEN=fdv_... ./voice-key-install.sh              # backtick (`), stores the token
#   ./voice-key-install.sh --key '<Super>grave'                    # Super+` instead (backtick keeps typing)
#   ./voice-key-install.sh --screen-key '<Super><Shift>grave'      # optional 2nd shortcut: always attach a screenshot
# Binding plain ` means that key no longer types a backtick anywhere (GNOME takes it first). Undo: voice-key-uninstall.sh
# The token: create a device with scopes read,chat (Friday web UI -> Settings -> Devices, or on the server
# `node bin/friday.mjs device add laptop-voice read,chat`). The laptop node's own token (read,node) cannot chat.
set -euo pipefail
KEY='grave'; SCREEN_KEY=''
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --screen-key) SCREEN_KEY="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/voice-key.mjs"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH" >&2; exit 1; }
[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }
for t in pw-record pw-play ffmpeg notify-send gsettings; do command -v "$t" >/dev/null || echo "warning: $t not found (needed for voice)" >&2; done

CONF_DIR="${FRIDAY_NODE_HOME:-$HOME/.friday-node}"
mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
LOG="$CONF_DIR/voice-key.log"
if [ -n "${FRIDAY_VOICE_TOKEN:-}" ]; then # merge into voice.json (0600); never echoed
  "$NODE" -e '
    const fs = require("fs"); const f = process.argv[1]; let j = {};
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    j.token = process.env.FRIDAY_VOICE_TOKEN; fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 }); fs.chmodSync(f, 0o600);' "$CONF_DIR/voice.json"
  echo "Saved the voice token to $CONF_DIR/voice.json"
fi

SCHEMA='org.gnome.settings-daemon.plugins.media-keys'
BASE='/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings'
add_binding() { # id name binding command
  local path="$BASE/$1/"
  local list; list="$(gsettings get "$SCHEMA" custom-keybindings)"
  if [[ "$list" != *"'$path'"* ]]; then
    if [[ "$list" == "@as []" || "$list" == "[]" ]]; then list="['$path']"; else list="${list%]}, '$path']"; fi
    gsettings set "$SCHEMA" custom-keybindings "$list"
  fi
  gsettings set "$SCHEMA.custom-keybinding:$path" name "$2"
  gsettings set "$SCHEMA.custom-keybinding:$path" binding "$3"
  gsettings set "$SCHEMA.custom-keybinding:$path" command "$4"
}
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
CMD="sh -c $(q "exec $(q "$NODE") $(q "$SCRIPT") \"\$@\" >>$(q "$LOG") 2>&1") voice-key"
add_binding friday-voice 'Friday push-to-talk' "$KEY" "$CMD"
echo "Bound $KEY -> Friday push-to-talk"
if [ -n "$SCREEN_KEY" ]; then
  add_binding friday-voice-screen 'Friday: ask about the screen' "$SCREEN_KEY" "$CMD --screen"
  echo "Bound $SCREEN_KEY -> Friday push-to-talk with a screenshot"
fi

# Super+` is GNOME's "switch windows of an app" by default (<Super>Above_Tab); say so instead of silently clashing.
if [[ "$KEY" == *'<Super>'* && ( "$KEY" == *grave* || "$KEY" == *Above_Tab* ) ]] && gsettings get org.gnome.desktop.wm.keybindings switch-group 2>/dev/null | grep -q "<Super>Above_Tab"; then
  echo "note: GNOME also uses Super+\` (switch windows of an app). To free it:"
  echo "  gsettings set org.gnome.desktop.wm.keybindings switch-group \"['<Alt>Above_Tab']\""
fi
[ "$KEY" = 'grave' ] && echo "note: the \` key no longer types a backtick. Use --key '<Super>grave' to keep it, or run voice-key-uninstall.sh."
"$NODE" "$SCRIPT" --status | sed 's/^/  /'
grep -q '"token"' "$CONF_DIR/voice.json" 2>/dev/null || echo "warning: no voice token yet: re-run with FRIDAY_VOICE_TOKEN=fdv_... (a device with scopes read,chat)" >&2
