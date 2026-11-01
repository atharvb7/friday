# Friday: feasibility and architecture review

> **Superseded:** the requirements were later locked to a laptop-only, fixed-hardware system. Use the [laptop-only master design](./friday-laptop-only-master-design.md) for the current architecture and recommendations.

**Review date:** 20 September 2026  
**Scope:** Read-only inspection of the supplied concept, this laptop’s hardware/software environment, and current primary documentation. No project was built or installed.

## Executive verdict

Friday is feasible as a serious personal system, but not as the 17-feature “MVP” in the brief. The laptop is strong enough to be Friday’s control plane, state store, browser/coding host, voice host, and a modest local-model host. It is not strong enough to run Nemotron 3 Ultra locally, and a 6 GB laptop GPU cannot make a weak local model a safe drop-in replacement for a frontier model during consequential autonomous work.

The right product is a **hybrid, capability-based personal agent**:

- local control plane, memory, tasks, files, policy, audit, browser profiles, UI, and pet;
- remote reasoning model(s), starting with Nemotron 3 Ultra but never coupled to it;
- a small local fallback that enters a deliberately reduced capability mode;
- a separate vision/perception route for screenshots and GUI work;
- deterministic tools and policy gates that—not the personality or the model—own authority;
- phone access over the already-installed Tailscale network, with the app itself listening only on localhost;
- DeepSeek Harness used behind a boundary as an execution engine, not allowed to become Friday’s database or irreplaceable product core.

A useful personal alpha is realistic. A reliable “take care of this” agent operating real accounts and arbitrary desktop applications is a longer safety/reliability program, not a normal app feature.

## Laptop audit

### What is present

| Area | Observed state | Consequence for Friday |
|---|---|---|
| Laptop | HP Victus 15-fa2xxx | Adequate thermals for bursts; unattended 24/7 use still needs power/heat planning. |
| CPU | Intel Core i5-13420H, 8 cores / 12 threads, up to 4.6 GHz | Strong enough for orchestration, databases, indexing, browser automation, local STT/TTS, and modest CPU inference. |
| RAM | About 15 GiB usable (a 16 GB-class configuration), 4 GiB swap | The main local constraint. Enough for the control plane plus one small quantized model, but not several heavy models/services concurrently. A 32 GB upgrade would materially improve local inference, browser concurrency, and development. |
| GPU | RTX 3050 Laptop GPU, 6 GiB VRAM, 50 W | Good for 3–4B Q4-class LLM/VLM inference, embeddings, and Whisper. Some 7–8B quants may run with CPU/RAM offload but with reduced context and speed. |
| NVIDIA software | Driver 595.84; CUDA driver API reports 13.2 | GPU is usable, but CUDA toolkit and NVIDIA Container Toolkit were not detected. Native llama.cpp or a properly installed runtime is simpler initially. |
| Storage | 512 GB NVMe, about 247 GB free | Plenty for the app and several small models. Screenshots, browser profiles, research artifacts, model caches, and logs need quotas/retention. |
| OS | Ubuntu 26.04 LTS, kernel 7.0 | Modern Linux baseline. Newness may cause temporary ML/package compatibility gaps. |
| Desktop | GNOME 50 on Wayland, 1920×1080 at 144 Hz | Excellent daily desktop; awkward for unrestricted mouse/keyboard injection and global overlay pets. This is the hardest machine-specific constraint. |
| Runtimes | Node 22.22, npm, pnpm 8.15, Python 3.14.4, Docker 29 | Node satisfies DeepSeek Harness’s current Node requirement. Its source tree asks for pnpm 11. Python 3.14 is too new for some ML packages, so use a pinned Python 3.12/3.13 environment or containers. Rust/Tauri tooling was not installed. |
| Networking | Tailscale 1.102 active; Wi-Fi 6 and Gigabit Ethernet | The safest first phone-access path is already available. No public tunnel is required. |
| Battery | About 90.7% of design capacity | Healthy. For always-on operation, use AC power, ventilation, and an appropriate charge limit rather than keeping a hot laptop at 100%. |

### Security findings to address before autonomy

