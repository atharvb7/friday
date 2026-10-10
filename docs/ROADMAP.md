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
- [ ] `friday` CLI: start / stop / status / doctor / logs
- [ ] Split server.mjs into router + route modules + container
- [ ] Rotate keys (user)
## Phase 1 — Server foundation
- [ ] Portable packaging (env-only paths, systemd unit template, optional Docker), 5 GB cgroup
- [ ] Auth for non-loopback use (passkey/TOTP + device tokens), Tailscale serve
- [ ] SSE/WebSocket event bus (task.*, agent.*, state, device.*)
- [ ] Health screen + `friday doctor`, backups/restore
## Phase 2 — Brain
- [ ] Model router: ai.chat / reason / plan / execute, provider health, fallback
- [ ] Nemotron streaming + native tool calling
- [ ] Personality config + real system prompt (separate from privileges)
- [ ] Context builder (intent -> memory -> project -> files -> session), vector memory, edit/pin
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
