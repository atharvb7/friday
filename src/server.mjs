import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { Store } from './store.mjs';
import { Memory } from './memory.mjs';
import { Effects } from './effects.mjs';
import { ResourceGovernor } from './resource-governor.mjs';
import { WorkerLoop } from './worker.mjs';
import { DshAdapter } from './dsh.mjs';
import { NemotronProvider } from './nemotron.mjs';
import { ResilientAdapter } from './provider.mjs';
import { ToolRegistry } from './tools.mjs';
import { JevClient } from './jev.mjs';
import { classifyLocal } from './intent.mjs';
import { ChatStore } from './chat.mjs';
import { answerLocal } from './chat-reply.mjs';
import { CodeWork } from './codework.mjs';
import { ResearchStore } from './research.mjs';
import { Scheduler } from './scheduler.mjs';
import { Automations } from './automations.mjs';
import { Audit } from './audit.mjs';
import { VoicePipeline } from './voice.mjs';
import { PetStateMachine } from './pet.mjs';
import { BrowserDriver } from './browser.mjs';
import { RealBrowser } from './browser-live.mjs';
import { WhatsAppFlow } from './whatsapp.mjs';
import { ComputerControlLease, AtSpiDriver, PortalInput } from './desktop.mjs';
import { LiveDesktop } from './desktop-live.mjs';
import { DueRunner } from './scheduler-runner.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Local secrets file (gitignored, 0600). Real env vars win over it.
// Skipped entirely when FRIDAY_NO_DOTENV=1 (tests stay hermetic/offline).
if (process.env.FRIDAY_NO_DOTENV !== '1') loadEnvFile(resolve(appRoot, '.env'));
const dataDir = resolve(process.env.FRIDAY_DATA_DIR ?? resolve(appRoot, 'data'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const tokenPath = resolve(dataDir, 'access-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
chmodSync(tokenPath, 0o600);
const token = readFileSync(tokenPath, 'utf8').trim();
const store = new Store(resolve(dataDir, 'friday.sqlite'));
const memory = new Memory(store);
const effects = new Effects(store);
const host = '127.0.0.1';
const port = Number(process.env.FRIDAY_PORT ?? 4317);

// Phase 1: the governor owns pressure state. Status reports its smoothed
// mode (with hysteresis) instead of a raw instantaneous reading.
// Telemetry is local, bounded, and rotated by the governor itself.
const governor = new ResourceGovernor({
  telemetryPath: resolve(dataDir, 'resource-telemetry.jsonl'),
});
governor.sample();
const governorTimer = setInterval(() => {
  try { governor.sample(); } catch { /* sampling must never crash the service */ }
}, 2000);
governorTimer.unref();

// Isolated DSH adapter: disabled by default until a restricted profile is
// explicitly verified. Set FRIDAY_DSH_VERIFIED=1 + FRIDAY_DSH_PROFILE after
// manual verification; otherwise status stays {ready:false} and the worker
// never claims tasks (safe default, lifecycle still wired).
const dshHome = resolve(dataDir, 'dsh-home');
const dshInner = new DshAdapter({
  homeDir: dshHome,
  profile: process.env.FRIDAY_DSH_PROFILE ?? 'friday-restricted',
  model: process.env.FRIDAY_DSH_MODEL ?? null,
  restrictedVerified: process.env.FRIDAY_DSH_VERIFIED === '1',
  allowEnv: process.env.FRIDAY_NVIDIA_API_KEY ? { NVIDIA_API_KEY: process.env.FRIDAY_NVIDIA_API_KEY } : {},
});
// Resilient execution: capped retries on transient errors + circuit breaker.
// Abort/cancel is never retried; crash-after-commit stays effect_unknown.
const dshAdapter = new ResilientAdapter({ inner: dshInner });
// Chat brain (same architecture, no new authority): Nemotron direct HTTP when
// a key is configured, else the DSH worker path when its binary + verified
// profile exist, else honest local fallback (JEV routing + own stores).
const nemotron = new NemotronProvider({});
// Same retry + circuit-breaker jacket as the worker path: a 503/overload
// retries with backoff instead of surfacing as a failure.
const nemotronResilient = new ResilientAdapter({ inner: nemotron });
function chatBrain() {
  if (nemotron.configured && !emergencyStopped) return { name: 'nemotron-direct', adapter: nemotronResilient };
  try {
    const s = dshAdapter.status();
    if (s.ready && !emergencyStopped) return { name: 'dsh', adapter: dshAdapter };
  } catch {}
  return { name: 'local-fallback', adapter: null };
}
const worker = new WorkerLoop({ store, governor, adapter: dshAdapter });
worker.start();

// Emergency kill-switch latch: POST /v1/emergency-stop aborts the active
// task, stops the worker timer, and blocks new claims until cleared.
let emergencyStopped = false;
let emergencyStoppedAt = null;

// Typed read-only tools, workspace-confined under data/workspace by default
// (FRIDAY_WORKSPACE overrides). Only `safe` tools are exposed via the API;
// gated tools stay code-only until approval UX + policy review land.
const workspaceDir = resolve(process.env.FRIDAY_WORKSPACE ?? resolve(dataDir, 'workspace'));
try { mkdirSync(workspaceDir, { recursive: true, mode: 0o700 }); chmodSync(workspaceDir, 0o700); } catch {}
const tools = new ToolRegistry({ workspace: workspaceDir });

// All-phases wiring (safe defaults; nothing here dials out or injects input).
// JEV router: fast typed classification (choice/score/noul) with local fallback.
const jev = new JevClient({});
// Phase 2: isolated coding workspaces, research pipeline, durable scheduler.
const codework = new CodeWork({ baseDir: resolve(dataDir, 'code-workspaces') });
const research = new ResearchStore({ store });
const scheduler = new Scheduler(store);
// Phase 5: proactive automations (explicit only) + hash-chained audit.
const automations = new Automations(store);
const audit = new Audit(store);
// Phase 4: voice + pet are display/logic-only (no mic/models).
const voice = new VoicePipeline();
const pet = new PetStateMachine('sleeping');
const chat = new ChatStore(store);
// Phase 3: browser + desktop stay disabled scaffolds (honest readiness).
const browser = new BrowserDriver();
const lease = new ComputerControlLease();
const atspi = new AtSpiDriver();
const portal = new PortalInput({ lease });
// Live drivers (fail-closed when binaries/profiles missing — never silent).
const liveBrowser = new RealBrowser();
const liveDesktop = new LiveDesktop({ lease });
const whatsapp = new WhatsAppFlow({ effects, dataDir });
// Scheduler auto-run: due schedules → queued tasks (execution still via
// WorkerLoop + approvals; read-only handoff only).
const dueRunner = new DueRunner({ store, scheduler, governor });
dueRunner.start();
function presence() {
  let petState = 'sleeping';
  try { petState = pet.state ?? petState; } catch {}
  return {
    pet: petState, voice: voice.state ?? 'idle',
    lease: lease.active ? { active: true, expiresAt: lease.active.expiresAt ?? null } : { active: false },
    drivers: { browser: 'scaffold-disabled', atspi: 'not-verified', portal: 'lease-gated', localModel: false },
  };
}

// Loopback-only service: one bucket per source IP is enough, and it doubles
// as cheap brute-force protection for the bearer token.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;
const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateBuckets.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) return true;
  return false;
}

// Static UI: exact-path map only — no directory traversal is possible because
// the request path must match a key and filenames are fixed. Served without
// auth (the token gate lives in app.js); the API below always requires it.
// Pet stage (/pet.html) needs unpkg for Three.js; the main app stays 'self'.
// GLB is served from the repo root (user-supplied model, CC-BY-4.0).
const publicDir = resolve(appRoot, 'public');
const staticAssets = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/voice.js', { file: 'voice.js', type: 'text/javascript; charset=utf-8' }],
  ['/pet.html', { file: 'pet.html', type: 'text/html; charset=utf-8' }],
  ['/pet-viewer.js', { file: 'pet-viewer.js', type: 'text/javascript; charset=utf-8' }],
  ['/pet.css', { file: 'pet.css', type: 'text/css; charset=utf-8' }],
  ['/favicon.ico', { file: 'favicon.svg', type: 'image/svg+xml' }],
  ['/vendor/three.module.js', { file: 'vendor/three.module.js', type: 'text/javascript; charset=utf-8' }],
  ['/vendor/loaders/GLTFLoader.js', { file: 'vendor/loaders/GLTFLoader.js', type: 'text/javascript; charset=utf-8' }],
  ['/vendor/utils/BufferGeometryUtils.js', { file: 'vendor/utils/BufferGeometryUtils.js', type: 'text/javascript; charset=utf-8' }],
  ['/pet.js', { file: 'pet.js', type: 'text/javascript; charset=utf-8' }],
  ['/pet.glb', { abs: resolve(appRoot, 'megaman_x_divemmdortwinkle_girl.glb'), type: 'model/gltf-binary' }],
]);
const STATIC_SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};
function serveStatic(req, res, pathname) {
  const asset = staticAssets.get(pathname);
  if (!asset || req.method !== 'GET') return false;
  let body;
  try { body = readFileSync(asset.abs ?? resolve(publicDir, asset.file)); } catch { return false; }
  const headers = { ...STATIC_SECURITY_HEADERS };
  if (asset.csp) headers['Content-Security-Policy'] = asset.csp;
  res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': body.length, ...headers });
  res.end(body);
  return true;
}

