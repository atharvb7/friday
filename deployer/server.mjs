// Friday's deployer: builds and runs ONLY Friday's own apps on the server and publishes each one on the owner's
// tailnet (https://<host>.ts.net:<port>, tailnet-only). It talks to the Docker Engine API over the mounted socket
// and to tailscaled over its socket, so it is powerful — which is why its API is tiny and fixed:
//   - sources come only from the coding agent's project folders (read-only mount), never from arbitrary paths;
//   - it only ever touches containers/images labelled friday.app (never sorch, supabase, hermes, Friday itself...);
//   - every app runs unprivileged: no capabilities, no new privileges, memory/CPU/pid limits, no host mounts,
//     ports bound to 127.0.0.1 only and exposed solely through `tailscale serve` (never Funnel / public internet).
// Zero dependencies; Node 22.
import { createServer, request } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tarFiles, collect, plan } from './lib.mjs';
import { timingSafeEqual } from 'node:crypto';

const SECRET = process.env.DEPLOYER_SECRET ?? '';
const WORK = process.env.DEPLOYER_WORK ?? '/work/_projects';
const SOCK = process.env.DOCKER_SOCK ?? '/var/run/docker.sock';
const TS_HOST = process.env.TS_HOSTNAME ?? ''; // e.g. atharvsserver.tail117666.ts.net
const NET = 'friday_apps';
const PORT_MIN = 9100, PORT_MAX = 9199, MAX_APPS = 8;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const LABEL = 'friday.app';

if (!SECRET || SECRET.length < 24) { console.error('DEPLOYER_SECRET missing/too short'); process.exit(2); }

