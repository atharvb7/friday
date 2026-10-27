# Friday laptop node

Runs on **your laptop**. It connects *out* to your Friday server (so the server never needs inbound
access to your laptop) and executes browser/desktop commands that Friday's computer agent issues.
Friday only acts here when the node is running; computer tasks wait in the queue while it's offline.

## Setup
```bash
cd node && npm install                      # playwright-core only; uses your installed Google Chrome
# On the Friday server/laptop running Friday (owner):
node ../bin/friday.mjs device add laptop read,node      # prints a token ONCE
# On the laptop:
FRIDAY_NODE_TOKEN=fdv_... node friday-node.mjs pair --server https://<friday-host> --name laptop
node friday-node.mjs run
```
A dedicated Chrome profile lives in `~/.friday-node/chrome-profile`. **Log in to sites there yourself, once**
(e.g. open WhatsApp Web and scan the QR). Friday never sees passwords/cookies; it only drives the page.
Edit `~/.friday-node/config.json` to change `allowedDirs` (files Friday may find/attach; defaults:
Downloads, Documents, Desktop, Pictures; dot-folders are always blocked) or set `"headless": true`.

## What it can do
**Browser** (DOM refs, not guessed coordinates): open, snapshot, click, type, press, upload, scroll, screenshot.
Private/loopback URLs are refused.

**Whole desktop** (GNOME, Wayland or X11; on by default, `"fullAccess": false` in `config.json` turns it off):
- **Apps**: open any installed app by name, fuzzy (`.desktop` entries incl. snap + flatpak exports: "calculater",
  "vs code", "files"); open URLs / files / folders anywhere in your home with their default app.
