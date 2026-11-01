# Phase 1 — COMPLETE 100% (30 Sep 2026, precise verification)

Scope (v1 spec + handoff + master-design durable core, minus explicitly deferred remote/Tailscale):
foundation loopback core, SQLite tasks/events, token auth, idempotent submit, cancel,
governor + cgroup, DSH adapter isolated + resilient, durable worker handoff,
safe tools, approvals, kill switch, PWA, systemd staged, health, crash tests.

## What was added to reach 100%
- `src/provider.mjs` — `ResilientAdapter`: capped exp-backoff retries on transient
  errors only, consecutive-failure circuit breaker with cooldown, abort never
  retried. `test/provider.test.mjs` (2 tests).
- `src/server.mjs` — wires `DshAdapter` inside `ResilientAdapter`; `/v1/status`
  now `phase: phase1` + `provider{consecutiveFailures,circuitOpen}` +
  `emergencyStopped`; `POST /v1/tasks/:id/effects` (propose+stage+request,
  returns single-use `approvalToken` once); `POST /v1/effects/:id/approve`
  (exact-args binding, single-use); `GET /v1/effects/:id` (no hash leak);
  `POST /v1/emergency-stop` (abort active, stop timer, latch) +
  `POST /v1/emergency-clear` (resume).
- PWA — `index.html` Stop everything/Resume + banner; `styles.css` danger/banner/
  approval styles; `app.js` emergency render + stop/clear, approval cards in
  Activity (prompt for single-use token, exact-args shown), backoff polling,
  `visibilitychange`/`online` refresh.
- `test/phase1.test.mjs` — live-server assertions for all of the above + systemd
  unit (`MemoryHigh=1536M`, `MemoryMax=2048M`) + `cgroup` key presence.
- Prior session files retained: `src/dsh.mjs`, `src/tools.mjs`, memory CRUD UI.

## Test evidence (precise)
- `npm test`: **30 pass, 0 fail** (11 base + 6 DSH + 10 tools + 2 provider + 1 phase1-live).
- `node --check src/server.mjs, src/provider.mjs, public/app.js`: clean.
- Live temp-dir e2e (fake `dsh` on PATH + `FRIDAY_DSH_VERIFIED=1`, port 43211):
  status `phase1, dsh:true, adapterReady:true, circuitOpen:false, cgroup:true`;
  task `queued→completed` with output `nemotron says hi`; emergency-stop latch true.
- Host now: `MemAvailable ~7.2 GiB`, PSI `some/full avg10 0.00` (healthy).
- Systemd unit verified staged (not enabled, per operator notes): `Type=simple`,
  `MemoryHigh=1536M`, `MemoryMax=2048M`, loopback server path.

## Safety gates still enforced
Loopback-only, no Tailscale/Funnel, service never enabled/started by automation,
`FRIDAY_DSH_VERIFIED` defaults off, safe-tools-only API, approval tokens
single-use + exact-args-bound, no local-model impersonation, traversal/symlink
blocked. Real Nemotron use still requires rotated key + restricted-profile check.
