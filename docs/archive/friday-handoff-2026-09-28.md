# Friday implementation handoff — 28 September 2026

This document records the state at the user's request to stop. Implementation and subagent work were stopped. It distinguishes code that exists from code that is connected and usable. The project remains a large, multi-stage build; no claim is made that the full Friday system is finished.

## Product decisions carried forward

- Friday runs primarily on the fixed HP Victus laptop. The phone is a remote client while the laptop is powered on and reachable. No separate server machine is required.
- NVIDIA Nemotron 3 Ultra through the already configured DeepSeek Harness route is the intended primary reasoning path. Friday's DSH state must be separate from the user's personal DSH state.
- **No local model is included now.** No Qwen or other local model is downloaded, loaded, or routed. Outage behavior should be explicit until a later benchmark proves a local fallback fits.
- Friday Core should own durable tasks, policy, approvals, memory, resource admission, health, and event records. DSH should be an execution adapter behind it.
- Desktop/browser actions must use semantic APIs first and require exact-target verification for consequential effects.
- RAM protection is a product requirement because this laptop has already experienced memory-pressure kills while Friday was not running.

The revised implementation contract is [friday-v1-implementation-spec.md](friday-v1-implementation-spec.md). The earlier research and architecture are in [friday-laptop-only-master-design.md](friday-laptop-only-master-design.md). This handoff is the authoritative record of implementation progress at the stop point.

## Observed RAM situation

Linux reports about **14.7 GiB usable RAM** and **4 GiB swap**. During inspection on 28 September, about **8.9 GiB was available**, swap was unused, and immediate memory pressure was zero. This good instant snapshot does not erase the intermittent problem.

System logs confirm:

| Time, Asia/Kolkata | Event |
|---|---|
| 25 Sep, 21:26 | `systemd-oomd` killed a Google Chrome scope after sustained user-session pressure; 36 processes were killed. |
| 27 Sep, 16:56 | `systemd-oomd` killed a Chromium scope after sustained pressure; 119 processes were killed. |

An NVIDIA driver allocation failure also appeared on 25 September; that is a separate GPU-memory symptom and should not be conflated with the system-RAM incidents. During a current cgroup inspection, browser-related scopes together charged roughly 3 GiB, the ChatGPT/Codex desktop scope roughly 1.3 GiB, and a terminal scope roughly 0.9 GiB. Cgroup charges include more than unique process RSS. Full evidence and caveats are in [friday-ram-check-2026-09-28.md](friday-ram-check-2026-09-28.md).

The live Friday core measured about **66 MiB RSS** while serving its status API. That measurement covers only the small core, not DSH, browser workers, voice, or computer control.

### RAM strategy implemented in code, pending live integration

`friday/src/resources.mjs` now reads host `MemAvailable`, swap, Linux memory pressure (`some` and `full` PSI), current process RSS, and the current cgroup v2's memory usage, high/max limits, and pressure where available.

`friday/src/resource-governor.mjs` adds immediate escalation and delayed recovery to avoid rapid on/off oscillation. Its initial levels are:

| Mode | Initial host trigger | Intended behavior |
|---|---|---|
| Normal | At least 4 GiB available and low PSI | Bounded new work may start. |
| Constrained | Below 4 GiB or elevated PSI | Stop admitting background/browser/subagent work. |
| Paused | Below 2 GiB or more severe PSI | Preserve core controls; stop optional work. |
| Emergency | Below 1.25 GiB or severe PSI | Abort/checkpoint noncritical work with effect-state awareness. |

The governor also considers cgroup limits. Browser admission requires at least 5 GiB host availability and subagent admission at least 6 GiB. It allows one worker per class and always rejects the `local-model` class. Recovery requires 30 seconds above higher exit thresholds. Optional JSONL telemetry is capped and rotated. The governor's `pressureActions()` are **advice**, not automatic killing; the server and worker must still apply them safely.

Before enabling DSH on this laptop, put the entire Friday service/worker tree into a dedicated systemd user cgroup with a measured `MemoryHigh` and `MemoryMax`, initially targeting under **2 GiB** for active Friday work. Test with normal Chrome and development tools open. Avoid relying on swap as model memory. If DSH/browser workloads exceed the budget, queue them, reduce browser concurrency, or postpone the task; do not raise the limit silently.

## Code present today

All code is under [friday/](/home/atharv-bhosale/Documents/Codex/2026-09-20/i-x20/friday/README.md). Node.js 22.13+ is required. There are currently no third-party package dependencies.

