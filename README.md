# Friday core, foundation slice

This is the first runnable component of Friday. It stores tasks and an event trail in SQLite, exposes a loopback-only API, and reports laptop memory pressure. It does not start DeepSeek Harness, load a local model, control the computer, or expose a phone endpoint yet.

Requirements: Node.js 22.13 or later. There are no third-party packages to install.

```bash
cd friday
npm test
npm start
```

On first start, Friday creates `friday/data/access-token` with owner-only permissions. To check status from another terminal:

```bash
curl -H "Authorization: Bearer $(< data/access-token)" http://127.0.0.1:4317/v1/status
```

Create a task:

```bash
curl -X POST http://127.0.0.1:4317/v1/tasks \
  -H "Authorization: Bearer $(< data/access-token)" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-task' \
  -d '{"title":"First task","instruction":"Create a useful Friday dashboard"}'
```

The service accepts only `127.0.0.1` connections. Do not proxy it to Tailscale until phone authentication and approval flows are implemented. Tasks are queued records for now; there is no worker that executes them.

`FRIDAY_DATA_DIR` changes the data directory and `FRIDAY_PORT` changes the loopback port. SQLite uses WAL mode. The access token and database are intentionally local; back them up securely before moving machines.
