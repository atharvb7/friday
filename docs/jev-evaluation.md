# JEV evaluation for Friday

**Status:** evaluation only. Nothing installed, downloaded, or benchmarked.
**Ground rules:** laptop is fixed (i5-13420H, 14 GiB RAM + 4 GiB swap, RTX 3050
6 GiB VRAM, Ubuntu 26.04 / GNOME Wayland). "JEV" is unattested anywhere in the
repo or the master design doc, so every meaning below is a candidate hypothesis
scored the same way: what it would do, where it plugs in, what it costs on this
laptop, what safety gating it needs, and a verdict of **adopt / scaffold / defer**.

## Candidate 1 — JEV as a JS voice-activity library (wake/VAD/utterance chunking)

**What it would do in Friday:** small JavaScript helper that turns raw microphone
audio into speech segments: voice-activity detection, utterance boundaries, and
"user started / stopped talking" events. It would *not* transcribe (faster-whisper
keeps that job) — it just decides *when* to listen, when to cut an utterance, and
when to barge in (duck/cancel TTS). Think "Silero VAD semantics, JS-callable."

**Where it plugs in:** Phase 4 voice pipeline. Two seams: (a) the Friday PWA for
phone push-to-talk + client-side VAD pre-trim so only speech frames hit the
network; (b) the laptop control plane as the event source driving pet states
`sleeping -> listening -> thinking` and TTS barge-in cancellation.

**Cost on this laptop:** negligible. A VAD-class model is tens of MB of weights and
single-digit ms per chunk on CPU; as JS/WASM it adds ~10–50 MB RSS to the hosting
process and zero VRAM. No threat to the "one heavy GPU workload at a time" budget;
STT/TTS GPU bursts are untouched.

**Safety gating required:** medium-low but non-zero. Audio frames are untrusted
input: VAD output may only *schedule* work (start a transcription turn), never
authorize effects. Barge-in cancel must be idempotent (cancel of an already-done
utterance is a no-op, never a retry-with-teeth). Mic capture needs the same
explicit opt-in posture as the doc's camera/screen-awareness rule, plus a visible
`listening` indicator so recording is never silent.

**Verdict: SCAFFOLD.** Define a `VoiceActivity` adapter interface now
(`onSpeechStart/onSpeechEnd/onBargeIn`, frame budget, sample-rate contract), stub
it with the existing push-to-talk + Silero-style chunking plan, and keep JEV-as-lib
as a swappable backend behind that seam. No dependency until Phase 4.

## Candidate 2 — JEV as a local LLM runtime (on-device small-model server)

**What it would do in Friday:** serve the local-fallback model (the Qwen3.5-4B Q4
class role in the design doc): intent classification, deterministic-command
handling, and reduced-autonomy chat when the Nemotron endpoint is unreachable.

**Where it plugs in:** the model/resource router's `LOCAL` route, behind the
existing provider abstraction with health checks and circuit breaking. Must
announce **Local mode — limited autonomy** and shed permissions exactly as the
design doc specifies (no sends/deletes/arbitrary shell/raw-coordinate control).

**Cost on this laptop:** the heaviest of the four. ~2.5 GiB weights (Q4_K_M) plus
~1–2 GiB KV cache at 8–16K context ≈ 3.5–4.5 GiB of the 6 GiB VRAM, and it is only
viable *exclusive*: the doc already forbids co-residing a 4B VLM + large GPU
Whisper + many Chrome tabs + Docker. RAM-side the daemon costs ~0.5–1 GiB plus
context; under GNOME + Chrome + dev tools that fits 14 GiB only with the resource
broker evicting/pausing competing work. Any runtime that cannot do lazy
load/unload, single-flight requests, and VRAM-class admission control fails the
machine budget regardless of quality.

**Safety gating required:** high. Capability downgrade on fallback entry (deny by
default, re-approve consequential classes), prompt-injection posture unchanged
(webpage/file text is data, never authority), and the fallback must never silently
retain the Nemotron permission set. Acceptance gate "local fallback never silently
retains full permissions" applies verbatim.

**Verdict: DEFER (as "JEV specifically").** The *role* is already designed and Phase
0 already benchmarks Qwen3.5-4B via the current toolchain. A new runtime earns a
slot only if it beats the incumbent on VRAM residency, load/unload latency, and
tool-call compatibility in a measured spike — not on branding. Revisit with numbers.

## Candidate 3 — JEV as ESP32/hardware peripheral (far-field mic / presence / pet beacon)