| Component | Files | Current state |
|---|---|---|
| Local API | `src/server.mjs` | Starts on `127.0.0.1:4317`, uses a 256-bit bearer token generated in `data/access-token`, and supports task, memory, status, and read-only effect endpoints. It was run and verified once, then stopped. |
| Task/event store | `src/store.mjs` | SQLite WAL; create/list/get/cancel tasks; idempotency keys; event records; atomic claim for one queued task. On restart, formerly running/planning tasks become blocked with an interruption record rather than silently re-running. |
| Effect ledger | `src/effects.mjs` | Internal propose → stage → request approval → approve → begin commit → verify states. Approval token is single-use and bound to exact arguments. A commit interrupted by restart becomes `effect_unknown`. No real outbound tool uses this ledger yet. |
| Explicit memory | `src/memory.mjs` | Local SQLite + FTS5; create/list/search/delete with source, project, confidence, and sensitivity fields. It is not automatically supplied to DSH yet. |
| Resource monitor/governor | `src/resources.mjs`, `src/resource-governor.mjs` | Host/cgroup/PSI readings, hysteresis, class-based admission, optional bounded telemetry. The live API currently calls `readResources()` directly; it does **not** instantiate or enforce the governor yet. |
| Worker loop | `src/worker.mjs` | Generic single-task worker interface, guarded by governor admission, supports cancellation and emergency abort, records success/failure. It is **not** imported or started by the server because a safe DSH adapter is not ready. |
| Phone UI source | `public/index.html`, `public/styles.css`, `public/app.js` | Responsive interface for token entry, status, memory display, task creation/list/activity/cancellation. Token stays in `sessionStorage`. The server does **not** serve these assets yet. The interrupted follow-up to add memory editing and result/error display was not completed. |
| Local data | `data/` | Owner-only token and SQLite database. A cancelled smoke-test task exists in this database. The token was never included in this document. Preserve or deliberately reset these files when resuming. |

The API currently reports `dsh: false`, `computerUse: false`, `remoteAccess: false`, and `localModel: false`. That is accurate. Task submission stores a task; it does **not** execute it.

## Verification completed

- `npm test` from the `friday/` directory: **10 tests passed, 0 failed** at the stop point.
- Tests cover task persistence/idempotency/restart blocking, effects and crash-unknown behavior, explicit memory search/delete, host/cgroup pressure readings, governor hysteresis/admission/telemetry, and worker admission with a fake adapter.
- A live localhost status request succeeded. A live task was created and cancelled. Core RSS was about 66 MiB in that run. Token and database permissions were `0600`, data directory `0700`.
- `node --check friday/public/app.js` passed when the phone UI was created.
- The DSH adapter and phone UI are not end-to-end tested because they are not connected.

`node:sqlite` in Node 22 emits an experimental API warning. It works in this environment, but pinning the Node version or moving to a stable SQLite package should be decided before declaring a reliable long-running release.

## What the subagents did and where they stopped

The user requested GPT-6 Luna subagents. Three were used:

1. **Memory agent:** finished `resources.mjs`, `resource-governor.mjs`, and four resource tests. Its work is present and passing.
2. **Phone agent:** finished the base `public/` UI. A follow-up to add memory CRUD and task result/error display was interrupted at the user's stop request; no follow-up changes should be assumed.
3. **DSH agent:** inspected the local DeepSeek Harness CLI and proposed a cancellable, isolated `dsh --profile headless` adapter. It was interrupted before writing any `dsh*` code. There is no DSH adapter file or active Friday DSH instance.

The DSH agent identified an important boundary: the default headless profile can expose tools. A phone-submitted instruction must not automatically inherit shell/browser/network privileges. The adapter should remain disabled unless a restricted profile or launcher is verified. It should use Friday-owned `DSH_HOME` and `DSH_AGENTS_HOME`, a scrubbed environment, time/output limits, cancellation, and separate credentials. Never copy personal DSH sessions or its whole home directory.

## Known incomplete integration and issues

These are concrete work items, not merely future ideas:

