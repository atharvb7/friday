#!/usr/bin/env node
// friday — operator CLI: start | stop | restart | status | logs | doctor
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync, statSync, createReadStream, watchFile } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../src/env.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(resolve(appRoot, '.env'));
const dataDir = resolve(process.env.FRIDAY_DATA_DIR ?? resolve(appRoot, 'data'));
const logDir = resolve(dataDir, 'logs');
const pidFile = resolve(dataDir, 'friday.pid');
const logFile = resolve(logDir, 'friday.log');
const port = Number(process.env.FRIDAY_PORT ?? 4317);
const base = `http://127.0.0.1:${port}`;

const nearest = (p) => { while (!existsSync(p) && dirname(p) !== p) p = dirname(p); return p; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = () => { try { const p = Number(readFileSync(pidFile, 'utf8')); return alive(p) ? p : null; } catch { return null; } };
const token = () => { try { return readFileSync(resolve(dataDir, 'access-token'), 'utf8').trim(); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  const t = token();
  const res = await fetch(base + path, { headers: t ? { Authorization: `Bearer ${t}` } : {}, signal: AbortSignal.timeout(3000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function status({ quiet = false } = {}) {
  const pid = readPid();
  let s = null;
  try { const r = await api('/v1/status'); if (r.status === 200) s = r.body; } catch {}
  const line = (k, v) => console.log(`${k.padEnd(14)} ${v}`);
  if (!pid && !s) { if (!quiet) console.log('Friday is offline.'); return 1; }
  console.log(s ? 'Friday online.' : 'Friday process is up but the API is not answering.');
  if (!s) return 2;
  const rs = s.resources ?? {};
  line('Brain:', `${s.brain}${s.nemotronConfigured ? '' : ' (no Nemotron key)'}`);
  line('Agent runtime:', s.worker?.adapterReady ? 'DSH ready' : `not ready (${s.worker?.adapterReason ?? 'unknown'})`);
  line('Tasks:', JSON.stringify(s.tasks));
  line('Pressure:', rs.mode ?? rs.level ?? JSON.stringify(rs).slice(0, 80));
  line('Local model:', 'off (by design)');
  line('Emergency stop:', s.emergencyStopped ? 'LATCHED' : 'clear');
  line('PID:', pid ?? '?');
  return 0;
}

async function start() {
  if (readPid()) { console.log('Already running.'); return status(); }
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const out = openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [resolve(appRoot, 'src/server.mjs')], { detached: true, stdio: ['ignore', out, out], cwd: appRoot, env: process.env });
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!alive(child.pid)) { rmSync(pidFile, { force: true }); console.error(`Friday exited during startup. See: friday logs`); return 1; }
    try { const r = await api('/v1/status'); if (r.status === 200) return status(); } catch {}
  }
  console.error('Started, but the API did not answer within 10s. See: friday logs');
  return 2;
}

async function stop() {
  const pid = readPid();
  if (!pid) { console.log('Friday is not running.'); rmSync(pidFile, { force: true }); return 0; }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
  if (alive(pid)) { process.kill(pid, 'SIGKILL'); console.log('Force-killed after 10s.'); } else console.log('Friday stopped.');
  rmSync(pidFile, { force: true });
  return 0;
}

function logs(args) {
  if (!existsSync(logFile)) { console.log('No log yet.'); return 0; }
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 50);
  const lines = readFileSync(logFile, 'utf8').split('\n');
  console.log(lines.slice(-n - 1).join('\n'));
  if (args.includes('-f')) {
    let pos = statSync(logFile).size;
    watchFile(logFile, { interval: 500 }, (cur) => {
      if (cur.size > pos) createReadStream(logFile, { start: pos, end: cur.size }).pipe(process.stdout, { end: false });
      pos = cur.size;
    });
    return new Promise(() => {});
  }
  return 0;
}

async function doctor() {
  let bad = 0;
  const row = (ok, name, detail = '', warn = false) => { console.log(`${ok ? 'OK  ' : warn ? 'WARN' : 'FAIL'} ${name.padEnd(22)} ${detail}`); if (!ok && !warn) bad++; };
  const major = Number(process.versions.node.split('.')[0]);
  row(major >= 22, 'node >= 22.13', process.versions.node);
  const has = (b) => spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim();
  for (const [k, label] of [['FRIDAY_NVIDIA_API_KEY', 'Nemotron key'], ['SERPAPI_API_KEY', 'SerpApi key']]) row(Boolean(process.env[k]), label, process.env[k] ? 'set' : 'missing', true);
  row(process.env.FRIDAY_JEV_ENABLED === '1' ? Boolean(process.env.FRIDAY_JEV_KEY) : true, 'JEV', process.env.FRIDAY_JEV_ENABLED === '1' ? 'enabled' : 'off', true);
  row(Boolean(has('dsh')), 'dsh binary', has('dsh') || 'not on PATH (agent tasks will not run)', true);
  row(Boolean(has('google-chrome') || has('chromium')), 'chrome/chromium', has('google-chrome') || has('chromium') || 'missing', true);
  row(Boolean(has('tailscale')), 'tailscale', has('tailscale') || 'missing', true);
  const mem = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, parseInt(v, 10) / 1048576]; }));
  row(mem.MemAvailable > 2, 'RAM available', `${mem.MemAvailable.toFixed(1)} GiB of ${mem.MemTotal.toFixed(1)}`);
  try { const df = spawnSync('df', ['-Pk', nearest(dataDir)], { encoding: 'utf8' }).stdout.trim().split('\n').pop().split(/\s+/); row(Number(df[3]) / 1048576 > 2, 'disk free', `${(Number(df[3]) / 1048576).toFixed(1)} GiB`); } catch {}
  if (existsSync(dataDir)) {
    const modeOf = (p) => (statSync(p).mode & 0o777).toString(8);
    row(modeOf(dataDir) === '700', 'data dir perms', modeOf(dataDir));
    if (existsSync(resolve(dataDir, 'access-token'))) row(modeOf(resolve(dataDir, 'access-token')) === '600', 'token perms', modeOf(resolve(dataDir, 'access-token')));
  }
  const envPath = resolve(appRoot, '.env');
  if (existsSync(envPath)) row((statSync(envPath).mode & 0o077) === 0, '.env perms', (statSync(envPath).mode & 0o777).toString(8));
  let up = false; try { up = (await api('/v1/status')).status === 200; } catch {}
  row(up, 'API reachable', up ? base : 'Friday not running', true);
  console.log(bad ? `\n${bad} problem(s).` : '\nNo blocking problems.');
  return bad ? 1 : 0;
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
const table = { start, stop, status, logs: () => logs(rest), doctor, restart: async () => { await stop(); return start(); } };
if (!table[cmd]) { console.error('usage: friday start|stop|restart|status|logs [-f] [N]|doctor'); process.exit(64); }
process.exit(await table[cmd]());
