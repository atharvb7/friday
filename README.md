# Friday

A persistent personal AI that lives on your server and reaches you everywhere: web, phone, desktop pet, a physical
desk companion, and your laptop's browser. One identity, one memory, one task system, many bodies.

- **Brain**: model router (Nemotron Super for turns, Ultra for deep reasoning, any OpenAI-compatible fallback), streaming
  tool-calling, personality sliders, selective context (hybrid keyword+vector memory, research memory, skills).
- **Hands**: DeepSeek Harness agents in a bubblewrap sandbox (research, coding, MCP: SerpApi/GitHub), plus a **laptop node**
  that drives your logged-in Chrome (DOM refs) and desktop accessibility tree, outbound-connected so the server never reaches in.
- **Always on**: reminders, recurring agent jobs, proactive alerts + morning briefing (quiet hours, daily cap), notification inbox, Web Push.
- **Safety**: per-category autonomy tiers, exact-payload approvals, TOTP for phone approvals, emergency stop, audit hash chain,
  scoped revocable device tokens, resource governor with a hard memory budget. Personality never grants privileges.

See [docs/ROADMAP.md](docs/ROADMAP.md) for exactly what is done/verified and what is not, and
[docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md) to put it on the 6 GB server.

## Run it (laptop or server)
Requires Node ≥ 22.13 (no npm install for the server), `bubblewrap` for agents, and Google Chrome only on the laptop node.
```bash
cp .env.example .env && chmod 600 .env     # add FRIDAY_NVIDIA_API_KEY (+ SERPAPI_API_KEY, FRIDAY_DSH_BIN)
node bin/friday.mjs doctor                 # checks everything and tells you what's missing
node bin/friday.mjs start                  # http://127.0.0.1:4317  (token: data/access-token)
node bin/friday.mjs status | logs -f | stop | restart
node bin/friday.mjs device add phone read,chat,tasks,approve   # prints a device token once
node bin/friday.mjs totp                   # authenticator for phone approvals
node bin/friday.mjs backup | restore <file.tgz>
npm test                                   # 119+ tests
```
Open `/` in a browser, paste the token. Phone: `tailscale serve --https=443 http://127.0.0.1:4317`, then open the tailnet URL
and install the PWA. Laptop control: see [node/README.md](node/README.md). Desk companion: [physical/esp32-companion](physical/esp32-companion/README.md).

## Layout
```
src/context.mjs        composition root (every service built once)      src/ai/            router, providers, memory indexer
src/routes/*           HTTP routes                                      src/agent/         brain, tools, computer agent, context builder
src/dsh.mjs sandbox.mjs  agent runtime + confinement                    src/nodes.mjs      laptop-node hub
src/policy.mjs approvals.mjs  autonomy + human approval                 src/companion.mjs  one state for every body
public/                dashboard + phone PWA (no build step)            node/              laptop node (Playwright + AT-SPI)
skills/                SKILL.md folders                                  physical/ desktop-pet/  hardware + Tauri scaffolds
```
Data lives in one directory (`FRIDAY_DATA_DIR`, default `./data`): SQLite DB, token, agent homes/workspaces. Moving machines =
`friday backup` → copy → `friday restore` (see DEPLOY).