1. **No live governor enforcement.** Wire `ResourceGovernor` into server status, admission, telemetry, and the worker. Decide which pressure modes cancel an active task, and keep effect outcomes inspectable when cancellation occurs.
2. **No DSH execution.** Implement and test isolated Friday DSH configuration, model selection for Nemotron, restricted tools/sandbox, subprocess lifecycle, timeout, cancellation, failure mapping, and credential injection without logging secrets. The existing personal DSH Nemotron setup must remain isolated. The previously exposed NVIDIA key should be rotated before reuse.
3. **No server/worker connection.** After the adapter is safe, construct `WorkerLoop` in the server, start it, make `/cancel` abort an active worker, and await worker shutdown before closing SQLite. Show real readiness in `/v1/status`.
4. **Phone UI is not served.** Add fixed-path static serving for `/`, `/styles.css`, and `/app.js`, with appropriate content types, no-store for private responses, a restrictive Content Security Policy, and no directory traversal. End-to-end test token entry, status, task flow, and phone-size layout.
5. **No remote phone access.** Only after app auth and UI tests, configure Tailscale Serve to proxy the loopback app privately. No Funnel/public internet endpoint. Add stronger re-authentication for approvals and a kill switch.
6. **No effect sink.** The effect ledger is internal. File writes, messaging, GitHub, browser actions, purchases, deletion, and other external effects must use typed tools that verify targets and pass through the ledger and policy check. Do not expose a generic approval-to-arbitrary-command shortcut.
7. **No browser/desktop automation.** Build a dedicated Friday Chromium profile, Playwright semantic browser driver, then AT-SPI and supported Wayland RemoteDesktop portal integration. GUI control must have a revocable control lease and pause for local user activity. Tests must cover lock/suspend, wrong recipient, changed UI, and crash after click.
8. **No voice, pet, physical device, AR/VR, or proactive automations.** These remain future phases after the core and computer-use reliability gates.
9. **Small API hardening issues.** `/v1/status` counts at most the 100 tasks returned by `listTasks()` rather than a true database count. An overlong memory search currently falls into a generic 500 instead of 400. The API has no rate limiting or long-running authentication session model. These should be corrected before remote exposure.
10. **No service installation or startup policy.** Friday is not installed as a systemd service. No laptop power, Tailscale, browser, or OS settings were changed. It is not currently running.

## Recommended resume order

The following sequence produces a useful, testable vertical slice while keeping RAM bounded:

1. **Integrate governor and server.** Add periodic sampling, status exposure, pressure history, worker admission, and safe shutdown. Create a systemd user unit with an initial memory limit and verify cgroup readings in the running process. Test under ordinary Chrome/VS Code load and record high-water marks.
2. **Complete the isolated DSH adapter.** Use a separate Friday home/workspace and a restricted, explicitly configured Nemotron profile. Validate normal reply, provider failure, timeout, cancellation, restart, and no leakage from personal DSH. Start with one task at a time and no outbound computer-use permissions.
3. **Connect worker and UI locally.** Serve the PWA, show queued/running/blocked/completed results, support retries only after explicit review of blocked work, and exercise one end-to-end read-only research task. Fix the API hardening issues above.
4. **Add private phone access.** Test on the user's actual phone over Tailscale, including reconnect, authentication loss, laptop suspend, and task cancellation. Keep outbound actions disabled at this stage.
5. **Implement typed safe capabilities.** First read-only file search, research with source records, and coding in isolated workspaces. Then dedicated browser profile and staged external effects with approval receipts.
6. **Add native GUI control, voice, pet, and physical companion in that order.** Each needs its own measurements and failure tests on this exact laptop.

### Minimum acceptance gates before broad autonomy

- Friday-owned cgroup stays within the chosen cap while the laptop is used normally; sustained host pressure causes queued work to pause before `systemd-oomd` acts.
- A task survives UI reload and Friday restart without an unreviewed duplicate effect.
- An ambiguous file, recipient, or account blocks the action.
- External communications show exact destination and content immediately before a single-use approval.
- An interruption after a possible send yields `effect_unknown` and inspection, never a blind resend.
- Prompt text from webpages/files cannot grant permissions.
- The phone has a reliable cancel and emergency-stop path.
- Local-model capability remains disabled until separately benchmarked and requested.

## How to inspect or run the current prototype later

From `/home/atharv-bhosale/Documents/Codex/2026-09-20/i-x20/friday`:

```bash
npm test
npm start
```

The server binds `127.0.0.1:4317`. Its generated bearer token is stored in `data/access-token` with owner-only permissions. The README contains a localhost status example. Do not paste the token into chat or commit `data/`. The UI files are source assets only until static serving is implemented. The stopped state should be respected until the user asks to continue.
