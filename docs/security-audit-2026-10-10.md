# Security audit — 2026-10-10

Independent read-only review of the whole codebase (auth, injection, SSRF, sandbox, prompt-injection paths, DoS, UI).
Each finding below has a regression test unless marked otherwise.

## Fixed
| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Critical | Sandbox left `/run` reachable: session D-Bus, ssh-agent and `docker.sock` are host-escape routes (read-only bind does not stop `connect()`) | `--tmpfs /run` (only DNS resolver state kept), `--new-session`, `--cap-drop ALL`, `--unshare-uts`; real-bwrap test |
| 2 | High | Agent-writable dir read/written by the host without symlink protection (symlinked `report.md`/`findings.json` leaked the owner token via the report API; FIFOs hang the server; planted symlinks redirected host writes/deletes) | `src/safefs.mjs` (O_NOFOLLOW, regular-file only, size-capped, atomic replace); overlay + skills moved OUT of the agent-writable home and mounted read-only |
| 3 | High | SSRF bypass via IPv4-mapped IPv6 hex form `[::ffff:7f00:1]` (and NAT64/6to4/Teredo/site-local) | Byte-level IPv6 parsing; only global unicast allowed; same policy in the node |
| 4 | High | Regex DoS in `htmlToText` (seconds per 200 KB) | Linear tokenizer + input cap (0–1 ms on the attack inputs) |
| 5 | High | Laptop agent risk was self-declared by the model; approved goals auto-allowed uploads/UI actions | Risk now derived from the target element's label (send/post/buy/delete…); `submit=true`/Enter escalate; grants never cover uploads/messaging/spending/deletion; approval shows full goal and target |
| 6 | High | Node file policy allowed Friday's own data/tokens under `~/Documents` | Blocks token/secret/sqlite/key-like names and any file next to Friday data |
| 7 | Medium | Device tokens could not sign in to the UI (`whoami` needed admin) → users would paste the owner token | `whoami` needs `read` only |
| 8 | Medium | Node URL policy skipped DNS and redirects (`nip.io`, 302, `[::ffff:…]`) | Per-request interception in Chrome with DNS resolution + private-address check; real-Chrome test |
| 9 | Medium | No TOTP brute-force protection | 5 failures / 10 min → 15 min lockout |
| 10 | Medium | SSE: one principal could exhaust all event streams; companion stream uncapped | Per-principal caps |
| 11 | Medium | Web Push: any https endpoint accepted, unbounded, serial | Private hosts refused, 30-subscription cap |
| 12 | Medium | `schedule_task` ungated; rules could self-trigger agent loops | `schedule_task` approval-gated; task rules cannot trigger on task/research events; global daily cap |
| 13 | Medium | Chat history window used the OLDEST 20 messages (model forgot recent turns, incl. confirmations) | Newest 20 |
| 14 | Low | MCP URL check was a prefix match; skills inbox allowed `..`; node token on the command line / plaintext http; unbounded DB growth; spawnSync probe per status call | Hostname parsing; stricter folder regex; `FRIDAY_NODE_TOKEN` env + https enforced; retention job (audit chain never pruned); 60 s probe cache |

## Accepted / documented risks (not fixed)
- **Secrets inside the agent process.** The agent needs `NVIDIA_API_KEY` (and `SERPAPI_API_KEY` / `GITHUB_TOKEN` when MCP uses them) in its environment and has open network, so an injected agent could exfiltrate them. Mitigations: use a SerpApi key you can rotate, a read-scoped fine-grained GitHub PAT, and watch the model/key usage dashboards. A per-run egress allow-list or key proxy is the real fix (future work).
- **Task output re-enters chat as the assistant's words**, which raises trust in agent-derived text. Agent output is already labelled "Finished …"; a data role/tag is future work.
- **Any `read` device receives the event stream** (task titles, notification text). Give hardware devices only the scopes they need; per-scope event filtering is future work.
- **No Host-header check** (DNS-rebinding can reach the static UI, not the API, which needs a token). Run behind Tailscale Serve as documented.
- **Emergency stop needs only `read`** by design: stopping must never be hard.
- `restoreBackup` extracts any tar you give it (operator action); `/v1/tasks/:id/effects` returns an approval token to its proposer (ledger has no outbound sink).

## Checked and found safe
YAML overlay (no injection path to `!!js`), scope/route matching (no method/path confusion), constant-time owner compare + hashed device tokens, TOTP replay protection, approval payload binding + atomic claim, static server containment, UI DOM building and CSP, parameterised SQL, shell-free process spawning, DNS-rebinding defence in the fetcher, node result ownership, web-push crypto, audit redaction.
