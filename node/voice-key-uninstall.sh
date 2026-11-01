#!/usr/bin/env bash
# Removes the Friday push-to-talk shortcuts added by voice-key-install.sh (the ` key types a backtick again).
# Keeps ~/.friday-node/voice.json (the token); pass --forget to delete it too.
set -euo pipefail
SCHEMA='org.gnome.settings-daemon.plugins.media-keys'
BASE='/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings'
for id in friday-voice friday-voice-screen; do
  path="$BASE/$id/"
  list="$(gsettings get "$SCHEMA" custom-keybindings)"
  if [[ "$list" == *"'$path'"* ]]; then
    new="$(printf '%s' "$list" | sed -e "s#, '$path'##; s#'$path', ##; s#'$path'##")"
    [[ "$new" == "[]" ]] && new="@as []"
    gsettings set "$SCHEMA" custom-keybindings "$new"
    for k in name binding command; do gsettings reset "$SCHEMA.custom-keybinding:$path" "$k"; done
    echo "Removed $id"
  fi
done
# stop a resident instance, if any
pidf="${XDG_RUNTIME_DIR:-/tmp}/friday-voice-key.pid"
if [ -f "$pidf" ]; then pid="$(cat "$pidf")"; grep -q voice-key "/proc/$pid/cmdline" 2>/dev/null && kill "$pid" 2>/dev/null || true; fi
if [ "${1:-}" = "--forget" ]; then rm -f "${FRIDAY_NODE_HOME:-$HOME/.friday-node}/voice.json" "${FRIDAY_NODE_HOME:-$HOME/.friday-node}/voice-state.json"; echo "Deleted the voice token and state"; fi