- **Windows** (AT-SPI accessibility, works on Wayland): list (focused one marked), read a window's controls and text
  values, press buttons / set text without the mouse, focus (overview search, so no second window), close (the
  window's own close action; Alt+F4 only when the target is verifiably the only focused window).
- **Keyboard + mouse**: `input-helper.py` creates a virtual keyboard and an *absolute* pointer through `/dev/uinput`
  (pure Python, no root: a user ACL on `/dev/uinput` is enough). The compositor maps the pointer over the whole desktop,
  so multi-monitor and HiDPI layouts need no special handling (sizes come from Mutter's DisplayConfig). Typing is US
  layout key by key; emoji / non-English / long text is pasted through the clipboard (and your clipboard restored).
- **Screen**: `captureScreen({ maxWidth })` in `desktop.mjs` takes a non-interactive xdg-portal screenshot (~0.7 s),
  downscales it to a JPEG and deletes the portal's file in `~/Pictures`. Friday's server sends it to a vision model
  only when the cheaper accessibility tree can't see what it needs. Lock-screen state is detected (nothing runs while
  locked).
- **Clipboard** read/write (through XWayland; Mutter bridges it to Wayland apps).
- **Shell**: `bash -lc` as you, stdin closed (prompts fail instead of hanging), timeout kills the whole process group,
  output capped. Whole-disk/home wipes, `mkfs`, raw disk writes and fork bombs are refused even if approved.
- **Files** anywhere in your home: find, read, write, move to Trash. Keys/credentials (`.ssh`, `.gnupg`, `.env`,
  `*.pem`, keyrings, this node's own config) are never read or written by file actions.

## Permission model (what asks first)
The owner gave Friday **full routine use of the laptop without being asked**: opening apps, reading the screen,
typing, clicking, running commands and reading/writing files just happen. Approval is kept **only** for what is
irreversible or reaches other people / money. Friday decides the category itself, from the command text or the label
of the thing being clicked (the vision model's label for a screen element), never from the model's say-so:

| Asks first | Examples |
|---|---|
| Sending / publishing to others | Send / Post / Reply / Confirm buttons, Enter after typing into a chat or mail box, `git push`, `curl -X POST`, `mail`, `scp host:` |
| Money | Buy / Pay / Checkout / Subscribe |
| Permanent deletion, uninstalling | `rm`, `find -delete`, `git clean`/`reset --hard`, `apt/snap/flatpak/pip remove`, Delete / Uninstall buttons (Trash is free: it is recoverable) |
| System / security changes | `sudo`, services, firewall, network profiles, users/passwords, `gsettings` outside look-and-feel, `curl … | bash`, reading credential files or the environment |

One approval per laptop task covers its sends (e.g. the site's "Confirm" and then WhatsApp's "Confirm booking");
payments and deletions ask each time. The final-submit guards stay: a submit click must name the button it means
(`expect`), and the page must show the business the user named (`mustShow`). Raise or lower any category in
Friday's autonomy settings; setting **computer** to "ask" brings back an approval before every laptop task.

While **you** use the keyboard/mouse, Friday steps aside: the server pauses input actions while the idle monitor shows
activity (Friday's own injected input is not counted as yours) and the node re-checks right before each keystroke.

## Notes
- Automating WhatsApp Web can violate WhatsApp's terms and risk an account ban: use sparingly, with approvals on.
- Needs: Node 22, python3 with PyGObject (Atspi, Gio, GdkPixbuf, Gtk 3: stock on Ubuntu GNOME), `gio`, `gdbus`,
  rw access to `/dev/uinput` (`getfacl /dev/uinput` should list your user), xdg-desktop-portal with screenshot
  permission (GNOME asks once). No extra Python packages.

## Run at login (optional)
`node/friday-node.service` is a systemd **user** unit template.
Copy it to `~/.config/systemd/user/`, fix the path, then `systemctl --user daemon-reload && systemctl --user enable --now friday-node`.
It is wanted by `graphical-session.target` (not `default.target`) so it always starts after the desktop session has
published `DISPLAY`/`WAYLAND_DISPLAY`/`XAUTHORITY`; without them the visible browser cannot open.

## Push-to-talk voice key (`voice-key.mjs`)
Press a key anywhere (any app focused): beep, talk, beep. Friday transcribes, answers and speaks the reply on the laptop;
a notification shows what she heard and her answer (it stays in the notification list).
- **Stops** after ~1.3 s of silence (energy VAD, noise floor learned per recording), at 30 s, or when you press the key
  again. Nothing said / a click / under 0.35 s of speech: nothing is sent.
- **Press while she thinks** = cancel. **Press while she talks** = she stops and listens again.
- **Screen questions** ("what's on my screen", "read this", "what does this error mean", "explain this code"): a
  screenshot is taken through the GNOME portal (it saves to ~/Pictures and is deleted right after), downscaled to
  1440 px JPEG and sent with the question. The server's `vision` model chain (Gemini Flash-Lite first, then NVIDIA
  Nemotron Omni / Super-VL) turns it into a short text note (~1.2k tokens per image) and the brain answers from that.
  Other questions never take a screenshot. `--screen` (or the optional second shortcut) always attaches one.
- Follow-ups within 10 minutes continue the same conversation. After a turn it stays resident for 10 minutes so
  Whisper and the voice stay warm; a second launch just signals it (lock in `$XDG_RUNTIME_DIR/friday-voice-key.pid`).
- Errors are spoken as an error beep + a notification: server unreachable, wrong token/scope, mic missing/busy/muted
  (pure digital silence), speaker muted (she writes instead of speaking), server busy.

### Install
```bash
# 1. a device token that may chat (the node's own read,node token cannot):
#    Friday web UI -> Settings -> Devices -> add "laptop-voice" with scopes read,chat
#    (or on the server: node bin/friday.mjs device add laptop-voice read,chat)
# 2. optional but recommended: the laptop's own Whisper + voice (~550 MB, no sudo; audio then stays on the laptop)
./voice-setup.sh
# 3. bind the key (GNOME custom shortcut via gsettings)
FRIDAY_VOICE_TOKEN=fdv_... ./voice-key-install.sh                    # plain ` (backtick)
./voice-key-install.sh --key '<Super>grave'                          # Super+` instead
./voice-key-install.sh --key '<Super>grave' --screen-key '<Super><Shift>grave'   # + "always look at the screen"
./voice-key-uninstall.sh                                             # remove (add --forget to delete the token)
node voice-key.mjs --status                                          # what it will use (never prints the token)
```
Binding plain **`** means that key stops typing a backtick everywhere (GNOME grabs it first). If you write code or
Markdown, use **Super+`** instead; GNOME uses Super+` for "switch windows of an app" by default, the installer tells
you how to free it. Logs: `~/.friday-node/voice-key.log` (events only, never transcripts).

### Settings (`~/.friday-node/voice.json`, all optional)
`token`, `server` (defaults to the node pairing), `stt`/`tts`: `auto` (laptop if installed, else server) | `local` |
`server` (`tts` also `off`), `screen`: `auto` | `always` | `never`, `silenceMs` (1300), `maxSeconds` (30),
`noSpeechMs` (6000), `followupMinutes` (10), `lingerMinutes` (10, 0 = exit after each turn), `cues` (true), `volume`
(0.25), `voice`: `{ engine, voice, speed, pitch }` for the laptop voice, `localVoiceHome`.

Laptop voice default: Kokoro `af_heart:50,af_nicole:50`, speed 0.92 (soft and gentle, clear: 0 word errors in every
test run, 149 words/min; samples and scores in `outputs/friday-voice-samples-v2`). Voice tags such as [sigh] are
dropped silently by Kokoro, never read out.
