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
## Phase 3 — Agent spine
- [ ] Install Friday DSH in ~/.friday-dsh, verify real CLI/profile, replace guessed flags
- [ ] Tasks execute end to end, execution traces, retry/resume/cancel
- [ ] MCP client, skills loader, subagent pool with limits
## Phase 4 — Always-on assistant
- [ ] Reminders + durable scheduler with push notifications (phone)
- [ ] Proactive loop (briefings, overdue tasks, CI failures), anti-annoyance rules
- [ ] Autonomy tiers enforced in policy layer
## Phase 5 — Research, coding, GitHub
- [ ] SerpApi MCP + fetch/extract + persisted research pipeline with citations
- [ ] Agent-driven coding workspaces, tests, GitHub MCP PR flow
## Phase 6 — Laptop node (computer use)
- [ ] Node protocol + outbound connection, lease, activity-pause
- [ ] Playwright persistent profile, screenshot/vision loop, AT-SPI, Wayland/X11 input
- [ ] WhatsApp-style flows behind approvals, verification after every action
## Phase 7 — Clients and voice
- [ ] Phone PWA polish, voice (cloud STT/TTS), notifications
## Phase 8 — Companion
- [ ] Tauri desktop pet, personality UI, ESP32-S3 gateway + prototype
## Phase 9 — Polish, migration, later AR/VR
