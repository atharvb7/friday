# Friday v1 implementation contract

**Status:** active implementation, 28 September 2026. This document amends the supplied final vision. The vision remains the product direction; the rules below govern implementation on the fixed HP Victus laptop.

## Decisions now in force

1. No local LLM in the first release. Nemotron 3 Ultra through the existing NVIDIA/DSH route is the primary reasoning path. API outages return a visible blocked state. Local inference will be benchmarked later.
2. Friday Core owns identity, durable tasks, memory, scheduling, approvals, the effect ledger, resource admission, health, and the event stream. DeepSeek Harness runs agent turns behind an adapter in an isolated Friday home. Personal DSH state is never imported automatically.
3. Models produce plans and typed tool proposals. A policy layer authorizes effects. The model router has no `execute` operation.
4. Friday's browser uses a separate profile. The actuator order is API, files/CLI, Playwright DOM, AT-SPI, screenshot perception, Wayland portal input, then coordinates.
5. Phone access will use a loopback service proxied privately through Tailscale Serve, with application authentication and fresh approval for consequential actions. It is disabled until those controls exist.
6. Consequential actions follow propose, stage, verify target and content, approve, revalidate, commit, verify result, receipt. Unknown outcomes are inspected and are never blindly retried.
7. No new skills or MCP servers inherit credentials or broad access. Each receives scoped permissions.
8. The user keeps control of the desktop. Friday obtains a revocable computer-control lease before visible input; physical user activity cancels it.
9. The ESP32 companion, pet, voice, AR, and VR remain product goals. Hardware control will use firmware-enforced limits and an authenticated gateway.
10. Portability and backups are required. A future larger PC is optional, not a dependency for the laptop release.

## Memory policy

The laptop exposes roughly 14 GiB usable RAM and has already had Chrome/Chromium killed by `systemd-oomd` under sustained memory pressure. A nominal 5 GB Friday ceiling is insufficient as the only rule. Friday must yield to the rest of the laptop.

The first runtime uses two gates:

| Host MemAvailable or 10-second memory pressure | Mode | New heavy workers |
|---|---|---|
| At least 4 GiB and pressure below 3% | Normal | Eligible, subject to Friday process cap |
| Below 4 GiB or pressure at least 3% | Constrained | No |
| Below 2 GiB or pressure at least 10% | Paused | No |
| Below 1.25 GiB or pressure at least 25% | Emergency | No; cancel/checkpoint noncritical work |

Admission decisions must use both host availability and measured Friday cgroup memory once the service runs under systemd. Friday's active worker budget initially targets **under 2 GB**, with the core ideally under 200 MB. Any higher cap must be justified by stress testing while Chrome and development tools are open. VRAM is governed separately. No local model loads in this phase. Emergency handling preserves the task and effect ledger before stopping work.

## Build sequence

1. Foundation: lightweight loopback core, SQLite task/event storage, token auth, resource readings, idempotent task submission, cancellation, health and tests.
2. DSH adapter: separate Friday home and credentials, Nemotron chat execution, durable task handoff, worker cancellation, model error states. No reuse of personal sessions.
3. Phone interface: authenticated PWA over Tailscale Serve, reconnectable task views, explicit approvals, emergency stop.
4. File, coding, research and browser tools with permissions and receipts.
5. Native Wayland computer control, voice, pet and physical companion, each after measured reliability gates.

The initial repository implements only step 1. Its status endpoint explicitly reports later capabilities as unavailable.
