# Friday roadmap (single source of truth)

Updated 2026-10-10. Status is only ticked when it works end to end and a test or measurement proves it.

## Decisions
- Final host: Linux server, 6 GB RAM, no GPU, always on. Friday + DSH live there. Friday's cap: 5 GB, core + DSH target < 3 GB.
- No local model. Brain = Nemotron via model router, other remote providers as fallback, honest degraded mode last.
- Computer use + logged-in browser run on the user's laptop via a "laptop node" that dials out to the server.
- Build and prove everything on the laptop first (server + node on one machine), then deploy.
- Autonomy tiers per category; irreversible actions (money, deletion, messaging others, security) ask first by default.
- Friday DSH is separate from the user's DSH (own home, workspace, credentials, port).

## Phase 0 — Hygiene  (in progress)
- [x] Audit repo (docs/audit-and-phase-plan-2026-10-10.md)
- [x] Commit existing work in slices; archive contradicting docs; GLB moved to public/assets with attribution
- [x] `friday` CLI: start / stop / restart / status / logs / doctor (test/cli.test.mjs)
- [x] server.mjs split: context.mjs (composition root), http/router+static, routes/* (148 tests green)
- [ ] Rotate keys (user)
## Phase 1 — Server foundation  (code done; real-server deploy pending)
- [x] Portable packaging: systemd template + installer (4G/5G cgroup), Dockerfile + compose (not built here), FRIDAY_HOST guard
- [x] Auth: per-device scoped revocable tokens (hashed), owner-only admin, RFC 6238 TOTP gating device approvals, per-principal rate limits
- [x] Event bus + SSE `/v1/events` (task.*, resource.mode_changed, chat.reply, pet.state_changed, system.*)
- [x] `/v1/health` deterministic report; `friday doctor`
- [x] Backup/restore with retention (`friday backup|restore`), secrets excluded by default
- [ ] Tailscale serve + real-phone test; deploy to the 6 GB server; measure RSS under load (needs the server)
## Phase 2 — Brain  (done; verified live against Nemotron 2026-10-10)
- [x] Model router: ai.chat/execute/reason/plan/embed, per-role chains, circuit breakers, call log (latency/tokens), model.* events
- [x] OpenAI-compatible provider: streaming, native tool calls, reasoning kept out of replies; optional 2nd provider via FRIDAY_FALLBACK_*
- [x] Tool-calling brain (memory_save/search/forget, task_create/list/cancel, file_search/read, time_now), max 6 steps / 12 calls
- [x] Personality sliders (style only) + hard-rule system prompt; GET/POST /v1/personality
- [x] Context builder (budgeted memories + active tasks), hybrid memory (FTS + nemotron-3-embed-1b vectors, RRF), edit/pin/forget, background embedding indexer
- [x] Streaming chat (`POST /v1/chat {stream:true}` SSE), `/v1/models` stats
- [ ] Episodic auto-summaries of long conversations; memory dedupe/consolidation (later polish)
- Measured live: Super turn ~2.5 s avg with tools, Ultra ~12 s (so Ultra is used for reason/plan, Super for chat)
## Phase 3 — Agent spine  (done; verified live 2026-10-10)
- [x] Real DSH integration: `node <dsh>/apps/cli/lib/bin.js --profile headless --json`, task on stdin, JSONL events; ~190 MB RSS, ~3-10 s per run measured
- [x] Isolation: Friday-owned DSH_HOME/HOME, minimal env, own settings (no key on disk); Friday's bubblewrap sandbox hides data dir/.env/home, read-only system, writes only the task workspace (proved by a real-bwrap test)
- [x] Worker pool (concurrency + governor admission, profile `server6g`), traces (`trace.*` events), cancel/emergency/retry (manual only), no auto-retry of agent runs
- [x] Skills (shipped: research, coding, report-writing, daily-briefing, competitive-analysis; install from inbox with symlink/size checks; mirrored into DSH home; `skill_load` tool)
- [x] MCP config -> DSH overlay (`/v1/mcp`), secrets by env-var name only
- [x] Task results flow back into the originating chat + notification inbox (`/v1/notifications`)
- [ ] Real MCP servers installed and tested (SerpApi, GitHub) — Phase 5
- [ ] DSH session resume (`--session-id`) for continuing long tasks
## Phase 4 — Always-on assistant  (done; reminders verified live 2026-10-10)
- [x] Reminders + recurring agent jobs (interval/daily/weekdays/weekly/monthly), timezone- and DST-correct, durable, missed fires collapse to one, never double-fire
- [x] Notification inbox + SSE push (`notification.created`); results/reminders also land in the originating chat
- [x] Proactive loop: stuck tasks, agent-runtime-down, brain-down, low disk, morning briefing (morning window only); quiet hours, daily cap, per-topic dedupe, kill switch
- [x] Autonomy tiers per category (ask/trusted/autonomous/high), `high` time-boxed (<=12h) + auto-expiry + revoked by emergency stop; critical actions only under high
- [x] Approvals: exact-payload binding, execute-once, tamper check, 24h expiry; gated tools auto-register; devices need TOTP to decide
- [ ] Web Push to the phone (needs HTTPS PWA + VAPID) — Phase 7
## Phase 5 — Research, coding, GitHub  (research verified live 2026-10-10)
- [x] SerpApi: native `web_search` tool (brain) + hosted MCP (`mcp.serpapi.com`, Bearer from env) auto-enabled for the DSH agent — both verified live
- [x] Hardened `web_fetch` (SSRF-safe: validated sockets, IP-literal check, redirects/size/time caps, text only)
- [x] Persistent research memory: agent writes findings.json + report.md -> ingested (sources w/ dates, claims w/ confidence, contradiction flags, FTS search); live run saved 19 sources / 11 claims; relevant research auto-injected into chat context
- [x] `research_start`, `research_search`, `code_task` (named persistent project workspaces), `task_trace`
- [x] GitHub MCP config auto-enabled when GITHUB_TOKEN is set (needs a token from the user to test)
- [ ] GitHub PR flow tested end-to-end (needs token + a scratch repo)
## Phase 6 — Laptop node (computer use)  (verified live 2026-10-10)
- [x] Node protocol: outbound SSE command stream + HTTP results; scoped `node` device token; per-node answer binding; fail-fast `node_offline`; user-activity pause (GNOME idle monitor)
- [x] `node/` program: Playwright + system Chrome with a dedicated persistent profile (manual login once), DOM-ref snapshot/click/type/upload/screenshot, AT-SPI desktop helper (Wayland-safe), allowed-dir file find, URL/file policies (real-Chrome tests)
- [x] Server computer agent: tool loop, policy/approval per action, `intent` can only escalate risk, loop-breaker, step budget, waits for approvals and for the user to go idle
- [x] Brain tools `computer_task` (gated) / `laptop_status`; computer tasks queue while the laptop is offline
- [x] Live: chat -> approval -> node -> real Chrome -> result in chat
- [ ] Raw input/desktop screenshots on GNOME Wayland (needs portal permission or ydotool + sudo) — deliberately not faked
- [ ] WhatsApp end-to-end with the user's own login (user must scan QR in the node profile)
- Legacy laptop-only scaffolds (`/v1/whatsapp/*`, `/v1/desktop/*`, `/v1/browser/snapshot`) remain but are superseded by the node; remove after Phase 9 review
## Phase 7 — Clients and voice  (UI verified in a real browser 2026-10-10)
- [x] Dashboard + phone PWA (no build step): streaming chat with tool chips + voice in/out (browser speech), inbox with approvals (TOTP prompt for devices), tasks with execution trace, research browser with sources/contradictions, memory CRUD/pin/search, reminders, settings (personality, autonomy tiers, proactive, devices/TOTP, rules, health, models, skills), live SSE state orb, emergency stop, dark/light, responsive
- [x] Web Push (VAPID + RFC 8291, dependency-free; encryption round-trip tested; NOT yet verified against a real push service/phone)
- [x] Voice: Whisper (faster-whisper `small`, English + Hinglish prompt) for listening and Kokoro (soft/warm blend, selectable in Settings) for speaking, via an on-demand Python worker (~1 GB RAM while loaded, unloads after 5 idle min); browser recorder with pause detection; verified in real Chrome with a fake microphone; whisper.cpp/Piper CLI fallback; browser speech as last resort
- [x] Image creation (2026-10-26): `image_create` tool on NVIDIA-hosted FLUX (same key as the brain): FLUX.2 klein 4B (fast, ~2-3 s) or FLUX.1-dev (best, ~10 s), 7 aspect presets, 1-4 options, falls back to the other model when one is down. Friday writes the prompt; images are chat files shown inline (tap to enlarge) and the history shows her own prompt so tweaks (`based_on`, same seed/size/model) start from it. Generation only: hosted Kontext editing takes NVIDIA demo images only, so his photos cannot be edited yet. Owner only (not in member tools). Verified live against the API and in the browser.
- [ ] Verify PWA install + push on the real phone over Tailscale HTTPS

## Phase 8 — Companion
- [x] One derived companion state (14 states) for every body; `/v1/companion` + SSE stream; web 3D pet follows it; hardware events endpoint
- [x] ESP32-S3 firmware + wiring/BOM/protocol docs (NOT compiled or run on hardware) and Tauri desktop-pet shell config (NOT built: no Rust here)
- [ ] Build/flash firmware, 3D-printed body (design students), Tauri build

## Phase 9 — Polish, security, migration
- [x] Event-driven rules engine (bounded, loop-safe, approval-gated creation)
- [x] Legacy scaffolds removed (~2k lines); README + server deployment guide; memory measured (core 81 MiB idle, +~190 MiB per running agent)
- [x] Independent security audit run (see docs/security-audit-2026-10-10.md)
- [x] Deployed to the 6 GB server (2026-10-11) in Docker: core, isolated agent container (DSH 0.2.0-rc.2), filtering egress proxy; tailnet-only HTTPS; data migrated; voice installed; nightly backup; laptop node paired over the tailnet; cross-machine computer-use task verified
- [ ] Re-measure under sustained load; Web Push + phone PWA on the real phone
- [ ] Not started (spec'd as future): CRM, email, calendar (add as MCP servers + approval policy), smart-device control, AR/VR/projection, mobile robot

## Known gaps (honest list)
1. Not deployed on the server; nothing verified on the target machine.
2. Computer use is browser (DOM) + accessibility only; no raw input/desktop screenshots on GNOME Wayland; vision is slow/approximate (only the omni model works on the API) so it is used to describe, never to click.
3. WhatsApp flow works mechanically but needs your own login in the node's Chrome profile and carries a ban risk.
4. GitHub PR flow, Web Push on a phone, ESP32 firmware, Tauri build: written, not run.
5. DSH-internal subagents are not individually capped (worker concurrency + governor cap whole agent runs).
6. Episodic auto-summaries and memory consolidation are not implemented.
