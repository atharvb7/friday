# Tailscale private phone access — runbook (docs only, NOT applied)

> Status: **manual runbook**. Nothing here is auto-applied. There are no
> config/code changes attached — every step below is a command a human runs
> deliberately, and every step can be undone. `tailscale funnel` (public
> internet exposure) is **never** used.

## 0. What this enables

- Phone (Tailnet only) → `https://<laptop-tailnet-name>` → Friday on
  `127.0.0.1:4317`.
- The app itself is unchanged: it still binds `127.0.0.1:4317` only
  (`src/server.mjs`: `host = '127.0.0.1'`, `port = FRIDAY_PORT ?? 4317`).
  Tailscale `serve` is the **only** ingress; there is no new port binding.

## 1. Safety checklist — complete BEFORE enabling

- [ ] Laptop disk is encrypted and screen locks quickly (≤ 5 min idle).
- [ ] `data/access-token` exists, is long/random, and is **not** shared
      over chat/screenshots. Phone login means typing it once into the
      phone browser (session-scoped, never in a URL).
- [ ] You know the kill switch: `POST /v1/emergency-stop` button
      ("Stop everything") in the dashboard + §6 below.
- [ ] You tested kill-switch + disable steps from the laptop first
      (see §6) before exposing anything.
- [ ] Tailnet admin access available (to check ACL + revoke a device).
- [ ] Phone is your own, with OS lock + Tailscale signed in as **you**.
- [ ] Understand: Tailscale Serve keeps working while the laptop screen is
      locked but awake. **Lock ≠ offline.** To stop access, run §7.
- [ ] Understand: laptop **sleep/suspend stops serving** (good). On wake,
      serve resumes if the daemon is still running — re-check §4 after wake.

## 2. Enable (tailnet-only HTTPS, no Funnel)

Run on the **laptop**:

```bash
# 0) Identity + daemon sanity
tailscale status
tailscale whoami   # note your user + tailnet name, e.g. you@github / laptop.example.ts.net

# 1) Serve Friday's loopback port over tailnet HTTPS only (port 443).
#    --bg keeps it running after the shell exits. No --funnel flag, ever.
tailscale serve --bg --https=443 http://127.0.0.1:4317

# 2) Confirm: Serve entry present, Funnel OFF
tailscale serve status
tailscale serve status --json | head -50
tailscale funnel status   # must report OFF / no listeners
```

Expected `tailscale serve status` shape:

```text
https://<laptop-tailnet-name> (--https 443)
|-- / -> http://127.0.0.1:4317
```

On the **phone** (connected to the same Tailnet, Tailscale ON + logged in
as you): open `https://<laptop-tailnet-name>` and log in with the Friday
access token. If the browser warns about certificates, **stop** — verify
you typed the tailnet name correctly and Tailscale is on; do not bypass.

```bash
# NEVER run any of these (public exposure):
# tailscale funnel ...
# tailscale serve --funnel ...
# tailscale serve --https=443 --funnel ...   <-- NOT THIS
```

## 3. Restrict who can reach it (ACL example)

Serve traffic still honors the tailnet policy. Keep the default-deny
posture and grant **only your identity** (example — edit in the Tailnet
admin console policy file, replace placeholders):

```jsonc
{
  // EXAMPLE ONLY — adapt user + tag to your tailnet.
  "grants": [
    {
      "src": ["you@example.com"],      // <-- your login identity only
      "dst": ["tag:friday-laptop"],    // <-- tag applied to this laptop
      "ip": ["443"]                    // <-- serve HTTPS port only
    }
  ]
}
```

Tag the laptop first (admin console → machines → edit ACL tags), then apply
the policy. Verify from the phone that **you** can load the page, and (if
possible) that a second identity/device **cannot**.

Minimum viable alternative if you don't use tags: confirm in the admin
console that no device sharing / extra users have access to the laptop
machine, and that expiry / key-expiry is on for the phone.

## 4. Re-check after sleep/wake + network changes

```bash
tailscale status
tailscale serve status     # entry for 443 -> 127.0.0.1:4317 must be present
tailscale funnel status    # must still be OFF
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4317/v1/status
```

If serve is missing after wake/reboot, re-run the §2 serve command.

## 5. App-level re-auth rule for approvals (mandatory)

Tailscale auth is **transport only**. Friday approvals stay app-gated:

1. On the phone, always start from a **fresh login**: clear the session
   (dashboard "Clear session token") and re-enter the access token before
   approving anything.
2. Approving an effect requires the **single-use approval token** from
   `POST /v1/tasks/:id/effects` for that exact effect — the dashboard
   prompts for it on every approval. Any arg change invalidates it.
3. Never approve from the lock screen / notifications. Open the queued
   effect, read the exact args, then approve.
4. Consequential voice output is never auto-spoken for approval: the
   dashboard must show the text visually first (see `src/voice.mjs`
   `proposeConsequentialUtterance`); voice `speak()` is read-back only.

## 6. Kill-switch test (do this before relying on phone access)

```bash
# A) App-level stop (from laptop OR phone dashboard):
#    press "Stop everything" (POST /v1/emergency-stop), confirm the
#    emergency banner appears and new work pauses.

# B) Transport-level stop (from the laptop — ends phone access now):
tailscale serve reset
tailscale serve status   # must show NO serve entries

# C) Confirm phone can no longer load https://<laptop-tailnet-name>
#    (expect connection failure, NOT the Friday UI).

# D) Re-enable only when wanted:
tailscale serve --bg --https=443 http://127.0.0.1:4317
```

## 7. Suspend / lock behavior

| State | Friday reachable via Serve? |
|---|---|
| Screen locked, laptop awake | **YES — still serving.** Lock is not a kill switch; run §7-disable. |
| Sleep / suspend / lid closed (suspends) | No (daemon asleep). May resume on wake — re-check §4. |
| `tailscale serve reset` run | No. |
| Tailscale logged out / `tailscale logout` | No (also signs the laptop out — re-auth needed). |
| `tailscale disconnect` (offline, keys kept) | No. Reconnect with `tailscale connect`. |

## 8. Revoke / fully disable

```bash
# Stop serving (keeps Tailscale connected for everything else):
tailscale serve reset
tailscale serve status    # confirm empty
tailscale funnel status   # confirm OFF

# If the phone is lost / you want the device gone entirely,
# do this in the Tailnet admin console:
#   Machines -> phone -> Remove / disable key expiry bypass.
# Then rotate the Friday token on the laptop:
#   1) stop the service (systemctl --user stop friday  — if managed)
#   2) delete data/access-token (it is re-created random on next start)
#   3) start the service, copy the new token locally, log in fresh.
```

## 9. Quick troubleshooting

- Phone gets TLS error → Tailscale OFF on phone, wrong hostname, or not
  the same tailnet. Check `tailscale status` on both ends.
- `serve: permission denied` → enable "HTTPS server"/serve permission for
  the laptop in the admin console, then retry §2.
- Page loads but token rejected → token rotated or typo; copy from
  `data/access-token` on the laptop directly, never over screenshots.
- Serve entry vanishes after reboot → re-run §2 (serve config is not
  guaranteed persistent across reinstalls; verify with §4).