1. The root filesystem appears to be a plain ext4 partition rather than full-disk encrypted. Local-first memory is not private if the laptop is lost. Enable full-disk encryption during a planned reinstall or use a separately encrypted Friday data volume now.
2. Secure Boot is disabled. This is not automatically fatal, but it weakens the boot trust chain for a machine that may hold broad credentials.
3. An existing PostgreSQL 16 Docker container publishes port `55432` on `0.0.0.0` and IPv6, not merely localhost. Firewall reachability was not proven, but this binding should be reviewed and normally changed to `127.0.0.1:55432:5432` unless LAN exposure is intentional.
4. No NVIDIA container runtime was detected. Do not assume `docker run --gpus all` works yet.
5. The system reports one failed crash-reporting unit. It is unrelated to Friday and not a capacity blocker.

### Sensible hardware changes

**Potentially high-value, but verify before buying:** 32 GB RAM would benefit Chrome, Docker, local inference, indexing, and development simultaneously. However, HP’s service guide for the broad `15-fa2xxx` family says there are two memory slots but lists support “up to 16 GB”; the exact SKU/board and BIOS therefore need confirmation before assuming a 32 GB kit is supported. If this specific unit is capped at 16 GB, keep the present RAM and control service/model concurrency instead.

**Optional:** a 1 TB NVMe upgrade later if research artifacts, checkpoints, or recordings grow. Current free space is adequate for an alpha.

**Not justified initially:** a new GPU/laptop solely for Edge0. Validate the product first. If truly local high-quality reasoning becomes a priority, a desktop with 16–24+ GB VRAM or an Apple Silicon machine with large unified memory changes the local-model ceiling far more than a minor laptop upgrade.

## Corrections to the original assumptions

### 1. Nemotron 3 Ultra can be the reasoning brain, not the entire brain

NVIDIA’s model card describes Nemotron 3 Ultra as a 550B-total/55B-active text model with up to 1M context, tool use, and an OpenAI-compatible hosted endpoint. Its self-hosted minimum starts at multiple data-center GPUs, so API use is the correct choice on this machine. It is explicitly **text input**, however. It cannot see the desktop.

Use at least these model roles:

| Role | Initial route |
|---|---|
| Complex planning, synthesis, coding/research judgment | Nemotron 3 Ultra API |
| Screenshot/UI perception | A multimodal VLM API, potentially NVIDIA Nemotron 3 Nano Omni; accessibility/DOM data first |
| Offline routing, classification, simple chat, summaries | Local Qwen3.5-4B/Phi-4-mini-class candidate after benchmarks |
| Embeddings | Small local embedding model |
| Speech recognition | Local faster-whisper |
| Speech synthesis | Local Kokoro-class TTS; evaluate voice/licensing |

NVIDIA documents Nemotron 3 Nano Omni as accepting image, video, audio, and text and specifically supporting GUI/OCR and tool calling. It is a logical NVIDIA-family perception candidate, though it also requires a hosted route or much larger hardware than this laptop.

### 2. The NVIDIA hosted API is not an indefinite free production dependency

NVIDIA offers the Ultra endpoint for prototyping, and its API Trial Terms say trial access is limited, non-production, may be rate-limited, and can end. Friday therefore needs:

- a provider-health circuit breaker;
- a second remote provider route for real continuity;
- per-task cost/token ceilings;
- a privacy label that prevents sensitive context from leaving the laptop unless permitted;
- an explicit migration test suite for model/provider changes.

“Local fallback” and “provider fallback” are different requirements. A tiny local model preserves basic function during an outage. A second capable remote provider preserves difficult work.

### 3. Edge0 is not a candidate on this laptop today

The current Edge0 repository supports Apple Silicon through MLX. CUDA is only a reserved/roadmap backend. Its attractive 1.0/2.9 GiB active-memory figures were measured on an M4 Pro and do not establish RTX 3050 performance. Keep an automated quarterly compatibility check, but remove Edge0 from the initial implementation path.

Benchmark current practical candidates instead. Qwen3.5-4B is Apache-2.0, multimodal, and sized appropriately for a 6 GB GPU in a Q4-class quantization. Phi-4-mini-instruct is another small, function-calling-capable baseline. The winner should be selected by Friday-specific tests, not general leaderboards.

