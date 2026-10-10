// Composition root: builds every Friday service once and owns their lifecycle.
// Route modules receive this object and never construct services themselves.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Store } from './store.mjs';
import { Memory } from './memory.mjs';
import { Effects } from './effects.mjs';
import { ResourceGovernor, PROFILES } from './resource-governor.mjs';
import { WorkerLoop } from './worker.mjs';
import { DshAdapter } from './dsh.mjs';
import { NemotronProvider } from './nemotron.mjs';
import { ResilientAdapter } from './provider.mjs';
import { ToolRegistry } from './tools.mjs';
import { JevClient } from './jev.mjs';
import { ChatStore } from './chat.mjs';
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
import { EventBus } from './events.mjs';
import { Auth } from './auth.mjs';
import { OpenAICompatProvider } from './ai/openai-compat.mjs';
import { ModelRouter, chainsFromEnv } from './ai/router.mjs';
import { MemoryIndexer } from './ai/memory-indexer.mjs';
import { Settings } from './settings.mjs';
import { ContextBuilder } from './agent/context-builder.mjs';
import { buildFridayTools } from './agent/friday-tools.mjs';
import { Brain } from './agent/brain.mjs';
import { Notifications } from './notifications.mjs';
import { Jobs } from './jobs.mjs';
import { Proactive } from './proactive.mjs';
import { Policy } from './policy.mjs';
import { Approvals } from './approvals.mjs';
import { Skills } from './skills.mjs';
import { loadMcpConfig, renderOverlay, envToForward, withDefaults } from './mcp-config.mjs';
import { ResearchMemory } from './research-memory.mjs';
import { NodeHub } from './nodes.mjs';
import { WebPush } from './webpush.mjs';
import { Companion } from './companion.mjs';
import { VoiceServer } from './voice-server.mjs';
import { KindRouterAdapter } from './adapters.mjs';
import { ComputerAgent } from './agent/computer-agent.mjs';

function findDshBin() {
  const r = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return realpathSync(r.stdout.trim()); } catch { return null; }
}

