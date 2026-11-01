# Friday laptop memory check — 28 September 2026

The laptop has **14.7 GiB usable RAM** as reported by Linux (`MemTotal` 15,832,461,312 bytes), despite a 16 GB installed-memory label. At inspection, about **8.9 GiB was available**, all **4 GiB of swap was free**, and the current 10-second memory pressure value was **0%**. The machine was healthy at that instant.

The intermittent problem is confirmed in `/var/log/syslog`:

- 25 September, 21:26 IST: `systemd-oomd` killed a Google Chrome scope after user-session memory pressure exceeded its threshold for more than 20 seconds; **36 processes** were killed. A separate NVIDIA driver out-of-memory message appeared earlier that evening, which concerns GPU allocation rather than necessarily system RAM.
- 27 September, 16:56 IST: `systemd-oomd` killed a Chromium scope after sustained pressure; **119 processes** were killed.

At this inspection, cgroup `memory.current` attributed approximately **1.58 GiB** to one Google Chrome scope, **0.85 GiB** to a second Chrome scope, **0.55 GiB** to Chromium, **1.27 GiB** to the ChatGPT/Codex desktop scope, and **0.90 GiB** to a terminal scope. These are cgroup charges, which can include cache and shared memory; they are not additive process RSS measurements. Browser activity is the most obvious current source of variable pressure. No applications were closed or settings changed during this check.

The new Friday core used **about 66 MiB RSS** in a live API check. It loads no local model and starts no browser or DSH worker. The initial architecture admits heavy workers only while host `MemAvailable` is at least **4 GiB** and memory pressure is low. This is a conservative starting threshold, to be adjusted after real browser and DSH stress measurements.

The next performance gate is an instrumented DSH session while normal Chrome and development tools are open. Record peak host availability, Friday cgroup memory, memory pressure, DSH RSS, browser scope memory, and task latency. Do not enable unattended background workers until that test passes without sustained pressure or `systemd-oomd` intervention.