### 4. DeepSeek Harness is promising but pre-stable

DeepSeek Harness now genuinely provides the seams the brief expects: plugin composition, model adapters, sessions, guarded tools, subagents, background jobs, sandboxing, skills, web UI, SQLite/JSONL persistence, and schedules. It is MIT-licensed and a strong prototype foundation.

Its own README calls it a rapidly changing developer preview with compatibility-breaking changes, and its safety notice says it is unaudited and not production-ready. Its local sandbox governs filesystem effects; the documentation explicitly says network and process visibility are outside that sandbox vocabulary. Its built-in background-job registry is process-local, and its schedule feature requires the original session to be live and provides no external push notification.

Therefore:

- pin an exact DSH version/commit;
- put all DSH integration behind a `HarnessAdapter`;
- keep Friday’s projects, tasks, memory, policy, notifications, and durable jobs in Friday-owned storage;
- use DSH sessions as execution transcripts, not as the product’s only state;
- maintain contract tests that run against every proposed DSH upgrade;
- prefer plugins/adapters and small upstream contributions over a large fork.

### 5. Full GUI control is not simply “add computer-use MCP”

On this GNOME Wayland laptop, applications cannot freely inspect or synthesize global input the way old X11 tools did. Privileged `/dev/uinput` daemons and X11 sessions can bypass some restrictions but enlarge the attack surface. Tauri exposes transparent and always-on-top options, but current upstream issues show that always-on-top remains unreliable on GNOME/Wayland.

The safe capability order is:

1. direct API or dedicated MCP tool;
2. filesystem/CLI integration;
3. Playwright DOM automation in an isolated browser profile;
4. accessibility tree (AT-SPI) automation;
5. screenshot + VLM perception;
6. raw coordinates/keyboard only as a last resort.

This order is both more reliable and safer than treating the screen as pixels for every action.

### 6. WhatsApp Web is a poor flagship acceptance test

The workflow is technically possible with browser automation, but it is brittle, high-impact, and potentially contrary to WhatsApp’s restrictions on impermissible auto-messaging/automated access. It can also send a private document to the wrong similarly named contact.

If retained as an experimental personal workflow, require all of the following:

- dedicated browser profile with manual login;
- exact recipient identifier, not fuzzy name-only matching;
- preview of recipient, filename, size, and optional document hash;
- confirmation immediately before clicking Send;
- post-send screenshot/receipt;
- low rate limits and no inbox scraping;
- immediate stop/kill control from the phone.

Do not make unattended WhatsApp sending an MVP success criterion.

## Recommended architecture

```text
Laptop UI / Phone PWA / Voice / Pet
                 │
                 ▼
        Friday API + realtime gateway
        (localhost; Tailscale Serve)
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
Identity & context      Durable task engine
projects/current task   leases/retry/resume
       │                    │
       └─────────┬──────────┘
                 ▼
       Policy + capability broker
 permission, risk, privacy, approvals,
 budget, idempotency, scoped credentials
                 │
       ┌─────────┼───────────┐
       ▼         ▼           ▼
 Model router  DSH adapter  Tool/MCP gateway
   │             │           │
   ├ Ultra       ├ agents    ├ browser
   ├ VLM         ├ sessions  ├ filesystem
   ├ local       ├ tools     ├ coding
   └ embeddings  └ subagents └ integrations
                 │
                 ▼
     Event log + SQLite + artifact store
                 │
                 ▼
         Audit / metrics / pet events
```

### Boundaries that matter

**Friday Core owns:** identity, current-task resolution, projects, tasks, durable job state, memory, permission grants, consent, model policy, notifications, and product API.

**DSH owns:** one execution loop, session transcript, tool invocation mechanics, subagent execution, and scoped runtime plugins.

**Tool adapters own:** secrets and external API sessions. A model receives opaque handles and structured results, never raw tokens when avoidable.

**The pet owns nothing sensitive:** it subscribes to a read-only event stream such as `thinking`, `researching`, `waiting`, or `success`. It must never infer authority from animation state.