export function createContext({ appRoot, env = process.env }) {
  const dataDir = resolve(env.FRIDAY_DATA_DIR ?? resolve(appRoot, 'data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const tokenPath = resolve(dataDir, 'access-token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(tokenPath, 0o600);
  const token = readFileSync(tokenPath, 'utf8').trim();

  const store = new Store(resolve(dataDir, 'friday.sqlite'));
  const bus = new EventBus();
  store.onEvent = ({ taskId, kind, detail }) => bus.publish(kind, { taskId, ...detail });
  const memory = new Memory(store);
  const effects = new Effects(store);

  // The governor owns pressure state (hysteresis); telemetry is bounded + rotated.
  const governor = new ResourceGovernor({ telemetryPath: resolve(dataDir, 'resource-telemetry.jsonl'), thresholds: PROFILES[env.FRIDAY_RESOURCE_PROFILE ?? 'laptop'] ?? {} });
  governor.sample();

  // Agent runtime (DSH): isolated home, sandboxed, minimal env. See src/dsh.mjs.
  const dshBin = env.FRIDAY_DSH_BIN || findDshBin();
  const mcpPath = resolve(dataDir, 'config', 'mcp.json');
  const skills = new Skills({ roots: [resolve(appRoot, 'skills'), resolve(dataDir, 'skills')] });
  const overlayPath = resolve(dataDir, 'dsh-home', 'friday-overlay.yml');
  const dshPrepare = () => {
    const cfg = withDefaults(loadMcpConfig(mcpPath), env);
    writeFileSync(overlayPath, renderOverlay(cfg), { mode: 0o600 });
    skills.syncTo(resolve(dataDir, 'dsh-home', 'skills'));
    const extraEnv = {};
    for (const name of envToForward(cfg)) if (env[name]) extraEnv[name] = env[name];
    return { overlayPath, extraEnv };
  };
  const dshInner = new DshAdapter({
    prepare: dshPrepare,
    homeDir: resolve(dataDir, 'dsh-home'),
    workRoot: resolve(dataDir, 'dsh-workspaces'),
    bin: dshBin,
    model: env.FRIDAY_DSH_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b',
    apiKey: env.FRIDAY_NVIDIA_API_KEY ?? null,
    enabled: env.FRIDAY_DSH_ENABLED !== '0',
    sandbox: env.FRIDAY_DSH_SANDBOX === 'off' ? 'off' : 'bwrap',
    appRoot, dataDir,
    timeoutMs: env.FRIDAY_DSH_TIMEOUT_MS ? Number(env.FRIDAY_DSH_TIMEOUT_MS) : undefined,
  });
  const dshAdapter = new ResilientAdapter({ inner: dshInner, maxAttempts: 1 }) // never auto-retry an agent run: tool calls may have had side effects;
  const nemotron = new NemotronProvider({});
  const nemotronResilient = new ResilientAdapter({ inner: nemotron });
  const kindRouter = new KindRouterAdapter({ byKind: { agent: dshAdapter, research: dshAdapter, coding: dshAdapter } });
  const worker = new WorkerLoop({ store, governor, adapter: kindRouter, maxConcurrent: Number(env.FRIDAY_WORKER_CONCURRENCY ?? 1), onEvent: (e) => bus.publish(e.kind === 'task.running' ? 'worker.claimed' : e.kind, e) });

  const workspaceDir = resolve(env.FRIDAY_WORKSPACE ?? resolve(dataDir, 'workspace'));
  try { mkdirSync(workspaceDir, { recursive: true, mode: 0o700 }); chmodSync(workspaceDir, 0o700); } catch {}

  const lease = new ComputerControlLease();
  const scheduler = new Scheduler(store);
  // Model router: providers are interchangeable; nothing else names a vendor.
  const ai = new ModelRouter({ db: store.db, bus, chains: chainsFromEnv(env) });
  ai.register(new OpenAICompatProvider({ name: 'nvidia', baseUrl: env.FRIDAY_NEMOTRON_BASE_URL ?? 'https://integrate.api.nvidia.com/v1', apiKey: env.FRIDAY_NVIDIA_API_KEY ?? null }));
  if (env.FRIDAY_FALLBACK_BASE_URL && env.FRIDAY_FALLBACK_API_KEY) {
    ai.register(new OpenAICompatProvider({ name: 'fallback', baseUrl: env.FRIDAY_FALLBACK_BASE_URL, apiKey: env.FRIDAY_FALLBACK_API_KEY }));
  }
  const settings = new Settings(store);
  const indexer = new MemoryIndexer({ memory, ai, bus });
  memory.onChange = (event, row) => { bus.publish(`memory.${event}`, { id: row.id }); indexer.kick(); };

  const ctx = {
    appRoot, env, dataDir, token,
    bus, auth: new Auth(store, token), ai, settings, indexer, skills, mcpPath,
    store, memory, effects, governor, worker, dshAdapter, nemotron, nemotronResilient,
    tools: new ToolRegistry({ workspace: workspaceDir }),
    jev: new JevClient({}),
    chat: new ChatStore(store),
    codework: new CodeWork({ baseDir: resolve(dataDir, 'code-workspaces') }),
    research: new ResearchStore({ store }),
    scheduler,
    automations: new Automations(store),
    audit: new Audit(store),
    voice: new VoicePipeline(),
    pet: new PetStateMachine('sleeping'),
    browser: new BrowserDriver(),
    lease,
    atspi: new AtSpiDriver(),
    portal: new PortalInput({ lease }),
    liveBrowser: new RealBrowser(),
    liveDesktop: new LiveDesktop({ lease }),
    whatsapp: new WhatsAppFlow({ effects, dataDir }),
    dueRunner: new DueRunner({ store, scheduler, governor }),
    // Kill-switch latch: set via POST /v1/emergency-stop, cleared explicitly.
    state: { emergencyStopped: false, emergencyStoppedAt: null },
  };

  // Chat brain: Nemotron direct when keyed, else the DSH worker path when
  // verified, else honest local fallback.
  ctx.chat.onMessage = ({ conversationId, role }) => bus.publish('chat.message', { conversationId, role });
  ctx.notifications = new Notifications(store, bus);
  ctx.push = new WebPush({ store, settings, subject: env.FRIDAY_PUSH_SUBJECT ?? 'mailto:friday@localhost' });
  bus.subscribe((e) => { if (e.type === 'notification.created') void ctx.push.send({ title: e.data.title, body: e.data.body, tag: e.data.id }); });
  // Task finished -> tell the user where they asked (chat) and in the inbox.
  const prevOnEvent = store.onEvent;
  store.onEvent = (e) => {
    prevOnEvent?.(e);
    if (!['task.completed', 'task.failed', 'task.blocked'].includes(e.kind)) return;
    const t = store.getTask(e.taskId);
    if (!t) return;
    const ok = e.kind === 'task.completed';
    const body = ok ? String(t.result ?? '').slice(0, 1500) : String(t.error ?? e.kind).slice(0, 500);
    ctx.notifications.create({ level: ok ? 'success' : e.kind === 'task.failed' ? 'error' : 'warning', title: `${ok ? 'Done' : e.kind === 'task.failed' ? 'Failed' : 'Blocked'}: ${t.title}`, body, taskId: t.id, conversationId: t.conversation_id });
    if (t.conversation_id && ctx.chat.getConversation(t.conversation_id)) {
      ctx.chat.addMessage(t.conversation_id, 'assistant', ok ? `✅ Finished “${t.title}”:\n\n${body || '(no output)'}` : `⚠️ “${t.title}” ${e.kind === 'task.failed' ? 'failed' : 'was blocked'}: ${body}`);
    }
  };
  ctx.nodes = new NodeHub({ bus });
  ctx.researchMemory = new ResearchMemory({ store, bus });
  { // finished research tasks are ingested into persistent research memory
    const prev = store.onEvent;
    store.onEvent = (e) => {
      prev?.(e);
      if (e.kind !== 'task.completed') return;
      const t = store.getTask(e.taskId);
      if (t?.kind !== 'research') return;
      try {
        const r = ctx.researchMemory.ingestFromDir({ taskId: t.id, dir: dshInner.pathFor(t.id, t.workspace) });
        ctx.notifications.create({ level: 'success', title: `Research saved: ${r.topic}`, body: `${r.sources} sources, ${r.claims} claims, ${r.contradictions} contradiction(s) stored.`, taskId: t.id, conversationId: t.conversation_id });
      } catch (error) {
        ctx.notifications.create({ level: 'warning', title: `Research finished but not saved: ${t.title}`, body: `The agent did not leave a valid findings.json (${String(error.message).slice(0, 120)}). The report text is still in the task result.`, taskId: t.id });
      }
    };
  }
  ctx.companion = new Companion({ ctx });
  ctx.voiceServer = new VoiceServer({ env, governor });
  ctx.jobs = new Jobs({ store, notifications: ctx.notifications, chat: ctx.chat, bus, settings });
  ctx.policy = new Policy({ settings, bus });
  ctx.approvals = new Approvals({ store, notifications: ctx.notifications, chat: ctx.chat, bus, audit: ctx.audit });
  ctx.proactive = new Proactive({
    store, notifications: ctx.notifications, jobs: ctx.jobs, ai, memory, settings, bus, dataDir,
    agentReady: () => ctx.dshAdapter.status().ready,
  });
  kindRouter.byKind.computer = new ComputerAgent({ ai, nodes: ctx.nodes, policy: ctx.policy, approvals: ctx.approvals, bus, audit: ctx.audit });
  ctx.fridayTools = buildFridayTools(ctx);
  { // gated tools get their approved-execution path registered automatically
    const register = ctx.fridayTools.register;
    ctx.fridayTools.register = (tool) => { register(tool); if (tool.risk !== 'safe') ctx.approvals.register(tool.name, tool.run); };
    for (const tool of ctx.fridayTools.list()) if (tool.risk !== 'safe') ctx.approvals.register(tool.name, tool.run);
  }
  ctx.brain = new Brain({
    ai, fridayTools: ctx.fridayTools, settings, chat: ctx.chat, bus, audit: ctx.audit, skills, policy: ctx.policy, approvals: ctx.approvals,
    contextBuilder: new ContextBuilder({ memory, store, indexer, researchMemory: ctx.researchMemory }),
  });
  ctx.chatBrain = () => {
    if (ai.hasProvider && !ctx.state.emergencyStopped) return { name: 'friday-brain', adapter: ctx.brain };
    if (ctx.nemotron.configured && !ctx.state.emergencyStopped) return { name: 'nemotron-direct', adapter: ctx.nemotronResilient };
    try {
      if (ctx.dshAdapter.status().ready && !ctx.state.emergencyStopped) return { name: 'dsh', adapter: ctx.dshAdapter };
    } catch {}
    return { name: 'local-fallback', adapter: null };
  };

  let governorTimer = null;
  ctx.start = () => {
    let lastMode = governor.getSnapshot().mode;
    governorTimer = setInterval(() => {
      try {
        const snap = governor.sample();
        if (snap.mode !== lastMode) { bus.publish('resource.mode_changed', { from: lastMode, to: snap.mode }); lastMode = snap.mode; }
      } catch { /* never crash on sampling */ }
    }, 2000);
    governorTimer.unref();
    try { skills.syncTo(resolve(dataDir, 'dsh-home', 'skills')); } catch {}
    worker.start();
    ctx.dueRunner.start();
    if (ai.hasProvider) indexer.start();
    ctx.jobs.start();
    ctx.proactive.start();
  };
  ctx.stop = () => {
    worker.stop();
    ctx.nodes?.stopAll();
    clearInterval(governorTimer);
    try { ctx.dueRunner.stop?.(); } catch {}
    indexer.stop();
    ctx.jobs.stop();
    ctx.proactive.stop();
    try { store.close(); } catch {}
  };
  return ctx;
}
