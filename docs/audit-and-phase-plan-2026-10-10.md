# Friday — repo audit and phase plan (10 Oct 2026)

Basis: read of `src/server.mjs`, `nemotron.mjs`, `memory.mjs`, `intent.mjs`, `chat-reply.mjs`, `dsh.mjs`,
`browser-live.mjs`, `research.mjs`, `voice.mjs`, plus all docs; `npm test` run (146/146 pass); tool/binary
probe on this laptop. Live Nemotron/JEV/SerpApi calls were NOT exercised.

## 1. Headline

Friday today is a **well-guarded local task/approval control plane with a chat endpoint**, not yet a
Jarvis. Roughly 9.6k lines, zero npm dependencies, strong safety discipline (effect ledger, exact-arg
approvals, kill switch, traversal guards, audit hash chain). But most "phase complete" claims in
`docs/all-phases-complete-2026-10-05.md` mean *a stub with tests*, not a working capability.

## 2. What is genuinely working (verified in code + tests)

| Area | Reality |
|---|---|
| SQLite task/event store | Real. Idempotency, atomic claim, restart-blocks-running. |
| Effect ledger + approvals | Real. Single-use token bound to exact args; crash -> `effect_unknown`. |
| Resource governor | Real sampling every 2s, hysteresis, telemetry. Advice only; does not kill/unload anything. |
| Bearer-token API, rate limit, static PWA | Real. Loopback only. |
| Explicit memory | Real CRUD + FTS5 keyword search. No edit/pin UI route, no embeddings. |
| Chat -> Nemotron | Real HTTP to NVIDIA chat/completions w/ model fallback chain + retry/breaker. Plain chat only: last 20 msgs, 1024 max_tokens, no tools, no memory, no streaming. |
| Intent routing | Regex classifier (`intent.mjs`). JEV is optional and off. |
| Workspace file search/read | Real, confined. |
| CodeWork | Isolated workspaces + allowlisted test runner + git diff via API. Not driven by an agent. |
| Research store | Records sources/claims, flags contradictions, exports report. **Never fetches anything; no search.** |
| Scheduler + DueRunner | Real durable schedules -> queued tasks. |
| Live browser | Read-only `chrome --dump-dom` regex snapshot of one URL. No clicks/typing/login. |
| 3D pet page | Three.js GLB viewer polling `/v1/presence`; procedural animation. |

## 3. Facade / stubbed / dead-end

- **Agent runtime (DSH) is not running.** `dsh` binary is not on PATH; adapter was written against
  *assumed* CLI flags (`--no-shell --no-browser`) never run live. `FRIDAY_DSH_VERIFIED` off. So queued
  tasks (coding/research/browser/desktop) are **never executed**; chat just says "queued".
- Worker loop runs but its adapter is not ready -> tasks sit in `queued` forever.
- **No MCP, skills, subagents, SerpApi integration, GitHub, vector memory, context builder, event bus,
  websocket/SSE, model router (`ai.chat/reason/plan/execute`), local Qwen, STT/TTS, personality config.**
  (grep confirms zero hits.)
- Chat persona: hard-coded one-line system prompt ("concise personal computer agent") — none of the
  witty/chaotic Friday personality in the spec. Local-fallback replies say "laptop companion".
- Voice = browser Web Speech API in the PWA only; `voice.mjs` is chunking logic. Pet "talk" = head bob.
- Desktop control: `wtype`/`ydotool` not installed -> fail-closed. No screenshot, no vision, no AT-SPI
  (stubs).
- WhatsApp: stage/approve flow exists; the send path resolves `not_logged_in` — no browser automation
  behind it.
- Computer-use "autonomy levels" (ASK/TRUSTED/AUTONOMOUS/HIGH): not implemented.
- Phone access: not exposed (Tailscale runbook only). Tailscale is installed.
- ESP32/physical, AR/VR: nothing (correct for now).
- Execution trace UI, observability (tokens, latency, GPU), backup/migrate tooling, `friday` CLI
  (`start/status/doctor/logs`): not present. Only `npm start`.

## 4. Problems to fix before building more

1. **Secrets:** `.env` holds live NVIDIA, JEV and SerpApi keys. The NVIDIA key was previously flagged as
   exposed (handoff) and is not rotated. All three were also printed into this audit session's transcript.
   Rotate all three.
2. **Version control is messy:** git has 15 commits, last on 30 Sep (Phase 1 foundation). Everything after
   (~25 src modules, tests, docs, pet, voice, 565-line `server.mjs` rewrite) is **uncommitted**.
   No remote. Commit in logical slices first.
3. **`server.mjs` is a 565-line if-chain monolith** with a module-level singleton setup; needs a router
   and dependency container before it takes MCP/SSE/auth sessions.
4. **Docs contradict each other:** "100% complete" (30 Sep) and "All phases complete" (5 Oct) vs the
   handoff's honest gap list vs reality. Treat only this file + a single ROADMAP as truth; archive the rest.