## Technology choices

### Backend language

Because DSH is Node/TypeScript, use TypeScript for the Friday control plane and plugin/BFF layer. Use Python sidecars only for workloads where its ecosystem is materially better—speech, embeddings, OCR, or model evaluation. Starting with a separate FastAPI product backend would create two orchestration centers and more failure modes.

### Database

Start with **SQLite in WAL mode**, not PostgreSQL:

- one user and one laptop do not need a database server;
- DSH already ships a SQLite session persistence provider;
- backup/restore is simple;
- fewer always-on processes and credentials;
- FTS5 handles exact/lexical recall well.

Keep schema/repository interfaces clean so PostgreSQL can replace it when multi-user access, heavy concurrency, or server deployment actually appears. Do not introduce pgvector merely because memory exists. Begin with FTS plus a small local embedding index; measure recall, latency, and storage before choosing a vector engine.

### Durable work

Do not equate a background subprocess with a durable task. Implement a Friday-owned job table with:

- status and attempt number;
- lease owner and lease expiry;
- heartbeat/progress;
- idempotency key;
- input snapshot and artifact references;
- cancellation token;
- retry policy and maximum cost;
- checkpoint/resume cursor;
- approval-wait state;
- final result/diagnostic.

A `systemd --user` service can run the API and worker for the personal alpha. Jobs must recover after process restart. Later, move to a heavier workflow engine only if the simple lease model becomes inadequate.

### Frontend and phone

Build one React/Vite responsive PWA first. It should provide chat, current task, approvals, activity, artifacts, stop button, and notifications. Server-side rendering/Next.js adds little to a private local app.

Expose only `127.0.0.1` and proxy it using **Tailscale Serve**, which provides tailnet-only HTTPS and respects access policies. Do not use Funnel. Validate Tailscale identity headers only when the backend is unreachable directly, and still add an app-level passkey/PIN for consequential actions.

### Browser

Use Playwright as the deterministic base. Give Friday separate browser profiles such as research and personal-actions. Playwright warns that stored authentication state can impersonate the user; keep state encrypted/permission-restricted and out of repositories.

Use `browser-use` only if comparative evaluations show it adds value over DSH + Playwright. Avoid attaching Chrome DevTools to the everyday profile. Run a dedicated Chrome instance and bind its debugging port to localhost only.

### Desktop pet

Build the pet in two stages:

1. a pet inside the web dashboard, driven by the same event schema—low risk and portable;
2. an optional native overlay experiment.

For the overlay, compare Tauri/XWayland with a Linux-native GTK/layer-shell implementation. Do not assume a transparent Tauri window will roam reliably on GNOME Wayland. `Imzl-zl/desktop-pet` is MIT-licensed and shows a useful event/pack pattern, but it is a very small project; treat it as reference code and review asset licenses separately.

### UI reuse

Use DSH’s web UI as an early diagnostic/prototype surface, then build Friday’s focused interface against the Friday API. Borrow design ideas, not an entire chat product. Current Open WebUI releases include branding restrictions and are not OSI-approved according to its own documentation; current LobeChat licensing also adds conditions. Either creates avoidable product/licensing coupling for a strongly branded Friday UI.

## Model routing and fallback behavior

Do not expose a generic `ai.chat()` abstraction that erases model capabilities. Route a structured request:

```ts
type ModelRequest = {
  purpose: 'plan' | 'act' | 'summarize' | 'classify' | 'perceive' | 'embed'
  sensitivity: 'public' | 'personal' | 'confidential' | 'secret'
  modalities: Array<'text' | 'image' | 'audio'>
  required: { tools?: boolean; jsonSchema?: boolean; minContext?: number }
  budget: { maxTokens: number; maxCost?: number; deadlineMs: number }
}
```

The router should consider provider health, privacy, modality, measured task quality, latency, and cost. Preserve vendor-specific options through typed extensions instead of pretending every OpenAI-compatible endpoint behaves identically. DSH already documents compatibility switches for custom gateways; Nemotron should be tested for system/developer role, streaming tool-call IDs, reasoning fields, cancellation, and error behavior before use.

