// Agent runner: runs inside its OWN container (no Friday data, no host mounts, egress only via the
// filtering proxy). Friday core sends it tasks over an internal network; the container boundary is
// the sandbox, so DSH runs with full permissions *inside* it as an unprivileged user.
//   POST /run   (Bearer secret)  -> NDJSON stream: {t:'trace'|'result', ...}
//   GET  /health (Bearer secret) -> {ready, active, max}
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';
import { DshAdapter } from '../src/dsh.mjs';
import { ensureRealDir, readRegularFile, writeFileReplacing } from '../src/safefs.mjs';

const env = process.env;
const SECRET = env.FRIDAY_AGENT_SECRET;
if (!SECRET || SECRET.length < 24) { console.error('FRIDAY_AGENT_SECRET (>=24 chars) is required'); process.exit(2); }
const HOME = env.AGENT_HOME ?? '/agent/home';
const WORK = env.AGENT_WORK ?? '/agent/work';
const STATE = env.AGENT_STATE ?? '/agent/state';
const MAX = Number(env.AGENT_MAX_CONCURRENT ?? 2);
const PORT = Number(env.AGENT_PORT ?? 4320);
const FORWARD_ENV = ['SERPAPI_API_KEY', 'GITHUB_TOKEN']; // only these may be referenced by MCP overlays
const MAX_BODY = 4 * 1024 * 1024;

for (const d of [HOME, WORK, STATE]) ensureRealDir(d);
const adapter = new DshAdapter({
  homeDir: HOME, workRoot: WORK, agentsHome: join(STATE, 'agents'), bin: env.DSH_BIN, apiKey: env.FRIDAY_NVIDIA_API_KEY ?? null,
  model: env.FRIDAY_DSH_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b', sandbox: 'off', enabled: env.FRIDAY_DSH_ENABLED !== '0',
  timeoutMs: env.FRIDAY_DSH_TIMEOUT_MS ? Number(env.FRIDAY_DSH_TIMEOUT_MS) : undefined,
});
let active = 0;

const authed = (req) => { const a = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, '')), b = Buffer.from(SECRET); return a.length === b.length && timingSafeEqual(a, b); };
const json = (res, status, body) => { const d = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }); res.end(d); };

async function readJson(req) {
  let text = ''; for await (const c of req) { text += c; if (text.length > MAX_BODY) throw new Error('body_too_large'); }
  return JSON.parse(text || '{}');
}

// Skills arrive as { "name/SKILL.md": base64 }. Only plain relative paths are accepted.
function writeSkills(skills) {
  const root = join(STATE, 'agents', 'skills');
  rmSync(root, { recursive: true, force: true }); ensureRealDir(root);
  for (const [rel, b64] of Object.entries(skills ?? {})) {
    const p = normalize(rel);
    if (isAbsolute(p) || p.startsWith('..') || p.split('/').some((s) => s.startsWith('.')) || !/^[A-Za-z0-9._/-]{1,200}$/.test(p)) continue;
    const dest = join(root, p); ensureRealDir(join(dest, '..'));
    writeFileReplacing(dest, Buffer.from(String(b64), 'base64'));
  }
}

createServer(async (req, res) => {
  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && req.url === '/health') { const s = adapter.status(); return json(res, 200, { ready: s.ready, reason: s.reason ?? null, model: s.model ?? null, active, max: MAX }); }
  if (req.method !== 'POST' || req.url !== '/run') return json(res, 404, { error: 'not_found' });
  if (active >= MAX) return json(res, 429, { error: 'runner_busy' });
  let body;
  try { body = await readJson(req); } catch (e) { return json(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message }); }
  if (typeof body.instruction !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(String(body.taskId))) return json(res, 400, { error: 'invalid_request' });
  if (body.workspace != null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.workspace)) return json(res, 400, { error: 'invalid_workspace' });

  active++;
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(new Error('client_closed')); });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const send = (o) => { try { res.write(`${JSON.stringify(o)}\n`); } catch { /* client gone */ } };
  try {
    adapter.prepare = () => {
      let overlayPath = null; const extraEnv = {};
      if (typeof body.overlay === 'string' && body.overlay.length < 100_000) {
        overlayPath = join(STATE, `overlay-${body.taskId}.yml`); writeFileReplacing(overlayPath, body.overlay);
        for (const n of FORWARD_ENV) if (env[n] && body.overlay.includes(`process.env.${n}`)) extraEnv[n] = env[n];
      }
      writeSkills(body.skills);
      return { overlayPath, extraEnv };
    };
    const result = await adapter.run({ taskId: body.taskId, instruction: body.instruction, kind: body.kind ?? 'agent', workspace: body.workspace ?? null, signal: ctrl.signal, onTrace: (kind, detail) => send({ t: 'trace', kind, detail }) });
    const files = {};
    if (result.status === 'completed' && body.kind === 'research' && result.workDir) {
      for (const f of ['findings.json', 'report.md']) { try { files[f] = readRegularFile(join(result.workDir, f), 2 * 1024 * 1024).toString('utf8'); } catch { /* optional */ } }
    }
    send({ t: 'result', status: result.status, output: result.output ?? null, error: result.error ?? null, tokens: result.tokens ?? 0, files });
  } catch (e) {
    send({ t: 'result', status: ctrl.signal.aborted ? 'aborted' : 'failed', error: ctrl.signal.aborted ? 'cancelled' : String(e.message).slice(0, 300), files: {} });
  } finally { active--; try { rmSync(join(STATE, `overlay-${body.taskId}.yml`), { force: true }); } catch {} res.end(); }
}).listen(PORT, '0.0.0.0', () => console.log(`agent runner on :${PORT} (max ${MAX} concurrent)`));
process.on('SIGTERM', () => process.exit(0));