5. **Spec drift:** all docs assume laptop, no local model, "no separate server". Your new plan (server,
   Qwen fallback, DSH as spine) invalidates `friday-v1-implementation-spec.md`; needs a rewrite.
6. `node:sqlite` is experimental; 250 MB-class design budgets in the spec were never measured.
7. `intent.mjs` regexes misroute normal language ("what is X" -> research, "call" -> voice, "at 5" ->
   schedule). Fine as a stopgap; wrong as the brain.
8. Generated artifacts committed to the working tree: 0.7 MB GLB at repo root, vendored three.js, CC-BY
   attribution needed.
9. Unverified: whether Nemotron model ids in `.env` actually exist on NVIDIA Build today.

## 5. What changes because the target is now a server (not the laptop)

- No physical desktop -> "operate the computer" must target a **virtual desktop** (Xvfb/Xpra/VNC +
  Playwright, AT-SPI inside it) or a remote agent on your laptop. This is the biggest design decision.
- Public/phone access: Tailscale or Cloudflare Tunnel + real auth (passkey/TOTP), since this is no longer
  "loopback on my own laptop".
- "6 GB free compute" is ambiguous: RAM, VRAM, or both? CPU-only vs GPU decides the local fallback
  (Qwen 7-9B Q4 ~5 GB; on CPU-only 6 GB RAM it will not fit next to everything else, so a 3-4B model or
  remote-only fallback).
- systemd unit, paths and `MemoryMax` (currently 2 GB for the core) must be redone for the server, with
  Docker/Compose as an option.

## 6. Proposed phases (each ends with measured RAM + a demo you can run)

0. **Hygiene (1-2 days):** rotate keys; commit history in slices; remove/ignore artifacts; one source-of-
   truth ROADMAP; rewrite spec for server; `friday` CLI skeleton (`start/stop/status/doctor/logs`).
1. **Server foundation:** provision + harden server (user, firewall, Tailscale, systemd/cgroup 5 GB cap,
   backups); deploy current core; refactor `server.mjs` into router + modules; SSE event bus; passkey/TOTP
   auth; health screen.
2. **Brain:** model router (`ai.chat/reason/plan/execute`), Nemotron streaming + tool calling, benchmark
   and adopt local fallback, personality config + real system prompt, context builder (intent -> memory
   -> project -> files -> session), vector memory (sqlite-vec) + memory edit/pin.
3. **Agent spine:** install real DSH separately from yours (`~/.friday-dsh`), verify CLI/profile, replace
   guessed flags, run queued tasks end to end; MCP client; skills loader; subagent pool w/ limits;
   execution traces.
4. **Research + coding + GitHub:** SerpApi MCP, real fetch + extraction research pipeline persisted;
   isolated coding workspaces driven by agent; GitHub MCP, PR flow.
5. **Browser + computer use:** Playwright persistent profile, virtual desktop on server, screenshot/vision
   loop, autonomy levels, activity-pause, WhatsApp flow behind approvals.
6. **Clients:** phone PWA polish, push notifications, voice (server-side whisper.cpp/piper if budget
   allows), proactive automations.
7. **Companion:** Tauri pet (reusing pet viewer), personality UI, ESP32-S3 gateway + prototype.
8. **Polish/reliability/migration**, later AR/VR.

## 7. Decisions recorded 10 Oct 2026 (from user)

- Final host: Linux server, **6 GB RAM, no GPU**. Friday + DSH both live there. **No local model** (Qwen dropped;
  fallback = other remote providers via the model router, then honest degraded mode).
- Clients: laptop, phone, hardware devices (ESP32) all connect to the server.
- Build and prove everything on the laptop first; deploy to the server after it works. Therefore everything
  must be portable: env-driven paths, one data dir, systemd/Docker packaging, no laptop-specific paths.
- Target: always-on (24/7), remembers tasks, reminds, researches, does work, fully autonomous.
- Autonomy model: per-category tiers (ASK / TRUSTED / AUTONOMOUS / HIGH). Default irreversible actions (money,
  deletion, messages to other people, security changes) stay approval-gated until the user raises a tier.
- Open: computer-use target. Proposed: virtual desktop on the server for Friday's own work + a thin
  "laptop node" agent (outbound connection to server) when it must touch the laptop.

## 8. Computer-use decision (10 Oct 2026)

Computer use and logged-in browser control run **on the user's laptop**, not the server.
- Server (24/7): brain, DSH, memory, tasks, reminders, research via search/fetch, coding in server workspaces.
- Laptop "node": small Friday client that dials OUT to the server (WebSocket over Tailscale/TLS), runs
  screenshot/click/type/AT-SPI/Playwright against the real Chrome profile, honours the control lease and
  pauses on user activity. Server never gets inbound access to the laptop.
- Consequence: computer/WhatsApp-type tasks only execute while the laptop is on and the node is connected;
  otherwise they queue and the user is told. Everything else keeps working 24/7.
- Phase 5 is therefore "laptop node + node protocol", built first on the laptop (server and node on one
  machine), then split when the server is deployed.