When Ultra is unavailable:

- ordinary chat/classification/summaries may fall back locally;
- read-only file lookup may continue;
- high-impact external actions should pause or require explicit confirmation;
- complex coding/research should queue, use the second capable provider, or clearly report degraded quality;
- never silently give a 4B model the same autonomy as Ultra.

### Local fallback evaluation

Benchmark at least Qwen3.5-4B Q4, Phi-4-mini-instruct Q4, and one other current small model through the same OpenAI-compatible local server. Use Friday-specific cases:

- valid tool selection and exact JSON arguments;
- refusal to invent tool success;
- permission/risk classification;
- summarizing a long task state;
- choosing not to act when uncertain;
- basic code/file operations;
- latency, VRAM, RAM, thermal behavior, and context growth.

Qwen3.5-4B’s multimodality makes it especially worth testing as an offline screen describer, but visual grounding accuracy must be measured before clicks are derived from it.

## Memory that will not become a privacy or hallucination mess

The proposed categories are useful, but “remember everything important” needs a consent and provenance model.

Every memory should contain:

```text
id, type, content, source, source_time, created_at,
scope (global/project/task), confidence, sensitivity,
consent (explicit/proposed/derived), ttl, last_used,
supersedes, contradiction_group, embedding_version
```

Use a write pipeline:

1. event occurs;
2. candidate memory is extracted;
3. deterministic filters reject secrets/transient tool output;
4. high-sensitivity memories require explicit approval;
5. deduplicate or create a contradiction/supersession link;
6. store text, provenance, and embedding;
7. later retrieval records why the item was selected.

Use a retrieval pipeline combining current task/project, permissions, lexical search, semantic search, recency, confidence, and sensitivity. The context builder should return a small evidence bundle, not the database. Display “Why Friday remembers this,” provide Edit/Forget controls, and ensure deletion removes raw text, index rows, embeddings, caches, and derived summaries.

Keep “identity” separate from memory. One Friday means a stable assistant instance and shared control-plane state; sessions are still separate execution histories. The phrase “that research” should resolve using the active task/project and recent task graph, with a clarification when two candidates are plausible.

## Security and permission architecture

The central threat is **indirect prompt injection**: a webpage, email, PDF, repository issue, or subagent output tells the model to misuse a legitimate tool. NIST describes current agents as vulnerable to this type of hijacking; OWASP calls the combination of excessive functionality, permissions, and autonomy “excessive agency.”

Implement these controls before broad autonomy:

1. **Capability grants, not global levels alone.** A task receives narrow grants such as `files.read(project-X)`, `browser.navigate(research-profile)`, or `message.draft(contact-123)`, each with expiry and rate limits.
2. **Separate data-reading from action-taking.** A research/browser worker reading untrusted content should not also hold message-send, credential, or filesystem-write authority.
3. **Approval at the sink.** Confirm the final concrete action—recipient, file, amount, command—not an abstract plan made ten steps earlier.
4. **Two-phase tools.** `prepare_send` returns a preview and action token; `commit_send` requires a valid token and policy/confirmation.
5. **Typed tools.** Avoid generic shell/browser tools when a narrow operation is possible.
6. **Scoped credentials.** OAuth scopes and service accounts should be read-only by default. MCP authorization is not a substitute for task-level policy.
7. **Plugin supply-chain controls.** Review source, pin version and integrity hash, lock tool schemas, restrict environment variables and egress, and maintain an installed-tool inventory.
8. **Immutable audit.** Record intent, model, policy decision, tool arguments with secret redaction, result hash, screenshots for GUI actions, and approval identity/time.
9. **Kill paths.** Global pause, per-task cancel, revoke-all-integrations, model-offline switch, and phone-visible emergency stop.
10. **Backups and restore drills.** Versioned encrypted backups for state, with browser auth and secrets backed up separately or deliberately excluded.

MCP is a tool transport, not a security boundary. Dynamically discovering every installed tool and exposing it to every model turn increases both prompt cost and attack surface. Select tools per task and per agent.

## Research, subagents, and skills