function isAuthorized(req) {
  const candidate = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(data);
}

async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64 * 1024) throw new Error('body_too_large');
  }
  return JSON.parse(text || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (serveStatic(req, res, url.pathname)) return;
  if (isRateLimited(req.socket.remoteAddress ?? 'unknown')) {
    return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  }
  if (!isAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
  try {
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      const snapshot = governor.getSnapshot();
      const adapterStatus = emergencyStopped
        ? { ready: false, reason: 'emergency_stopped', consecutiveFailures: dshAdapter.consecutiveFailures ?? 0 }
        : dshAdapter.status();
      return json(res, 200, {
        name: 'Friday',
        phase: 'phase1',
        resources: snapshot,
        tasks: store.countTasks(),
        worker: { running: worker.current !== null, currentTaskId: worker.current?.taskId ?? null, adapterReady: adapterStatus.ready, adapterReason: adapterStatus.reason ?? null },
        capabilities: { localModel: false, dsh: adapterStatus.ready, computerUse: false, remoteAccess: false },
        provider: { consecutiveFailures: dshAdapter.consecutiveFailures ?? 0, circuitOpen: (dshAdapter.breakerOpenUntil ?? 0) > Date.now() },
        brain: chatBrain().name, nemotronConfigured: nemotron.configured,
        emergencyStopped, emergencyStoppedAt,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/emergency-stop') {
      emergencyStopped = true;
      emergencyStoppedAt = new Date().toISOString();
      if (worker.current?.taskId) {
        worker.cancel(worker.current.taskId);
        try { store.transition(worker.current.taskId, 'cancelled', { error: 'emergency_stop' }); } catch {}
      }
      worker.stop();
      return json(res, 200, { emergencyStopped, emergencyStoppedAt });
    }
    if (req.method === 'POST' && url.pathname === '/v1/emergency-clear') {
      emergencyStopped = false;
      emergencyStoppedAt = null;
      worker.start();
      return json(res, 200, { emergencyStopped });
    }
    if (req.method === 'GET' && url.pathname === '/v1/tasks') return json(res, 200, { tasks: store.listTasks() });
    if (req.method === 'GET' && url.pathname === '/v1/presence') return json(res, 200, { presence: presence(), jevConfigured: jev.configured });
    if (req.method === 'GET' && url.pathname === '/v1/audit/verify') {
      try { return json(res, 200, audit.verify()); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }
    // JEV fast router: typed intent/risk/approval advice, no execution.
    if (req.method === 'POST' && url.pathname === '/v1/route') {
      const body = await bodyJson(req);
      if (typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 20000) return json(res, 400, { error: 'invalid_instruction' });
      const out = await jev.routeInstruction(body.instruction.trim());
      try { audit.append('ad-hoc-local', 'route.decided', { intent: out.intent, needsApproval: out.needsApproval, source: out.source }); } catch {}
      return json(res, 200, { route: out });
    }
    if (req.method === 'GET' && url.pathname === '/v1/schedules') return json(res, 200, { schedules: scheduler.list() });
    if (req.method === 'POST' && url.pathname === '/v1/schedules') {
      const body = await bodyJson(req);
      try { const s = scheduler.schedule(body); try { audit.append(s.task_id ?? 'ad-hoc-local', 'schedule.created', { id: s.id }); } catch {} return json(res, 201, { schedule: s }); }
      catch (error) { return json(res, error.message === 'task_not_found' ? 404 : 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/schedules/due/claim') {
      try { return json(res, 200, { due: scheduler.claimDue() }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    const schedMatch = url.pathname.match(/^\/v1\/schedules\/([A-Za-z0-9_-]+)\/(cancel|done)$/);
    if (schedMatch && req.method === 'POST') {
      try {
        const s = schedMatch[2] === 'cancel' ? scheduler.cancel(schedMatch[1]) : scheduler.done(schedMatch[1]);
        return json(res, 200, { schedule: s });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/v1/research/report') {
      const taskId = url.searchParams.get('taskId') ?? undefined;
      try { return json(res, 200, { report: research.exportReport(taskId) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/research/sources') {
      const body = await bodyJson(req);
      try { return json(res, 201, { source: research.recordSource(body) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/research/claims') {
      const body = await bodyJson(req);
      try { return json(res, 201, { claim: research.recordClaim(body) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/workspaces') {
      try { const ws = codework.createWorkspace(); try { audit.append('ad-hoc-local', 'workspace.created', { id: ws.id ?? ws }); } catch {} return json(res, 201, { workspace: ws }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    const wsMatch = url.pathname.match(/^\/v1\/workspaces\/([A-Za-z0-9_-]+)\/(write|read|diff|test)$/);
    if (wsMatch && (req.method === 'POST' || req.method === 'GET')) {
      const body = req.method === 'POST' ? await bodyJson(req) : Object.fromEntries(url.searchParams.entries());
      try {
        if (wsMatch[2] === 'write') return json(res, 200, { wrote: codework.writeFile(wsMatch[1], body.path, body.content) });
        if (wsMatch[2] === 'read') return json(res, 200, codework.readFile(wsMatch[1], body.path, body.maxBytes ? Number(body.maxBytes) : undefined));
        if (wsMatch[2] === 'diff') return json(res, 200, { diff: codework.gitDiff(wsMatch[1]) });
        const t = codework.runTests(wsMatch[1], body.command ?? 'npm test');
        return json(res, 200, { test: t });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/v1/automations') return json(res, 200, { automations: automations.list() });
    if (req.method === 'POST' && url.pathname === '/v1/automations') {
      const body = await bodyJson(req);
      try { return json(res, 201, { automation: automations.create(body) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/automations/fire') {
      const body = await bodyJson(req);
      try { return json(res, 200, { due: automations.fire(body.trigger ?? body) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    const autoMatch = url.pathname.match(/^\/v1\/automations\/([A-Za-z0-9_-]+)\/kill$/);
    if (autoMatch && req.method === 'POST') {
      try { return json(res, 200, { killed: automations.kill(autoMatch[1]) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    // Live browser snapshot (read-only, dedicated profile, https-only).
    if (req.method === 'GET' && url.pathname === '/v1/browser/snapshot') {
      const target = url.searchParams.get('url') ?? '';
      try { return json(res, 200, { snapshot: await liveBrowser.snapshot(target) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    // WhatsApp staged send: exact-contact allowlist + single-use approval.
    if (req.method === 'POST' && url.pathname === '/v1/whatsapp/stage') {
      const body = await bodyJson(req);
      if (body.taskId && !store.getTask(body.taskId)) return json(res, 404, { error: 'task_not_found' });
      try { return json(res, 201, await whatsapp.stage({ taskId: body.taskId, recipientId: body.recipientId, filePath: body.filePath, caption: body.caption })); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/whatsapp/commit') {
      const body = await bodyJson(req);
      try { return json(res, 200, await whatsapp.commit({ effectId: body.effectId, token: body.approvalToken ?? body.token, exactArgs: body.exactArgs })); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    // Desktop control: revocable lease + fail-closed actuators.
    if (req.method === 'POST' && url.pathname === '/v1/desktop/lease') {
      const body = await bodyJson(req).catch(() => ({}));
      try { return json(res, 201, { lease: lease.request({ reason: body.reason ?? 'user-request', ttlMs: body.ttlMs }) }); }
      catch (error) { return json(res, 409, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/desktop/release') {
      const body = await bodyJson(req).catch(() => ({}));
      try { lease.release(body.leaseId); return json(res, 200, { released: true }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/desktop/activity') {
      lease.revokeOnActivity();
      return json(res, 200, { revoked: true });
    }
    if (req.method === 'POST' && url.pathname === '/v1/desktop/type') {
      const body = await bodyJson(req);
      try { return json(res, 200, await liveDesktop.type(body.leaseId, body.text)); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/desktop/click') {
      const body = await bodyJson(req);
      try { return json(res, 200, await liveDesktop.click(body.leaseId, { x: body.x, y: body.y })); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    // Chat with Friday: JEV routes, deterministic stores answer safe intents,
    // the configured brain answers the rest, local fallback otherwise.
    if (req.method === 'GET' && url.pathname === '/v1/chats') {
      return json(res, 200, { conversations: chat.listConversations() });
    }
    const chatGet = url.pathname.match(/^\/v1\/chat\/([a-f0-9-]+)$/);
    if (chatGet && req.method === 'GET') {
      try {
        return json(res, 200, { conversation: chat.getConversation(chatGet[1]), messages: chat.listMessages(chatGet[1]) });
      } catch (error) { return json(res, 404, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat') {
      const body = await bodyJson(req);
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 20000) {
        return json(res, 400, { error: 'invalid_message' });
      }
      const text = body.message.trim();
      let convo = null;
      if (body.conversationId !== undefined && body.conversationId !== null) {
        convo = chat.getConversation(body.conversationId);
        if (!convo) return json(res, 404, { error: 'conversation_not_found' });
      } else {
        convo = chat.createConversation(text.slice(0, 60));
      }
      chat.addMessage(convo.id, 'user', text);
      // JEV stays disconnected unless explicitly enabled; local classifier
      // is the default router (no network, deterministic).
      const route = process.env.FRIDAY_JEV_ENABLED === '1'
        ? await jev.routeInstruction(text)
        : classifyLocal(text);
      let reply = '';
      let chatModel = null;
      const brain = chatBrain();
      // With a live brain, real conversation goes to Nemotron — only exact
      // memory/file stores stay deterministic-local. Without a brain, safe
      // intents run inline and agent work becomes a durable queued task.
      // Only genuinely consequential acts get the approval lecture.
      const DETERMINISTIC_LOCAL = new Set(['memory', 'file_search', 'file_read']);
      const QUEUE_AS_TASK = new Set(['coding', 'research', 'browser', 'desktop', 'voice']);
      try {
        if (route.riskScore >= 3) {
          reply = (await answerLocal({ ...route, needsApproval: true }, text, { memory, tools })).text;
        } else if (DETERMINISTIC_LOCAL.has(route.intent)) {
          reply = (await answerLocal(route, text, { memory, tools })).text;
        } else if (!brain.adapter && QUEUE_AS_TASK.has(route.intent)) {
          const task = store.createTask({ title: text.slice(0, 200), instruction: text });
          reply = `Got it — I’ve queued that as task “${task.title}” and I’ll work through it as soon as my agent runtime is connected. Anything read-only (files, memory) I can still do right now — just ask.`;
        } else if (brain.adapter) {
          const history = chat.historyForProvider(convo.id, 20);
          const out = await brain.adapter.run({ taskId: convo.id, instruction: text, messages: history });
          if (out.status === 'completed') {
            reply = out.output;
            chatModel = out.model ?? null;
          } else {
            // Honest failure: never silently substitute a canned greeting.
            reply = `My Nemotron brain didn’t answer (${out.error}). I can still do local things right now — memory, files, tasks — or try again in a bit.`;
          }
        } else {
          reply = (await answerLocal(route, text, { memory, tools })).text;
        }
      } catch (error) {
        reply = `Something hiccuped on my side (${error.message}). Your message is saved — try again?`;
      }
      chat.addMessage(convo.id, 'assistant', reply.slice(0, 20000));
      try { audit.append(convo.id, 'chat.reply', { intent: route.intent, brain: brain.name, source: route.source }); } catch {}
      try { pet.transition('wake'); } catch {}
      try { pet.transition('hear'); } catch {}
      return json(res, 200, { conversation: chat.getConversation(convo.id), route, reply, brain: brain.name, model: chatModel });
    }
    if (req.method === 'GET' && url.pathname === '/v1/tools') return json(res, 200, { tools: tools.list() });
    if (req.method === 'POST' && url.pathname === '/v1/tools/run') {
      const body = await bodyJson(req);
      if (typeof body.tool !== 'string' || !body.tool || typeof body.args !== 'object' || body.args === null || Array.isArray(body.args)) return json(res, 400, { error: 'invalid_tool_call' });
      const entry = tools.list().find(t => t.name === body.tool);
      if (!entry) return json(res, 404, { error: 'unknown_tool' });
      if (entry.permission !== 'safe') return json(res, 403, { error: 'tool_not_exposed' });
      let taskId = 'ad-hoc-local';
      if (body.taskId !== undefined && body.taskId !== null) {
        if (typeof body.taskId !== 'string' || !store.getTask(body.taskId)) return json(res, 404, { error: 'task_not_found' });
        taskId = body.taskId;
      }
      try {
        const out = await tools.run({ taskId, tool: body.tool, args: body.args, effects });
        return json(res, 200, { tool: out.tool, result: out.result });
      } catch (error) {
        if (error instanceof TypeError) return json(res, 400, { error: error.message });
        throw error;
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/memory') return json(res, 200, { memories: memory.list() });
    if (req.method === 'GET' && url.pathname === '/v1/memory/search') {
      try { return json(res, 200, { memories: memory.search(url.searchParams.get('q') ?? '') }); }
      catch (error) { if (error instanceof TypeError) return json(res, 400, { error: error.message }); throw error; }
    }
    if (req.method === 'POST' && url.pathname === '/v1/memory') {
      const body = await bodyJson(req);
      try { return json(res, 201, { memory: memory.create(body) }); }
      catch (error) { if (error instanceof TypeError) return json(res, 400, { error: error.message }); throw error; }
    }
    const memoryMatch = url.pathname.match(/^\/v1\/memory\/([a-f0-9-]+)$/);
    if (memoryMatch && req.method === 'DELETE') {
      const deleted = memory.delete(memoryMatch[1]);
      return json(res, deleted ? 200 : 404, { deleted });
    }
    if (req.method === 'POST' && url.pathname === '/v1/tasks') {
      const body = await bodyJson(req);
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 20000) return json(res, 400, { error: 'invalid_task' });
      const key = req.headers['idempotency-key'];
      if (key && (typeof key !== 'string' || key.length > 200)) return json(res, 400, { error: 'invalid_idempotency_key' });
      const task = store.createTask({ title: body.title.trim(), instruction: body.instruction.trim(), idempotencyKey: key ?? null });
      return json(res, 201, { task });
    }
    const match = url.pathname.match(/^\/v1\/tasks\/([a-f0-9-]+)(?:\/(events|effects|cancel))?$/);
    if (match) {
      const task = store.getTask(match[1]);
      if (!task) return json(res, 404, { error: 'not_found' });
      if (req.method === 'GET' && !match[2]) return json(res, 200, { task });
      if (req.method === 'GET' && match[2] === 'events') return json(res, 200, { events: store.listEvents(task.id) });
      if (req.method === 'GET' && match[2] === 'effects') return json(res, 200, { effects: effects.list(task.id) });
      if (req.method === 'POST' && match[2] === 'cancel') {
        worker.cancel(task.id);
        const result = store.transition(task.id, 'cancelled');
        return result.error ? json(res, 409, result) : json(res, 200, result);
      }
      // Phase 1 approval flow: propose+stage+request in one call (no outbound
      // sink yet). Returns the single-use approvalToken once; UI approves next.
      if (req.method === 'POST' && match[2] === 'effects') {
        const body = await bodyJson(req);
        if (typeof body.kind !== 'string' || typeof body.exactArgs !== 'object' || body.exactArgs === null || Array.isArray(body.exactArgs)) return json(res, 400, { error: 'invalid_effect' });
        try {
          const proposed = effects.propose(task.id, body.kind, body.exactArgs);
          effects.stage(proposed.id, body.exactArgs);
          const { effect, token: approvalToken } = effects.requestApproval(proposed.id);
          return json(res, 201, { effect, approvalToken, approvalExpiresAt: effect.approval_expires_at });
        } catch (error) {
          if (error instanceof TypeError) return json(res, 400, { error: error.message });
          return json(res, 400, { error: error.message });
        }
      }
    }
    const effectMatch = url.pathname.match(/^\/v1\/effects\/([a-f0-9-]+)\/(approve)$/);
    if (effectMatch && req.method === 'POST') {
      const body = await bodyJson(req);
      if (typeof body.approvalToken !== 'string' || typeof body.exactArgs !== 'object' || body.exactArgs === null) return json(res, 400, { error: 'invalid_approval' });
      try {
        const effect = effects.approve(effectMatch[1], body.approvalToken, body.exactArgs);
        return json(res, 200, { effect });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    const effectGet = url.pathname.match(/^\/v1\/effects\/([a-f0-9-]+)$/);
    if (effectGet && req.method === 'GET') {
      const effect = effects.get(effectGet[1]);
      if (!effect) return json(res, 404, { error: 'not_found' });
      const { approval_hash, ...publicEffect } = effect;
      void approval_hash;
      return json(res, 200, { effect: publicEffect });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    return json(res, error.message === 'body_too_large' ? 413 : error instanceof SyntaxError ? 400 : 500, { error: error.message === 'body_too_large' ? 'body_too_large' : error instanceof SyntaxError ? 'invalid_json' : 'internal_error' });
  }
});

server.listen(port, host, () => console.log(`Friday core listening on http://${host}:${port}`));
server.on('error', error => {
  console.error(`Friday core failed to listen: ${error.message}`);
  try { store.close(); } catch {}
  process.exitCode = 1;
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
  clearInterval(governorTimer);
  server.close(() => { try { store.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { store.close(); } catch {} process.exit(0); }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
