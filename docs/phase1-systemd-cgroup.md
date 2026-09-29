# Phase 1 — Friday systemd user unit and cgroup cap (operator notes)

Scope: Friday core only (`src/server.mjs` on `127.0.0.1:4317`). This phase
installs nothing that auto-starts Friday. It stages the user unit and verifies
that the memory cap is enforced by the cgroup.

Background: the laptop has ~14.7 GiB usable RAM with past `systemd-oomd` kills
of browser scopes while Friday was not running (see
`docs/friday-handoff-2026-09-28.md`, "RAM strategy"). The live core measured
~66 MiB RSS, but that covers only the small core — not DSH, browser workers,
voice, or computer control. The initial cap keeps active Friday work under
~2 GiB (`MemoryHigh=1536M`, `MemoryMax=2048M`). See
`docs/friday-v1-implementation-spec.md` "Memory policy" for the rationale.

## 1. Install the unit (DO NOT enable yet)

`enable --now` is NOT YET APPROVED for this phase. Staging only:

```sh
mkdir -p ~/.config/systemd/user
cp systemd/friday.service ~/.config/systemd/user/friday.service
systemctl --user daemon-reload
systemctl --user status friday
```

Expected: `status` shows `Loaded: loaded (.../friday.service)` and
`Active: inactive (dead)` — loaded but never started. Do not run
`systemctl --user enable --now friday`, `start`, or `enable` until the
resume-order step 1 integration (governor wiring + cgroup verification) is
explicitly approved.

To inspect the staged unit without starting it:

```sh
systemctl --user cat friday
```

Environment overrides (optional, still staged-only): `FRIDAY_DATA_DIR`
(default `./data` under the repo `WorkingDirectory`) and `FRIDAY_PORT`
(default `4317`) are commented `Environment=` placeholders in
`systemd/friday.service`. Uncomment/edit them in the installed copy, or use
`systemctl --user edit friday`, then `daemon-reload` again.

## 2. Verify the cgroup cap is applied (after an approved start)

Once a start is approved in a later step, confirm the limits from systemd:

```sh
systemctl --user show friday -p MemoryHigh,MemoryMax
```

Expected:

```text
MemoryHigh=1610612736
MemoryMax=2147483648
```

(`1536M` = 1610612736 bytes, `2048M` = 2147483648 bytes.)

Then read the live cgroup accounting directly. Find the service cgroup:

```sh
systemctl --user status friday   # look at the "CGroup:" line
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/friday.service/memory.current
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/friday.service/memory.high
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/friday.service/memory.max
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/friday.service/memory.peak
```

If the exact slice path differs on this host, resolve it via
`systemd-cgls --user-unit friday.service` or the `CGroup:` line in
`systemctl --user status friday`, then read `memory.current` /
`memory.peak` under that directory. `memory.peak` is the high-water mark
for the load test below.

## 3. Check Friday's own cgroup readings via /v1/status

`src/resources.mjs` (`readResources()`) reports the current cgroup v2 usage
and limits in the status payload's `cgroup` block:

- `cgroup.currentBytes` — cgroup `memory.current`
- `cgroup.highBytes` — cgroup `memory.high` (throttle point)
- `cgroup.maxBytes` — cgroup `memory.max` (hard cap)

Query (loopback only; needs the bearer token from `data/access-token`):

```sh
TOKEN="$(cat "$FRIDAY_DATA_DIR/access-token")"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/v1/status | python3 -m json.tool
```

Cross-check: `cgroup.currentBytes` should roughly match the `memory.current`
file read in section 2, and `highBytes`/`maxBytes` should match the
`MemoryHigh`/`MemoryMax` values. Until the governor is wired into the server
(handoff "Recommended resume order" step 1), `/v1/status` calls
`readResources()` directly — the readings are observable but not yet enforced
by admission logic.

## 4. Load-test procedure (from the handoff)

Run this only after an approved start, with the normal desktop load open
(Chrome + dev tools, as usual):

1. Record host baseline: `grep MemAvailable /proc/meminfo`, `free -h`,
   `cat /proc/pressure/memory`, and the Friday cgroup `memory.current`.
2. Exercise Friday normally (status/task round-trips; no DSH, browser, or
   voice work in this phase) while using the laptop normally for a
   representative session.
3. Sample every few minutes: host `MemAvailable`, Friday cgroup
   `memory.current`/`memory.peak`, `/proc/pressure/memory` (`some`/`full`
   averages), and observed task latency (time to complete a status round-trip
   or queued task step).
4. Record the high-water marks: host minimum `MemAvailable`, Friday cgroup
   `memory.peak`, worst PSI `avg10/avg60`, and worst task latency.

When to queue/reduce instead of raising the cap: if host `MemAvailable`
drops toward the governor's Constrained/Paused bands (below ~4 GiB / ~2 GiB),
PSI `some`/`full` stays elevated, or the Friday cgroup approaches
`MemoryHigh` (throttling) — queue new work, reduce concurrency (one worker
per class; browser work needs ≥ 5 GiB host-available, subagents ≥ 6 GiB per
the governor's initial levels), or postpone the task. A cap breach or host
pressure is a signal to do less, not to allow more.

## 5. Warnings

- **Never raise `MemoryMax` silently.** Any increase needs a recorded
  measurement (section 4 numbers), an explicit decision, and a unit-file
  change — not an ad-hoc runtime override.
- **Do not rely on swap as model memory.** The host has ~4 GiB of swap;
  swapping does not make a model or browser workload fit. Keep the working
  set inside the cgroup cap and host RAM budget.
- This is a `systemd --user` unit only. It must not gain system-level
  directives (no `NetworkManager`, `Requires=network-online.target`-style
  system wiring, no `[Install]` target outside `default.target`).