The `hec-ovi/research-skill` now has a thoughtful decompose/gather/validate/contrarian/store workflow and Codex compatibility, but it is young. Adapt its workflow and output schema; do not make Friday’s research database depend on a single SKILL.md implementation.

SerpApi has an official open-source MCP server and is reasonable as one search provider. Research still needs direct-page retrieval, primary-source preference, source timestamps, claim-to-source mapping, contradictions, and evidence snapshots. Search snippets are leads, not evidence.

Subagents should be bounded jobs with inherited *minimum* authority. For this laptop/account, begin with a concurrency limit of two or three. The main agent should receive compact structured findings rather than every child transcript. A subagent result is untrusted data until validated; it must not be able to transfer its tool authority through prose.

## Voice

Voice is feasible locally, but it should follow the core interaction loop rather than delay it.

- Push-to-talk first; wake-word later after false-activation testing.
- `faster-whisper` can use INT8 GPU inference with substantially less VRAM than full precision and fits this GPU class.
- Kokoro is a compact Apache-2.0 TTS candidate; evaluate latency, voice license, pronunciation, and streaming quality.
- A spoken command that triggers a consequential action still requires a visual/voice confirmation containing concrete details.
- Never keep continuous raw microphone recordings by default. Store transcripts only under explicit retention rules.

## What the first product should actually contain

### Phase 0 — risk-reduction spikes (1–2 weeks)

No polished UI. Prove or reject the foundations:

- run pinned DSH in a disposable workspace;
- connect Nemotron through a custom OpenAI-compatible route and test streaming tools/reasoning/cancellation;
- benchmark 2–3 local models on the RTX 3050;
- validate DSH sandbox enforcement on this kernel;
- test Playwright with an isolated Chrome profile;
- prototype one accessibility/vision loop on GNOME Wayland;
- validate Tailscale Serve from the phone;
- test suspend, restart, and crash recovery assumptions.

**Exit gate:** a written compatibility matrix and no unresolved secret/network exposure.

### Phase 1 — useful personal alpha (3–6 weeks after Phase 0)

- one Friday identity with projects, tasks, and resumable conversations;
- PWA for laptop and phone;
- model router with Ultra + local degraded mode;
- explicit memory with provenance/Edit/Forget;
- isolated coding workspaces and git diff/test workflow;
- read-only research/browser tools;
- audit timeline and kill switch;
- Tailscale-only remote access;
- simple pet inside the dashboard.

**Not included:** arbitrary desktop control, unattended messages, wake word, CRM, email sending, or autonomous production changes.

### Phase 2 — durable work and controlled actions (4–8 weeks)

- durable job queue with restart recovery;
- research projects and artifact reports;
- notifications to the PWA/phone;
- browser write actions with two-phase confirmation;
- GitHub integration with least-privilege scopes;
- local push-to-talk STT/TTS;
- subagents with budgets and concurrency limits;
- evaluation dashboard and replay.

### Phase 3 — computer-use laboratory

- AT-SPI semantic automation;
- screenshot perception via a VLM;
- action verification and replayable trajectories;
- a dedicated browser/desktop profile;
- raw input only where semantic paths fail;
- pet overlay experiment after Wayland tests.

Keep this labeled experimental until a task suite demonstrates reliability and prompt-injection resistance.

### Phase 4 — integrations and proactivity

Email/calendar/CRM, scheduled workflows, and proactive recommendations should arrive only after the permission, notification, and audit systems are mature. Prefer official APIs to GUI automation.

## Feasibility by feature

| Feature | On this laptop | Recommendation |
|---|---|---|
| Persistent chat/identity | Strong | Build early. |
| Local memory/research store | Strong | SQLite + FTS + measured embeddings. |
| Coding agent | Strong | Isolated git workspaces; DSH useful. |
| Multi-source research | Strong | Remote model + browser/search; durable evidence store. |
| Phone control | Strong | PWA + Tailscale Serve; laptop must be awake. |
| Background headless work | Strong | Durable Friday worker; survives app closure/restart. |
| Local offline assistant | Moderate | Small model, explicitly reduced autonomy. |
| Voice | Strong | Local STT/TTS after core. |
| Browser automation | Strong | Playwright first, dedicated profiles. |
| Arbitrary GUI automation | Experimental | Wayland + perception/reliability/security challenge. |
| Dashboard pet | Strong | Easy, low-risk early delight. |
| Roaming desktop pet | Moderate | Prototype platform-specific overlay; Wayland caveats. |
| Unattended WhatsApp sending | Poor MVP choice | Terms/reliability/privacy risk; confirm every send if tested. |
| “High autonomy” on personal account | Unsafe initially | Earn capability through measured, scoped workflows. |