**What it would do in Friday:** a cheap ESP32 node as Friday's ears-on-the-shelf:
far-field push-to-talk button, presence detection (room occupied?), and optionally
a physical pet-status LED. It would stream Opus audio or just VAD-gated clips to
the laptop over the tailnet.

**Where it plugs in:** voice capture edge (feeds the same pipeline as Candidate 1's
consumer) and embodied-state output (pet `sleeping/listening/waiting` as light).
Pairs with the "minimal GNOME extension renders state over narrow IPC" philosophy:
dumb renderer, all authority on the laptop.

**Cost on this laptop:** ~zero compute (no RAM/VRAM; a trickle of LAN audio).
Real costs are money (~$10–30 in parts), time (flashing, enclosure, mic tuning),
and reliability (Wi-Fi dropouts, resync, clock drift). Fails the "no new hardware
decisions" spirit of the fixed-laptop baseline and adds a second device to secure,
update, and debug.

**Safety gating required:** medium. An always-on mic is the most sensitive sensor
in the system: hardware mute switch, on-device VAD gating so silence never leaves
the node, TLS/client-identity on the ingest path (tailnet device identity, not
just LAN reachability), and no actuation authority — the node may *request*
attention, never *grant* it. Lost/stale node must read as `offline`, never as
consent.

**Verdict: DEFER.** Charming Phase-5 embodiment work, but it spends hardware
budget to solve a problem the laptop mic + phone PWA already cover for the alpha.
Revisit only after the dashboard pet and voice pipeline prove themselves.

## Candidate 4 — JEV as an npm package dependency (third-party skill/tool library)

**What it would do in Friday:** prebuilt tools/skills (file search, web helpers,
formatters) consumed as a dependency by the DeepSeek Harness worker or control
plane instead of hand-rolled plugins.

**Where it plugs in:** DSH adapter plugin set / control-plane tool registry — the
exact layer the design doc warns about: "Skills must be versioned, reviewed,
permissioned, and reversible — not prompt snippets downloaded and trusted."

**Cost on this laptop:** small at runtime (dependency RAM is MBs; no VRAM), but
the cost that matters is supply-chain: audit burden, transitive deps, and
breakage risk against a harness the doc already flags as developer-preview with
compatibility-breaking changes.

**Safety gating required:** highest relative to value. Full skill-governance gauntlet
before any third-party tool runs: pin + hash, version review, minimum capability
grant per tool, sandbox parity (filesystem vocabulary is not enough — network and
process visibility need explicit rules), egress minimization, and revocation that
actually unloads the code path. Anything with install/postinstall scripts or
network self-update is disqualified.

**Verdict: DEFER (default-deny).** Build the five or six tools Friday actually needs
in-repo first; vendor a third-party package only to retire a proven in-house tool
with tests showing superiority. Never `npm install` a capability.

## Comparison

| Candidate | Role | Plug point | RAM / VRAM | Safety load | Verdict |
|---|---|---|---|---|---|
| 1. JS voice-activity lib | VAD / utterance chunking / barge-in events | PWA + voice pipeline (Phase 4) | +10–50 MB CPU, 0 VRAM | Low-medium | **Scaffold** |
| 2. Local LLM runtime | Fallback inference server | Router `LOCAL` route | ~0.5–1 GiB RAM, ~3.5–4.5 GiB VRAM exclusive | High | **Defer** |
| 3. ESP32 peripheral | Far-field mic / presence / LED | Voice edge + pet output | ~0 laptop compute | Medium | **Defer** |
| 4. npm package | Third-party tools/skills | DSH plugins / tool registry | MBs, 0 VRAM | Highest/value | **Defer** |

## Top guess and next step

**Top guess: Candidate 1 — JEV as a JS voice-activity library, verdict SCAFFOLD.**
Reasoning: it is the only candidate that buys Phase-4 capability (300–700 ms
partial-transcript responsiveness, reliable barge-in) at essentially zero resource
cost, with no new daemon, no new hardware, and no supply-chain authority. It also
matches the doc's sequencing — voice is Phase 4, so an adapter seam defined now
costs one interface and keeps every backend option open.

**Concrete next step (no downloads):** add a `VoiceActivity` interface to the
Phase-4 plan (`start/stop`, `onSpeechStart/onSpeechEnd/onBargeIn`, per-chunk CPU
budget, 16 kHz mono contract) with a null/push-to-talk implementation; evaluate
any concrete JEV library against it later by measurement (false-accept rate on
room noise, end-of-utterance latency, CPU under GNOME+Chrome load) before adoption.
