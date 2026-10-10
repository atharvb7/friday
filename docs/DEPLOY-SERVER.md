# Deploying Friday to the 6 GB server

Measured on the dev laptop (2026-10-10): core idle **81 MiB**, after chats ~100 MiB, core + one running DSH agent **~285 MiB** peak
(a second concurrent agent adds ~190 MiB). Budget is 5 GB, so the server has a lot of headroom; the cgroup cap below enforces it.

## 1. Prepare the box (Ubuntu/Debian, as a normal user `friday`)
```bash
sudo apt install -y bubblewrap git python3 curl            # bubblewrap = agent sandbox
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs   # Node >= 22.13
sudo useradd -m -s /bin/bash friday && sudo loginctl enable-linger friday
# Tailscale for private phone/laptop access (no public ports):
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```
Check unprivileged user namespaces work (bubblewrap needs them): `bwrap --ro-bind / / true && echo ok`.

## 2. Install Friday + the agent runtime
```bash
sudo -iu friday
git clone <your repo> ~/friday && cd ~/friday           # or rsync from the laptop
npm install -g @deepseek-ai/dsh@0.2.0-rc.2                # the agent runtime (published on npm)
cp .env.example .env && chmod 600 .env                    # then edit:
#   FRIDAY_NVIDIA_API_KEY=...   SERPAPI_API_KEY=...   (GITHUB_TOKEN=... optional)
#   FRIDAY_DSH_BIN=$(npm root -g)/@deepseek-ai/dsh/lib/bin.js
#   FRIDAY_RESOURCE_PROFILE=server6g   FRIDAY_WORKER_CONCURRENCY=2
node bin/friday.mjs doctor
```
## 3. Run as a service with a hard memory cap
```bash
MEM_HIGH=4G MEM_MAX=5G scripts/install-systemd.sh --enable      # user unit; whole tree (core + agents) shares the cgroup
systemctl --user status friday ; node bin/friday.mjs status
```
## 4. Private access + auth
```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:4317     # tailnet-only HTTPS. Do NOT use `funnel`.
node bin/friday.mjs totp                                         # then confirm with your authenticator
node bin/friday.mjs device add phone read,chat,tasks,approve     # token for the phone (shown once)
node bin/friday.mjs device add laptop read,node                  # token for the laptop node
```
Open `https://<server>.<tailnet>.ts.net`, sign in with the phone token, "Add to Home Screen", Settings → Enable notifications.
On the laptop: `cd node && npm install && node friday-node.mjs pair --server https://<server>.<tailnet>.ts.net --token fdv_… && node friday-node.mjs run`
(log into WhatsApp/etc. once in the node's Chrome profile).

## 5. Migrating the existing laptop data
```bash
# laptop:  node bin/friday.mjs stop && node bin/friday.mjs backup ~/friday-backup        # secrets excluded by default
# server:  node bin/friday.mjs restore ~/friday-backup/friday-backup-*.tgz              # then start
```
Device tokens are stored hashed in the DB, so existing devices keep working after a restore; the owner token (`data/access-token`) is new on
the server unless you use `backup --with-secrets` (protect that file).

## 6. Operations
`friday doctor` (pre-flight), `friday status`, `friday logs -f`, `/v1/health` (Settings → System health), `friday backup` on a cron
(keeps the last 7), emergency stop from any device (■ Stop). Update: `git pull && node bin/friday.mjs restart`.
Voice (browser mic + speaker and the ESP32): `node bin/friday.mjs voice setup` (needs `python3-venv`; ~600 MB download), then restart. The worker uses ~1 GB while a conversation is active and exits after 5 idle minutes; set `FRIDAY_STT_MODEL=base` to halve that.

## Things that are NOT verified yet (need the real server)
bubblewrap under the server's kernel/container, Tailscale Serve + phone PWA install + Web Push end to end, memory under sustained
concurrent load. (Verified on the laptop: DSH 0.2.0-rc.2 from npm runs Friday's headless `--json` contract and the NVIDIA route; on its
first run in a fresh home it imports `settings.yaml`, so Friday retries that one failure once.)