## Evaluation plan

Friday should not graduate based on demos. Maintain versioned task suites:

- 30 tool-selection/schema cases;
- 20 memory retrieval/contradiction/deletion cases;
- 20 coding tasks in disposable repositories;
- 20 browser tasks across known test sites;
- 15 prompt-injection cases from pages/documents/tool output;
- 10 crash/restart/cancel/idempotency cases;
- 10 phone approval/identity/CSRF cases;
- GUI cases with expected screenshots and semantic states.

Track task success, unsafe-attempt rate, false success claims, intervention count, latency, tokens/cost, and recoverability. A model/provider upgrade is a deployment change and must rerun the suite.

## Recommended next decision

Do **not** start with the dashboard, pet art, PostgreSQL schema, or arbitrary GUI controller. Start with a short architecture-validation milestone whose deliverable is a runnable but disposable lab proving:

1. DSH ↔ Nemotron protocol compatibility;
2. the best local fallback on this exact GPU;
3. durable restartable tasks outside DSH;
4. safe Tailscale phone access;
5. whether GNOME Wayland permits an acceptable semantic/vision computer-use path without privileged global input.

If those five work, the vision is worth building. If the Wayland spike fails, Friday remains highly useful through browser/API/CLI tools while desktop control moves to a dedicated X11/virtual session or a different host architecture.

## Primary sources consulted

- [NVIDIA Nemotron 3 Ultra model card and hardware/API details](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b)
- [NVIDIA Ultra hosted endpoint example](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b)
- [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)
- [NVIDIA NIM FAQ and production licensing](https://docs.api.nvidia.com/nim/docs/product)
- [NVIDIA Nemotron 3 Nano Omni multimodal model card](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning)
- [DeepSeek Harness repository, preview status, and MIT license](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [DeepSeek Harness process sandbox limitations](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox)
- [DeepSeek Harness provider configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)
- [DeepSeek Harness session persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md)
- [DeepSeek Harness durable schedules and limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/schedule.md)
- [DeepSeek Harness background job tools](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/jobs/tool-jobs/README.md)
- [Edge0 repository and current Apple-Silicon-only requirement](https://github.com/Edge0-AI/Edge0)
- [Qwen3.5-4B model card](https://huggingface.co/Qwen/Qwen3.5-4B)
- [Phi-4-mini-instruct function-calling model card](https://huggingface.co/microsoft/Phi-4-mini-instruct)
- [Playwright browser contexts](https://playwright.dev/docs/browser-contexts)
- [Playwright warning about stored authentication state](https://playwright.dev/docs/auth)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tauri window configuration](https://v2.tauri.app/reference/config/)
- [Tauri GNOME/Wayland always-on-top issue](https://github.com/tauri-apps/tauri/issues/13121)
- [SerpApi MCP server](https://serpapi.com/blog/introducing-serpapis-mcp-server/)
- [MCP authorization guidance](https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html)
- [NIST on indirect prompt-injection/agent hijacking](https://www.nist.gov/blogs/caisi-research-blog/insights-ai-agent-security-large-scale-red-teaming-competition)
- [OWASP on excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
- [faster-whisper benchmarks](https://github.com/SYSTRAN/faster-whisper)
- [Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M)
- [WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service)
- [Open WebUI current license](https://github.com/open-webui/open-webui/blob/main/LICENSE)
- [DesktopPet reference implementation](https://github.com/Imzl-zl/desktop-pet)
- [HP Victus 15-fa2xxx Maintenance and Service Guide](https://kaas.hpcloud.hp.com/pdf-public/pdf_11551870_en-US-1.pdf)
