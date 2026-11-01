<div align="center">

<img src="docs/assets/banner.svg" alt="Friday — a persistent personal AI on your own server" width="100%">

<br>

**Friday is a self-hosted, always-on AI assistant with real hands and real brakes.**<br>
She remembers you, works in the background, drives your laptop's browser, and asks before anything irreversible.

<br>

[![CI](https://github.com/atharvb7/friday/actions/workflows/ci.yml/badge.svg)](https://github.com/atharvb7/friday/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-3ddc97?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/server%20deps-zero-7c6cff)
![Tests](https://img.shields.io/badge/tests-315%20passing-3ddc97)
![Brain bench](https://img.shields.io/badge/brain%20bench-38%2F39-22d3ee)
![Docker](https://img.shields.io/badge/deploy-docker%20compose-2496ED?logo=docker&logoColor=white)
![Self-hosted](https://img.shields.io/badge/self--hosted-6%20GB%20RAM%2C%20no%20GPU-232a3b)

[**Why Friday**](#why-friday) · [**Features**](#what-she-can-do) · [**Architecture**](#architecture) · [**Safety**](#safety-model) · [**Quick start**](#quick-start) · [**Deploy**](#deploy-to-a-server) · [**Status**](#honest-status)

</div>

---

## Why Friday

Most assistants are a chat box that forgets you when the tab closes. Friday is the opposite: **one assistant that
lives on a server you own and reaches you wherever you are** — the web, your phone, a push-to-talk key on your
laptop, a desktop pet, a desk companion.

```text
You  ▸ remind me to call the dentist tomorrow at 10, and find me three freight forwarders in Pune with bad websites
Friday ▸ Reminder set for 10:00 tomorrow.
         Research is running in the background — I'll drop the shortlist here when it's done.
         ⋯ 4 min later ⋯
         Done: 3 companies, each with the page that shows the problem. Want me to draft outreach? (needs your OK)
```

What makes it different:

| | |
|---|---|
| 🧠 **Persistent** | One identity, one memory, one task system. Hybrid keyword + vector memory, goals, to-dos and research that survive restarts and follow you across devices. |
| 🤲 **Real hands** | Sandboxed research/coding agents, a **laptop node** that drives your real, logged-in Chrome and desktop apps, Gmail, Instagram, documents, images, reels. |
| 🛑 **Real brakes** | Per-category autonomy tiers, exact-payload approvals, TOTP for phone approvals, an emergency stop, and a hash-chained audit log. **Personality never grants privileges.** |
| ⏰ **Always on** | Reminders, recurring jobs, watches, proactive nudges and a morning briefing — with quiet hours, away days and a daily cap so she never nags. |
| 🪶 **Lean** | Zero-dependency Node 22 server (built-in SQLite, no `npm install`). Core idles at ~80 MiB and fits on a 6 GB, GPU-less box. |

---

## What she can do

<table>
<tr>
<td width="50%" valign="top">

### 🧠 Brain
- **Model router** with per-role chains (`chat`, `execute`, `reason`, `plan`, `vision`, `embed`), circuit breakers,
  daily-quota awareness and a call log with latency + tokens
- Nemotron 3.5 Super for everyday turns, Ultra / Gemini Flash for deep reasoning, any OpenAI-compatible fallback
- **Tool loading**: each turn gets only the tool groups it needs (~12k → a fraction of the tokens)
- Streaming tool-calling loop with step budgets and a "stop retrying the same call" guard
- Personality sliders + mood — **style only**, never permissions

</td>
<td width="50%" valign="top">

### 📚 Memory & knowledge
- Hybrid memory: SQLite FTS + `nemotron-3-embed-1b` vectors, fused with RRF
- **Auto-memory**: durable facts and preferences extracted after each exchange (editable, deletable)
- Research memory: sources with dates, claims with confidence, **contradiction flags**
- Goals with a rolling digest, commitments as first-class to-dos
- **Suggestions ledger**: every recommendation is filed with evidence and scored later — worked / mixed / failed

</td>
</tr>
<tr>
<td valign="top">

### 🤖 Agents
- **DSH agents** for research and coding in a bubblewrap / container sandbox, behind a filtering egress proxy
- **Team tasks**: a big goal split into parallel subtasks across runtimes, merged into one report
- **Hermes Agent** as a delegated runtime, with its approvals bridged into Friday's
- **Self-learning playbooks**: successful runs become `SKILL.md` hints for next time
- 35 skills (research, coding, sales, writing), third-party ones pinned and reviewed — see [`skills/`](skills)

</td>
<td valign="top">

### 💻 Laptop node (computer use)
- Dials **out** to the server — the server never reaches into your laptop
- Drives your real Chrome with **DOM refs**, not guessed coordinates
- Whole-desktop control via AT-SPI accessibility (works on Wayland): open apps, read and press controls
- Personal details are **placeholders** (`{{profile.phone}}`) filled at type-time; the model never sees them
- A self-guard stops the agent from ever operating Friday's own approval page

</td>
</tr>
<tr>
<td valign="top">

### ⏰ Always on
- Reminders + recurring jobs (daily / weekdays / weekly / monthly), timezone- and DST-correct, never double-fire
- **Watches**: "keep an eye on X and tell me when Z"
- Proactive loop: morning briefing, stuck tasks, brain down, low disk — with quiet hours and a daily cap
- **"Your turn" board**: one list of everything waiting on you (decide / answer / check / do)
- **Away days**: hold back briefings, nudges and outreach while you're away
- Health for every background loop, spend tracking per provider

</td>
<td valign="top">

### 💼 Business mind
- **Prospector**: a 24/7 pipeline — source → audit the company's own site → keep only on-page evidence → qualify → draft
- Built-in CRM: leads, history, a do-not-contact list, a business profile every sales skill reads first
- Jurisdiction-aware cold email rules (UK/EU, DE/AT, …) and opt-out footers
- Outreach from a **separate inbox**, one approval per batch, replies watched
- Typed sales judgments via JEV, with deterministic fallbacks

</td>
</tr>
<tr>
<td valign="top">

### 🔌 Apps & content
- **Gmail** via your own Google OAuth client (refresh token never reaches the model, UI or logs)
- **Instagram** through Composio — reads free, anything public or social needs approval, unknown actions refused
- **WhatsApp / Instagram DM sessions** for a bounded time, on your say-so
- **Documents**: create / read / edit Word, Excel, PowerPoint, PDF, Markdown — every edit is a new version
- **Images** (FLUX on NVIDIA) and an automated **reel** pipeline

</td>
<td valign="top">

### 🗣️ Bodies & voice
- **Web dashboard + phone PWA** (no build step): streaming chat, inbox, tasks with traces, memory, settings
- **Voice**: Whisper for listening, Kokoro for speaking, on-demand worker that unloads when idle
- **Push-to-talk** from any laptop app, with screen-aware questions ("what does this error mean?")
- Web Push, SSE live state, a derived **companion state** shared by every body
- Desktop pet (Tauri) and ESP32-S3 desk companion scaffolds

</td>
</tr>
</table>

---

## Architecture

```mermaid
flowchart LR
  subgraph clients["Where you talk to her"]
    web["🌐 Web dashboard"]
    pwa["📱 Phone PWA"]
    ptt["🎙️ Push-to-talk"]
    pet["🐾 Desk / pet"]
  end

  subgraph server["Your server · Docker compose"]
    direction TB
    core["<b>friday</b> core<br/>API · brain · memory · scheduler · voice"]
    db[("SQLite<br/>one data dir")]
    agent["<b>agent</b><br/>sandboxed DSH runner<br/>no inbound, no data"]
    proxy["<b>proxy</b><br/>egress filter"]
    deployer["<b>deployer</b><br/>Friday's own apps"]
    core --- db
    core -- "jobs" --> agent
    agent -- "only way out" --> proxy
    core -. "optional" .-> deployer
  end

  subgraph laptop["Your laptop"]
    node["🖥️ <b>laptop node</b><br/>real Chrome · desktop · voice"]
  end

  models["☁️ Model providers<br/>NVIDIA · Gemini · any OpenAI-compatible"]

  clients -- "HTTPS · tailnet" --> core
  node -- "dials out (SSE + HTTP)" --> core
  core -- "router · circuit breakers" --> models
  proxy --> internet(("🌍 Internet"))
```

**Design rules the code sticks to**

- **One composition root.** Every service is built once in [`src/context.mjs`](src/context.mjs); routes and tools receive what they need.
- **Outbound only.** The laptop node and the agent container connect *out*. Nothing reaches into your laptop; the agent can't reach your LAN, tailnet or cloud metadata.
- **Data in one place.** DB, tokens, agent homes and workspaces live under `FRIDAY_DATA_DIR`. Moving machines is `friday backup` → copy → `friday restore`.
- **Least privilege at the edges.** Containers run read-only with all capabilities dropped and hard memory / pid limits; the core is published on `127.0.0.1` only.

---

## Safety model

Friday is built to be trusted with your accounts, so the brakes are in code, not in the prompt.

| Layer | What it does |
|---|---|
| **Autonomy tiers** | Per category (`ask` · `trusted` · `autonomous` · `high`). Money, deletion, messaging other people and security ask first by default. `high` is time-boxed (≤ 12 h) and revoked by the emergency stop. |
| **Exact-payload approvals** | You approve *this exact* email / post / click. The payload is hashed; a tampered or replayed approval fails. Execute-once, 24 h expiry. |
| **Effect ledger** | Every external side effect moves through a state machine with a commit deadline, so a crash mid-action shows up as *unknown* for you to check — never silently retried. |
| **TOTP on devices** | Approving from a phone or another device needs an authenticator code. Device tokens are scoped, hashed and revocable. |
| **Emergency stop** | One button (or "stop everything") cancels running work and drops elevated autonomy. |
| **Audit chain** | Append-only, SHA-256 hash-chained log of everything that happened. Never pruned. |
| **Sandboxing** | Agents see only their workspace; the data dir, `.env` and your home are hidden. Egress goes through a proxy that blocks private, LAN, tailnet and metadata addresses. SSRF-safe `web_fetch`. |
| **Resource governor** | A hard memory budget gates admission of new work, so the box never swaps itself to death. |
| **Members are isolated** | Other people can request an account; once you approve, they get their own chats and **no** access to your laptop, mail, memory, tasks or settings. |

<details>
<summary><b>Life of an approved action</b></summary>

```mermaid
stateDiagram-v2
  direction LR
  [*] --> proposed
  proposed --> staged
  staged --> awaiting_approval: you're asked
  awaiting_approval --> approved: you approve (hash-bound)
  awaiting_approval --> expired: 24 h pass
  approved --> committing: within commit deadline
  approved --> expired: deadline missed
  committing --> verified_success
  committing --> verified_failure
  committing --> effect_unknown: crash / restart
  effect_unknown --> verified_success: checked
  effect_unknown --> verified_failure: checked
```

</details>

Independent reviews live in [`docs/security-audit-2026-10-10.md`](docs/security-audit-2026-10-10.md) and
[`docs/review-2026-10-28.md`](docs/review-2026-10-28.md), including the items that are still open.

---

## Quick start

> [!NOTE]
> Requires **Node ≥ 22.13** (the server has no npm dependencies), `bubblewrap` for local agents, and Google Chrome
> only on the machine running the laptop node.

```bash
git clone https://github.com/atharvb7/friday.git && cd friday
cp .env.example .env && chmod 600 .env       # add FRIDAY_NVIDIA_API_KEY (and optional keys below)
node bin/friday.mjs doctor                   # checks everything and tells you what's missing
node bin/friday.mjs start                    # → http://127.0.0.1:4317  (token in data/access-token)
```

Open `http://127.0.0.1:4317`, paste the token, and say hi.

<details>
<summary><b>Everyday CLI</b></summary>

```bash
node bin/friday.mjs status | logs -f | stop | restart
node bin/friday.mjs device add phone read,chat,tasks,approve   # prints a scoped device token once
node bin/friday.mjs totp                                       # set up the authenticator for device approvals
node bin/friday.mjs voice setup                                # install Whisper + Kokoro
node bin/friday.mjs backup [dir] | restore <file.tgz>          # secrets excluded unless --with-secrets
```

</details>

<details>
<summary><b>Connect your phone</b></summary>

Put Friday behind Tailscale HTTPS (tailnet-only), open the URL on your phone and install the PWA:

```bash
tailscale serve --https=443 http://127.0.0.1:4317
```

See [`docs/tailscale-runbook.md`](docs/tailscale-runbook.md).

</details>

<details>
<summary><b>Pair your laptop (computer use)</b></summary>

```bash
node bin/friday.mjs device add laptop read,node                    # on the server: prints a token once
cd node && npm install                                             # on the laptop: playwright-core only
FRIDAY_NODE_TOKEN=fdv_... node friday-node.mjs pair --server https://<friday-host> --name laptop
node friday-node.mjs run
```

Full guide, permissions and the push-to-talk key: [`node/README.md`](node/README.md).

</details>

---

## Deploy to a server

Friday ships as a hardened Docker compose stack sized for a **6 GB RAM, no-GPU** Linux box:

| Container | Role | Limits |
|---|---|---|
| `friday` | core: API, UI, brain, scheduler, voice | 2.5 GB · read-only · `127.0.0.1` only |
| `agent` | sandboxed DSH runner — no inbound, no Friday data | 1.5 GB · internal network only |
| `proxy` | the agent's only way out; blocks private / LAN / tailnet / metadata | 128 MB |
| `deployer` *(profile `apps`)* | hosts Friday's own apps on the tailnet, fixed tiny API | optional |

```bash
docker compose up -d --build
```

Step-by-step setup, rolling back data after a bad deploy, Gmail OAuth and measured resource numbers:
[`docs/DEPLOY-SERVER.md`](docs/DEPLOY-SERVER.md).

---

## Configuration

Everything is environment variables in `.env` ([`.env.example`](.env.example) documents each one). The ones that matter first:

| Variable | Purpose |
|---|---|
| `FRIDAY_NVIDIA_API_KEY` | Main brain (Nemotron), embeddings, vision, images |
| `FRIDAY_GEMINI_API_KEY` | Optional: Gemini for reasoning / planning / vision (`FRIDAY_GEMINI_ROLES` widens it) |
| `FRIDAY_FALLBACK_BASE_URL` · `_API_KEY` · `_MODEL` | Any OpenAI-compatible provider as a last-resort fallback |
| `FRIDAY_MODELS_CHAT` · `FRIDAY_MODELS_REASON` | Override a role's chain, e.g. `nvidia:model-a,fallback:model-b` |
| `SERPAPI_API_KEY` | Web search for the brain and agents |
| `FRIDAY_DSH_BIN` | Path to the DSH agent runtime |
| `GITHUB_TOKEN` | Enables the GitHub MCP server for coding agents |
| `FRIDAY_DATA_DIR` | Where everything lives (default `./data`) |
| `FRIDAY_RESOURCE_PROFILE` | Memory budget profile (e.g. `server6g`) |

Keys are referenced by env-var **name** only — they never go into prompts, logs or agent homes.

---

## Project layout

```text
bin/friday.mjs           CLI: start · stop · status · doctor · device · totp · backup · restore
src/context.mjs          composition root — every service built once
src/ai/                  model router, OpenAI-compatible provider, memory indexer
src/agent/               brain, tool loading, computer agent, team, self-learning, auto-memory
src/routes/  src/http/   HTTP API + SSE
src/policy.mjs           autonomy tiers          src/approvals.mjs  exact-payload approvals
src/effects.mjs          side-effect ledger      src/audit.mjs      hash-chained audit
src/prospector.mjs       client-hunting pipeline src/pipeline.mjs   CRM + outreach
public/                  dashboard + phone PWA (plain JS, no build step)
node/                    laptop node: Playwright + AT-SPI + push-to-talk
agent-runner/ egress-proxy/ deployer/ deploy/   containers
voice/  docs-engine/     Python workers: speech, documents
skills/                  SKILL.md folders (third-party ones pinned in THIRD_PARTY.md)
physical/ desktop-pet/   ESP32 companion + Tauri pet
test/                    hermetic test suite (fake models and agents)
```

---

## Testing & benchmarks

```bash
npm test            # 315 hermetic server tests — no network, fake model and agent engines
npm run test:node   # laptop node + real-Chrome UI tests
npm run check       # syntax check of the entry points
```

CI runs all three on every pull request. The brain itself is measured by a benchmark that runs the real prompt,
tools, guards and router against a fixed stubbed world — **38/39** on the 27 Oct baseline, with ~60% fewer input
tokens than before tool loading. Method and full table: [`docs/benchmarks/2026-10-27-baseline.md`](docs/benchmarks/2026-10-27-baseline.md).

---

## Honest status

Things are only ticked when they work end to end and a test or a measurement proves it.
The full, dated list is [`docs/ROADMAP.md`](docs/ROADMAP.md).

| ✅ Verified live | 🟡 Built, not yet proven on target | 🔭 Next |
|---|---|---|
| Brain + tools against the real model API | Web Push on a real phone | **Local brain** on the laptop GPU over the tailnet, cloud as fallback |
| Running on a 6 GB server in Docker, tailnet-only | GitHub PR flow end to end | Episodic summaries + memory consolidation |
| Laptop node driving real Chrome, cross-machine | ESP32 firmware on hardware, Tauri pet build | Calendar, smart-device control |
| Research agents with sources + contradictions | Raw input / screenshots on GNOME Wayland | Closing the open items in the latest review |
| Reminders, approvals, voice, prospecting | | |

---

<div align="center">

Built by [**Atharv Bhosale**](https://github.com/atharvb7) — a forward-deployed AI engineer who designs and ships production agentic systems.

<sub>No license has been chosen yet, so all rights are reserved by default. Issues and ideas are welcome.</sub>

</div>