// ---------------------------------------------------------------- docker engine API over the unix socket
function docker(method, path, { body = null, raw = null, headers = {}, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body ? Buffer.from(JSON.stringify(body)) : null);
    const req = request({ socketPath: SOCK, method, path: `/v1.45${path}`, timeout, headers: { ...(data ? { 'Content-Length': data.length, 'Content-Type': raw ? 'application/x-tar' : 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* streams */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('docker_timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.json?.message ?? r.text.slice(0, 200)}`); return r; };

const sh = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 30_000 }, (e, so, se) => (e ? rej(new Error(`${cmd}: ${(se || e.message).trim().slice(0, 200)}`)) : res(so))));

async function apps() {
  const r = ok(await docker('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [LABEL] }))}`), 'list');
  return r.json.map((c) => ({ name: c.Labels[LABEL], state: c.State, status: c.Status, port: Number(c.Labels['friday.port']), url: TS_HOST ? `https://${TS_HOST}:${c.Labels['friday.port']}` : null, image: c.Image, created: new Date(c.Created * 1000).toISOString(), id: c.Id }));
}
async function ensureNetwork() {
  const r = await docker('GET', `/networks/${NET}`);
  if (r.status === 404) ok(await docker('POST', '/networks/create', { body: { Name: NET, Driver: 'bridge', Labels: { [LABEL]: 'network' } } }), 'network');
}
async function appContainer(name) { return (await apps()).find((a) => a.name === name) ?? null; }

async function deploy({ name, project, memoryMb = 256 }) {
  if (!NAME_RE.test(String(name ?? ''))) throw new Error('name: lowercase letters, digits and dashes (2-31)');
  if (!NAME_RE.test(String(project ?? ''))) throw new Error('project: a coding workspace name');
  const src = join(WORK, project);
  if (!existsSync(src)) throw new Error(`project "${project}" not found — build it with a coding task in that workspace first`);
  const current = await apps(); const prev = current.find((a) => a.name === name);
  if (!prev && current.length >= MAX_APPS) throw new Error(`already running ${MAX_APPS} apps — remove one first`);
  const files = collect(src); const p = plan(files);
  if (p.dockerfile) files.push({ name: 'Dockerfile.friday', data: Buffer.from(p.dockerfile) });
  const tag = `friday-app-${name}:${Date.now()}`;
  const build = await docker('POST', `/build?t=${encodeURIComponent(tag)}&dockerfile=${p.dockerfile ? 'Dockerfile.friday' : 'Dockerfile'}&forcerm=1&rm=1&labels=${encodeURIComponent(JSON.stringify({ [LABEL]: name }))}&memory=1073741824`, { raw: tarFiles(files), timeout: 15 * 60_000 });
  const lines = build.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const err = lines.find((l) => l.error || l.errorDetail);
  const logTail = lines.map((l) => l.stream ?? l.status ?? '').join('').split('\n').slice(-25).join('\n');
  if (build.status >= 300 || err) throw Object.assign(new Error(`build failed: ${(err?.error ?? build.text).toString().slice(0, 300)}`), { log: logTail });
  await ensureNetwork();
  let port = prev?.port;
  if (prev) { await docker('POST', `/containers/${prev.id}/stop?t=5`); await docker('DELETE', `/containers/${prev.id}?force=1`); }
  const used = new Set(current.map((a) => a.port));
  const mem = Math.min(1024, Math.max(64, Number(memoryMb) || 256)) * 1024 * 1024;
  let created = null;
  for (let cand = port ?? PORT_MIN; cand <= PORT_MAX && !created; cand++) {
    if (!port && used.has(cand)) continue;
    const r = await docker('POST', `/containers/create?name=fapp-${name}`, { body: {
      Image: tag, Env: [`PORT=${p.port}`, 'HOST=0.0.0.0'], ExposedPorts: { [`${p.port}/tcp`]: {} },
      Labels: { [LABEL]: name, 'friday.port': String(cand), 'friday.project': project, 'friday.kind': p.kind },
      HostConfig: { PortBindings: { [`${p.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(cand) }] }, Memory: mem, MemorySwap: mem, NanoCpus: 500_000_000, PidsLimit: 256,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: NET, LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } } } } });
    if (r.status === 201) {
      const s = await docker('POST', `/containers/${r.json.Id}/start`);
      if (s.status < 300) { created = { id: r.json.Id, port: cand }; break; }
      await docker('DELETE', `/containers/${r.json.Id}?force=1`);
      if (!/port is already allocated|address already in use/i.test(s.text)) throw new Error(`start failed: ${s.json?.message ?? s.text.slice(0, 200)}`);
    } else if (r.status !== 409) throw new Error(`create failed: ${r.json?.message ?? r.text.slice(0, 200)}`);
    if (port) break; // keep an existing app's port; don't wander
  }
  if (!created) throw new Error('no free port');
  // health: wait for the app to answer inside the apps network
  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) {
    healthy = await new Promise((res) => { const q = request({ host: `fapp-${name}`, port: p.port, path: '/', timeout: 2000 }, (r) => { r.resume(); res(r.statusCode < 500); }); q.on('error', () => res(false)); q.on('timeout', () => { q.destroy(); res(false); }); q.end(); });
    if (!healthy) await new Promise((r) => setTimeout(r, 1000));
  }
  await sh('tailscale', ['serve', '--bg', `--https=${created.port}`, `http://127.0.0.1:${created.port}`]); // tailnet only (never funnel)
  // tidy old images of this app
  const imgs = await docker('GET', `/images/json?filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${name}`] }))}`);
  for (const im of imgs.json ?? []) if (!(im.RepoTags ?? []).includes(tag)) await docker('DELETE', `/images/${im.Id}?force=1`).catch(() => {});
  return { name, kind: p.kind, port: created.port, url: TS_HOST ? `https://${TS_HOST}:${created.port}` : null, healthy, updated: Boolean(prev), buildLog: logTail.slice(-1500) };
}

async function remove(name) {
  const a = await appContainer(name); if (!a) throw new Error('no such app');
  await sh('tailscale', ['serve', `--https=${a.port}`, 'off']).catch(() => {});
  await docker('DELETE', `/containers/${a.id}?force=1`);
  const imgs = await docker('GET', `/images/json?filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${name}`] }))}`);
  for (const im of imgs.json ?? []) await docker('DELETE', `/images/${im.Id}?force=1`).catch(() => {});
  return { removed: name };
}
async function logs(name, tail = 200) {
  const a = await appContainer(name); if (!a) throw new Error('no such app');
  const r = ok(await docker('GET', `/containers/${a.id}/logs?stdout=1&stderr=1&tail=${Math.min(1000, Math.max(10, Number(tail) || 200))}&timestamps=1`), 'logs');
  // strip the 8-byte multiplex headers
  const buf = Buffer.from(r.text, 'latin1'); const out = []; let i = 0;
  while (i + 8 <= buf.length) { const len = buf.readUInt32BE(i + 4); out.push(buf.subarray(i + 8, i + 8 + len).toString('utf8')); i += 8 + len; }
  return { name, logs: (out.length ? out.join('') : r.text).slice(-20_000) };
}
async function action(name, act) {
  const a = await appContainer(name); if (!a) throw new Error('no such app');
  ok(await docker('POST', `/containers/${a.id}/${act}?t=5`), act);
  if (act === 'stop') await sh('tailscale', ['serve', `--https=${a.port}`, 'off']).catch(() => {});
  if (act === 'start' || act === 'restart') await sh('tailscale', ['serve', '--bg', `--https=${a.port}`, `http://127.0.0.1:${a.port}`]);
  return { name, done: act };
}

// ---------------------------------------------------------------- HTTP API (internal network only, shared secret)
const authed = (req) => { const t = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, '')); const s = Buffer.from(SECRET); return t.length === s.length && timingSafeEqual(t, s); };
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
let busy = false; // one deploy at a time (a 6 GB server)

createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://x'); const parts = url.pathname.split('/').filter(Boolean);
  let body = {}; if (req.method === 'POST') { let t = ''; for await (const c of req) { t += c; if (t.length > 16_384) return send(res, 413, { error: 'too large' }); } try { body = JSON.parse(t || '{}'); } catch { return send(res, 400, { error: 'bad json' }); } }
  try {
    if (req.method === 'GET' && url.pathname === '/apps') return send(res, 200, { apps: await apps() });
    if (req.method === 'POST' && url.pathname === '/apps/deploy') {
      if (busy) return send(res, 409, { error: 'another deploy is running — try again in a minute' });
      busy = true; try { return send(res, 200, await deploy(body)); } finally { busy = false; }
    }
    if (parts[0] === 'apps' && parts[1] && NAME_RE.test(parts[1])) {
      if (req.method === 'GET' && parts[2] === 'logs') return send(res, 200, await logs(parts[1], url.searchParams.get('tail')));
      if (req.method === 'POST' && ['restart', 'stop', 'start'].includes(parts[2])) return send(res, 200, await action(parts[1], parts[2]));
      if (req.method === 'DELETE' && !parts[2]) return send(res, 200, await remove(parts[1]));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 400, { error: String(e.message).slice(0, 500), ...(e.log ? { buildLog: e.log.slice(-1500) } : {}) }); }
}).listen(4330, '0.0.0.0', () => console.log('friday deployer on :4330'));
