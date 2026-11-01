# All phases — complete (5 Oct 2026)

## JEV (correct meaning, per user): classification model by TypeSafe AI
System One model, no text generation. One POST returns typed decisions:
choice (≤255 labels) + score (ordered scale) + noul (yes/no probability),
each with calibrated confidence, ~70–500ms, ~$0.001/decision.
Endpoints: `POST https://jevtypesafeai.com/api/v1/decide` (jv_live_ key) or
`POST https://api.typesafe.ai/v1/systemone` (official). Pinned `jev-1.13.0`.

`src/jev.mjs` (`JevClient`): `routeInstruction(text)` batches intent choice +
risk score + approval noul + urgency in ONE call. No key/offline/failure →
local keyword fallback with LOW confidence that fails closed
(unknown + approval required). JEV never grants authority; policy layer decides.
Key only from `FRIDAY_JEV_KEY`, never logged. `POST /v1/route` exposes it
(no execution) and audit-logs the decision. Live check: "find xyz.pdf" →
file_search/no-approval; "send xyz.pdf to Rohan on WhatsApp" → browser/risk 4/
approval-required. `test/jev.test.mjs` (4 tests).

## Phase coverage (all wired, safe defaults, 101 tests green)
- P1 durable core: tasks/events/effects-approval/retry+breaker/emergency-stop/PWA/systemd-staged/health/crash tests.
- P2 useful: `CodeWork` isolated workspaces (allowlisted tests, git diff),
  `ResearchStore` (https-only, contradictions, reports), `Scheduler` (durable
  claim/done/cancel) — API: /v1/workspaces, /v1/research, /v1/schedules.
- P3 computer: `BrowserDriver` dedicated-profile scaffold (https-only, loopback
  debug, stage-without-send, WhatsApp caution), `ComputerControlLease` single-
  holder + `AtSpi`/`Portal` stubs (fail-closed, needsVerification). No injection.
- P4 voice/pet: `VoicePipeline` (chunk≤200, barge-in, visual-confirm gate) +
  `PetStateMachine` (display-only, 8 states) + dashboard badge.
- P5 proactive/audit: `Automations` (explicit owner/trigger, read-only caps,
  expiry, maxPerDay, kill) + `Audit` hash chain (redacted, verify) — API:
  /v1/automations, /v1/audit/verify, /v1/presence.
- Improvements: JEV router, audit on route/schedule/workspace, presence endpoint,
  pet badge, backoff polling, approval cards, traversal/symlink guards everywhere.

## Verification
`npm test`: **101 pass, 0 fail**. `node --check` clean. Live temp-dir checks:
route (both cases), schedules, research (https-only), workspaces (traversal 400),
automations (send-capability rejected), audit verify ok, presence
(pet sleeping, drivers honest, jevConfigured false without key).
E2E worker with fake dsh: task completed. Host healthy (~7 GiB avail, PSI 0).
Loopback-only, no Tailscale/Funnel, service never auto-enabled, DSH verified-flag
defaults off. Real Nemotron/JEV use needs rotated keys + restricted-profile check.
