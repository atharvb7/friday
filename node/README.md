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
Browser (DOM refs, not guessed coordinates): open, snapshot, click, type, press, upload (allowed dirs only), scroll,
screenshot. Desktop (accessibility/AT-SPI, works on Wayland): list windows, read UI tree, press buttons, set text.
File find in allowed dirs. Not available: raw mouse/keyboard injection and desktop screenshots on GNOME Wayland
(they need a portal permission prompt; see docs). Private/loopback URLs are refused.

## Safety model
- Autonomy policy lives on the server. Browsing is allowed by default; **sending, posting, uploading and buying
  always ask you first** (or follow the tier you set). The user-activity monitor (GNOME idle time) makes Friday
  pause while you're using the machine.
- Automating WhatsApp Web can violate WhatsApp's terms and risk an account ban: use sparingly, with approvals on.

## Run at login (optional)
`node/friday-node.service` is a systemd **user** unit template.
Copy it to `~/.config/systemd/user/`, fix the path, then `systemctl --user daemon-reload && systemctl --user enable --now friday-node`.
It is wanted by `graphical-session.target` (not `default.target`) so it always starts after the desktop session has
published `DISPLAY`/`WAYLAND_DISPLAY`/`XAUTHORITY`; without them the visible browser cannot open.
