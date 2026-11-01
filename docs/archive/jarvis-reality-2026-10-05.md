# Friday as Jarvis — what works, what's gated, what's honestly limited (5 Oct 2026)

Your model file: `megaman_x_divemmdortwinkle_girl.glb` (0.7MB, 80 nodes, 1 skin,
ZERO authored animations, ZERO face morphs, CC-BY-4.0 lucianone). Hands/face
never had motion data — so Friday animates her procedurally: breathing (Spine),
blink (Eyelid_L/R bones), wave (R arm), nod/shake (Head), talk = head-bob +
subtitles (no jaw bones exist, lip-sync is impossible on this file).
Open `/pet.html` (or `?compact=1` for screen-sitting popup). Needs network once
for Three.js CDN (unpkg); offline shows a message. GNOME Wayland cannot force
always-on-top — keep the popup on top manually.

## Now live
- **3D pet**: poses follow real state (sleeping/listening/thinking/acting/
  waiting/blocked/offline/done) via `/v1/presence` polling; Wave/Talk-test buttons.
- **Voice**: PWA mic (Web Speech API, push-to-talk into Instructions) + spoken
  replies (speechSynthesis, barge-in cancels). No server models, mic needs
  localhost/HTTPS permission.
- **Live browser reads**: `GET /v1/browser/snapshot?url=https://…` via system
  Chrome headless dump-dom (dedicated profile dir, https-only, semantic only).
  Full DOM clicking needs `npm i playwright-core` (documented, not installed).
- **WhatsApp**: staged only — `POST /v1/whatsapp/stage` (exact contacts.json id,
  16MB cap, hash) → approval token → `POST /v1/whatsapp/commit` (rate 1/min,
  revalidates, resolves `whatsapp_not_logged_in` until you QR-login a dedicated
  profile). **ToS warning: automation risks a ban; dedicated profile, manual
  login, every send approved, no bulk — or don't use it.**
- **Desktop**: lease (`POST /v1/desktop/lease`, ≤60s, single-holder) +
  `POST /v1/desktop/type|click` (fail-closed: `wtype_not_installed` /
  ydotool missing — install with `sudo apt install wtype ydotool`) +
  `POST /v1/desktop/activity` revokes on your input. Every action
  `needsVerification:true`. No lock-screen/suspend control.
- **Scheduler auto-run**: `DueRunner` polls every 30s, moves due → queued tasks
  (execution still via worker + approvals). Proactive automations stay
  explicit-only with kill switches.
- **Phone**: NOT exposed. Follow `docs/tailscale-runbook.md` manually
  (`tailscale serve`, tailnet-only, no Funnel, re-auth approvals, kill-switch
  test). I did not open anything.

## Still not "do anything"
Raw-coordinate clicks are last-resort and verified-only; CAPTCHA/2FA/logged-out/
changed-UI go to explicit `blocked`, never random clicking. No unattended sends,
no lock-screen work, no local Nemotron (6GB VRAM can't), JEV/Nemotron need keys.
She is a **guarded Jarvis**: does everything you allow through stage→approve→
verify, refuses the rest with the exact reason and one safe next step.
