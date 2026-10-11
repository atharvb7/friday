# Friday on the server (Docker) — as deployed 2026-10-11

Host: `atharvsserver` (Ubuntu 26.04, 6.8 GB RAM, NVMe SSD), reachable on the tailnet. No sudo needed: everything runs in Docker as your user.

## Architecture
```
tailnet device ──HTTPS──► tailscale serve :4317 (tailnet-only, NOT Funnel) ──► 127.0.0.1:4317
                                                                            │
  ┌──────────── docker compose project "friday" ────────────────────────────┼──────────────┐
  │  friday  (core: API, UI, brain, Whisper/Kokoro voice)  ◄──── internal net ────► agent   │
  │        └──────────► egress net (internet)                       (DSH, no Friday data)    │
  │                                         proxy ◄── only way out for the agent ──┘        │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```
- **friday** — 2 GB limit, read-only rootfs, caps dropped. Data in `~/friday-data` (DB, token, voice models, backups) on the SSD.
- **agent** — 1.5 GB limit, internal network only, no Friday data/keys beyond the model key, runs as uid 10001. The container *is* the sandbox (the host has no bubblewrap and AppArmor blocks user namespaces).
- **proxy** — the agent's only route to the internet. It refuses private/LAN/tailnet/docker/metadata addresses (verified: `example.com` 200, your tailnet service 403, metadata 403).
- Restarts automatically (`unless-stopped`, docker enabled at boot). Nightly backup at 03:00 (user crontab, keeps 7) → `~/friday-data/backups`.
- URL: **https://atharvsserver.tail117666.ts.net:4317** (the laptop node, phone and desk companion all use this).

## Day-to-day (run on your laptop; or on the server inside `~/friday`)
```bash
scripts/deploy-server.sh atharvb7@100.120.200.64          # update: git pull + rebuild + restart (idempotent)
ssh atharvb7@100.120.200.64 'cd ~/friday && docker compose ps'
ssh atharvb7@100.120.200.64 'cd ~/friday && docker compose logs -f friday'
ssh atharvb7@100.120.200.64 'cd ~/friday && docker compose exec -T friday node bin/friday.mjs doctor'
ssh atharvb7@100.120.200.64 'cd ~/friday && docker compose exec -T friday node bin/friday.mjs device add phone read,chat,tasks,approve'
ssh atharvb7@100.120.200.64 'cd ~/friday && docker compose exec -T friday node bin/friday.mjs totp'
ssh atharvb7@100.120.200.64 'cd ~/friday && docker compose restart friday'   # or: docker compose down / up -d
```
Voice engine (done once, models live in `~/friday-data/voice`): `docker compose exec -T friday node bin/friday.mjs voice setup`.
Keys live in `~/friday/.env` (mode 600); after editing run `docker compose up -d`.

## Laptop node
`node/` on the laptop is paired to the server URL and runs as a user service (`systemctl --user status friday-node`). Log into WhatsApp etc. once in its Chrome profile.

## First-time setup of a new server
`scripts/deploy-server.sh user@host` (needs Docker + git on the host; creates `.env` from your local keys, generates the agent secret, builds, starts), then
`tailscale serve --bg --https=4317 http://127.0.0.1:4317`, restore data if migrating (`friday backup --with-secrets` → copy → `friday restore <file> --force` via `docker compose run --rm --no-deps friday …`), then voice setup.

## Resource notes (measured)
core ~70 MB idle, ~1 GB while voice is loaded (unloads after 5 idle min; `FRIDAY_STT_MODEL=base` halves it); agent ~15 MB idle, ~190 MB per running task; STT ≈ 2.7 s per sentence, TTS ≈ 0.3–0.5 s on this server.

## Notes
- Other apps on this host (Sorch, Supabase, Hermes, cloudflared) and the existing Funnel entries were not touched; Friday uses a new tailnet-only serve port.
- The tmpfs mounts allow `exec` on purpose: DSH and espeak load native libraries from `/tmp`.
- Not yet verified here: Web Push to a phone, phone PWA install, GitHub PR flow, sustained heavy concurrent load.
