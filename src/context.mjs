// Composition root: builds every Friday service once and owns their lifecycle.
// Route modules receive this object and never construct services themselves.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { ensureRealDir, writeFileReplacing } from './safefs.mjs';
import { Store } from './store.mjs';
import { Memory } from './memory.mjs';
import { Effects } from './effects.mjs';
import { ResourceGovernor, PROFILES } from './resource-governor.mjs';
import { WorkerLoop } from './worker.mjs';
import { DshAdapter } from './dsh.mjs';
import { RemoteDshAdapter, packSkills } from './dsh-remote.mjs';
import { NemotronProvider } from './nemotron.mjs';
import { ResilientAdapter } from './provider.mjs';
import { ToolRegistry } from './tools.mjs';
import { JevClient } from './jev.mjs';
import { ChatStore } from './chat.mjs';
import { Rules } from './rules.mjs';
import { Audit } from './audit.mjs';
import { EventBus } from './events.mjs';
import { Auth } from './auth.mjs';
import { OpenAICompatProvider } from './ai/openai-compat.mjs';
import { ModelRouter, chainsFromEnv, thinkingRolesFromEnv } from './ai/router.mjs';
import { MemoryIndexer } from './ai/memory-indexer.mjs';
import { Settings } from './settings.mjs';
import { ContextBuilder } from './agent/context-builder.mjs';
import { buildFridayTools } from './agent/friday-tools.mjs';
import { ToolRouter, toolsLoadTool } from './agent/toolsets.mjs';
import { Commitments, commitmentTools } from './commitments.mjs';
import { Brain } from './agent/brain.mjs';
import { Notifications } from './notifications.mjs';
import { Mood } from './mood.mjs';
import { Habits } from './habits.mjs';
import { AutoMemory } from './agent/auto-memory.mjs';
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
import { prune } from './retention.mjs';
import { VoiceServer } from './voice-server.mjs';
import { KindRouterAdapter } from './adapters.mjs';
import { ComputerAgent } from './agent/computer-agent.mjs';
import { Profile } from './profile.mjs';
import { HermesAdapter } from './hermes.mjs';
import { TeamOrchestrator } from './agent/team.mjs';
import { Learner } from './agent/learning.mjs';
import { Watches } from './watches.mjs';
import { Pipeline } from './pipeline.mjs';
import { SalesJudge } from './sales-judge.mjs';
import { Prospector } from './prospector.mjs';
import { Composio } from './composio.mjs';
import { Files } from './files.mjs';
import { Documents } from './documents.mjs';
import { Images } from './images.mjs';
import { DmChats } from './dm-chat.mjs';
import { GoogleAuth, Gmail } from './google.mjs';
import { OwnerLogin } from './login.mjs';
import { Users } from './users.mjs';
import { Deployer } from './deployer.mjs';
import { ReelPipeline } from './reel.mjs';
import { Questions } from './questions.mjs';

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
  const overlayPath = resolve(dataDir, 'config', 'friday-overlay.yml'); // host-only: the agent can read it (ro) but never write it
  const agentsSkillsDir = resolve(dataDir, 'dsh-agents', 'skills');
  const dshPrepare = () => {
    const cfg = withDefaults(loadMcpConfig(mcpPath), env);
    ensureRealDir(dirname(overlayPath));
    writeFileReplacing(overlayPath, renderOverlay(cfg));
    skills.syncTo(agentsSkillsDir);
    const extraEnv = {};
    for (const name of envToForward(cfg)) if (env[name]) extraEnv[name] = env[name];
    return { overlayPath, extraEnv };
  };
  let dshInner;
  if (env.FRIDAY_AGENT_URL) {
    // Containerised deployment: agents run in a separate, isolated container (no Friday data, filtered egress).
    dshInner = new RemoteDshAdapter({
      url: env.FRIDAY_AGENT_URL, secret: env.FRIDAY_AGENT_SECRET ?? '',
      prepare: () => {
        const cfg = withDefaults(loadMcpConfig(mcpPath), env);
        return { overlay: renderOverlay(cfg), skills: packSkills(skills) };
      },
    });
  } else {
    dshInner = new DshAdapter({
      prepare: dshPrepare,
      homeDir: resolve(dataDir, 'dsh-home'),
      workRoot: resolve(dataDir, 'dsh-workspaces'),
      bin: dshBin,
      model: env.FRIDAY_DSH_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      apiKey: env.FRIDAY_NVIDIA_API_KEY ?? null,
      enabled: env.FRIDAY_DSH_ENABLED !== '0',
      sandbox: env.FRIDAY_DSH_SANDBOX === 'off' ? 'off' : 'bwrap',
      appRoot, dataDir,
      timeoutMs: env.FRIDAY_DSH_TIMEOUT_MS ? Number(env.FRIDAY_DSH_TIMEOUT_MS) : undefined,
    });
  }
  const dshAdapter = new ResilientAdapter({ inner: dshInner, maxAttempts: 1 }) // never auto-retry an agent run: tool calls may have had side effects;
  const nemotron = new NemotronProvider({});
  const nemotronResilient = new ResilientAdapter({ inner: nemotron });
  const kindRouter = new KindRouterAdapter({ byKind: { agent: dshAdapter, research: dshAdapter, coding: dshAdapter } });
  const worker = new WorkerLoop({ store, governor, adapter: kindRouter, maxConcurrent: Number(env.FRIDAY_WORKER_CONCURRENCY ?? 1), onEvent: (e) => bus.publish(e.kind === 'task.running' ? 'worker.claimed' : e.kind, e) });

  const workspaceDir = resolve(env.FRIDAY_WORKSPACE ?? resolve(dataDir, 'workspace'));
  try { mkdirSync(workspaceDir, { recursive: true, mode: 0o700 }); chmodSync(workspaceDir, 0o700); } catch {}

  // Model router: providers are interchangeable; nothing else names a vendor.
  const ai = new ModelRouter({ db: store.db, bus, chains: chainsFromEnv(env), thinkingRoles: thinkingRolesFromEnv(env) });
  ai.register(new OpenAICompatProvider({ name: 'nvidia', baseUrl: env.FRIDAY_NEMOTRON_BASE_URL ?? 'https://integrate.api.nvidia.com/v1', apiKey: env.FRIDAY_NVIDIA_API_KEY ?? null, noThinking: { chat_template_kwargs: { enable_thinking: false } } }));
  // Gemini's OpenAI-compatible endpoint. 'low' is the lowest thinking level every current Flash accepts (3.8 refuses minimal).
  ai.register(new OpenAICompatProvider({ name: 'gemini', baseUrl: env.FRIDAY_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: env.FRIDAY_GEMINI_API_KEY ?? null,
    noThinking: { reasoning_effort: 'low' }, thoughtSignatures: true, alwaysStream: true, stallMs: 30_000, timeoutMs: 120_000 }));
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
    audit: new Audit(store),
    // Kill-switch latch: set via POST /v1/emergency-stop, cleared explicitly.
    state: { emergencyStopped: false, emergencyStoppedAt: null },
  };

  // Chat brain: Nemotron direct when keyed, else the DSH worker path when
  // verified, else honest local fallback.
  ctx.chat.onMessage = ({ conversationId, role, id }) => bus.publish('chat.message', { conversationId, role, id });
  ctx.notifications = new Notifications(store, bus);
  ctx.push = new WebPush({ store, settings, subject: env.FRIDAY_PUSH_SUBJECT ?? 'mailto:friday@localhost' });
  bus.subscribe((e) => { if (e.type === 'notification.created') void ctx.push.send({ title: e.data.title, body: e.data.body, tag: e.data.id }); });
  // Task finished -> tell the user where they asked (chat) and in the inbox.
  const prevOnEvent = store.onEvent;
  store.onEvent = (e) => {
    prevOnEvent?.(e);
    if (!['task.completed', 'task.failed', 'task.blocked'].includes(e.kind)) return;
    const t = store.getTask(e.taskId);
    if (!t || String(t.kind).startsWith('sub:') || t.kind === 'watch') return; // team subtasks report through their parent
    const ok = e.kind === 'task.completed';
    const full = ok ? String(t.result ?? '') : String(t.error ?? e.kind);
    const body = full.slice(0, ok ? 1500 : 500);
    ctx.notifications.create({ level: ok ? 'success' : e.kind === 'task.failed' ? 'error' : 'warning', title: `${ok ? 'Done' : e.kind === 'task.failed' ? 'Failed' : 'Blocked'}: ${t.title}`, body, taskId: t.id, conversationId: t.conversation_id });
    if (t.conversation_id && ctx.chat.getConversation(t.conversation_id)) {
      ctx.chat.addMessage(t.conversation_id, 'assistant', ok ? `**✅ Done — ${t.title}**\n\n${full.slice(0, 8000) || '(no output)'}` : `**⚠️ ${e.kind === 'task.failed' ? 'Failed' : 'Blocked'} — ${t.title}**\n\n${full.slice(0, 1500)}`);
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
      let reportMd = null;
      try {
        const files = dshInner.takeFiles?.(t.id);
        reportMd = files?.['report.md'] ?? (() => { try { return readFileSync(join(dshInner.pathFor(t.id, t.workspace), 'report.md'), 'utf8'); } catch { return null; } })();
        const r = files
          ? ctx.researchMemory.ingest({ taskId: t.id, findings: JSON.parse(files['findings.json'] ?? 'null'), reportMd: files['report.md'] ?? null })
          : ctx.researchMemory.ingestFromDir({ taskId: t.id, dir: dshInner.pathFor(t.id, t.workspace) });
        ctx.notifications.create({ level: 'success', title: `Research saved: ${r.topic}`, body: `${r.sources} sources, ${r.claims} claims, ${r.contradictions} contradiction(s) stored.`, taskId: t.id, conversationId: t.conversation_id });
      } catch (error) {
        ctx.notifications.create({ level: 'warning', title: `Research finished but not saved: ${t.title}`, body: `The agent did not leave a valid findings.json (${String(error.message).slice(0, 120)}). The report text is still in the task result.`, taskId: t.id });
      }
      // The full report as downloadable files in the chat: Markdown right away, a Word version once rendered.
      const text = reportMd ?? (String(t.result ?? '').length > 400 ? String(t.result) : null);
      if (text && t.conversation_id && ctx.chat.getConversation(t.conversation_id)) {
        const name = `Research - ${t.title.replace(/^Research:\s*/, '').slice(0, 60)}`;
        try {
          const md = ctx.files.save({ name: `${name}.md`, data: text, source: 'task', conversationId: t.conversation_id, taskId: t.id });
          ctx.documents.create({ format: 'docx', name, title: t.title.replace(/^Research:\s*/, ''), markdown: text, conversationId: t.conversation_id })
            .then((d) => { const ids = [md.id, ...(d._attach ?? [])]; ctx.chat.addMessage(t.conversation_id, 'assistant', '📎 Full research report — download it below.', { attachments: ids }); })
            .catch(() => { ctx.chat.addMessage(t.conversation_id, 'assistant', '📎 Full research report — download it below.', { attachments: [md.id] }); });
        } catch { /* attaching is best effort */ }
      }
    };
  }
  ctx.companion = new Companion({ ctx });
  ctx.voiceServer = new VoiceServer({ env, governor, dataDir, appRoot });
  ctx.rules = new Rules({ store, bus, notifications: ctx.notifications });
  ctx.jobs = new Jobs({ store, notifications: ctx.notifications, chat: ctx.chat, bus, settings });
  ctx.policy = new Policy({ settings, bus });
  ctx.approvals = new Approvals({ store, notifications: ctx.notifications, chat: ctx.chat, bus, audit: ctx.audit });
  ctx.users = new Users({ store, approvals: ctx.approvals, bus });
  ctx.auth.memberActive = (id) => ctx.users.get(id)?.status === 'approved';
  ctx.commitments = new Commitments({ store, settings, bus });
  ctx.proactive = new Proactive({
    store, notifications: ctx.notifications, jobs: ctx.jobs, ai, memory, settings, bus, dataDir, commitments: ctx.commitments,
    agentReady: () => ctx.dshAdapter.status().ready,
  });
  ctx.profile = new Profile({ settings });
  ctx.composio = new Composio({ apiKey: env.COMPOSIO_API_KEY, settings });
  ctx.files = new Files({ store, dir: resolve(dataDir, 'files'), bus });
  { // Gmail: 'main' = the owner's personal inbox, 'outreach' = the address that sends cold outreach and gets the replies.
    const onReauth = ({ account, email }) => ctx.notifications?.create({ level: 'warning', title: `Gmail (${account === 'main' ? 'personal' : account}) disconnected`, body: `Google stopped accepting Friday's access${email ? ` to ${email}` : ''} (expired or revoked). Connect it again in Settings → Connected apps.` });
    const g = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, publicUrl: env.FRIDAY_PUBLIC_URL, dataDir, onReauth };
    ctx.google = new GoogleAuth(g);
    ctx.googleOutreach = new GoogleAuth({ ...g, account: 'outreach' });
    ctx.gmail = new Gmail({ google: ctx.google, files: ctx.files });
    ctx.gmailOutreach = new Gmail({ google: ctx.googleOutreach, files: ctx.files });
  }
  ctx.deployer = new Deployer({ url: env.FRIDAY_DEPLOYER_URL, secret: env.FRIDAY_DEPLOYER_SECRET });
  ctx.login = new OwnerLogin({ settings, google: ctx.google, publicUrl: env.FRIDAY_SITE_URL });
  ctx.documents = new Documents({ files: ctx.files, appRoot, python: env.FRIDAY_DOCS_PYTHON ?? 'python3' });
  ctx.images = new Images({ store, files: ctx.files, apiKey: env.FRIDAY_NVIDIA_API_KEY ?? null, baseUrl: env.FRIDAY_IMAGE_BASE_URL ?? undefined });
  ctx.chat.fileNote = (f) => { const i = ctx.images.info(f.id); return i ? `image you drew, prompt: "${i.prompt}"` : null; };
  ctx.learner = new Learner({ ai, store, skills, dir: resolve(dataDir, 'skills'), profile: ctx.profile, bus, settings });
  { // successful laptop/Hermes runs become (or improve) playbooks, off the hot path
    const prev = store.onEvent;
    store.onEvent = (e) => { prev?.(e); if (e.kind === 'task.completed') setTimeout(() => { ctx.learner.learnFrom(e.taskId).catch(() => {}); }, 2000).unref?.(); };
  }
  ctx.questions = new Questions({ store, chat: ctx.chat, notifications: ctx.notifications, bus, profile: ctx.profile });
  kindRouter.byKind.computer = new ComputerAgent({ ai, nodes: ctx.nodes, policy: ctx.policy, approvals: ctx.approvals, bus, audit: ctx.audit, profile: ctx.profile, questions: ctx.questions, learner: ctx.learner });
  ctx.hermes = new HermesAdapter({ url: env.FRIDAY_HERMES_URL, key: env.FRIDAY_HERMES_KEY, approvals: ctx.approvals, policy: ctx.policy, learner: ctx.learner });
  ctx.approvals.register('hermes_action', async () => ({ ok: true })); // the adapter answers Hermes itself after the decision
  kindRouter.byKind.hermes = ctx.hermes;
  kindRouter.byKind.watch = kindRouter.byKind.computer; // read-only laptop checks for watches
  ctx.dmChats = new DmChats({ store, ai, composio: ctx.composio, nodes: ctx.nodes, chat: ctx.chat, notifications: ctx.notifications, bus, settings });
  // Deliver a finished reel to the owner's own WhatsApp (laptop task); shared by reel_send and the reel pipeline.
  ctx.reelSendTask = ({ path, caption = '', conversationId = null }) => store.createTask({ title: 'Laptop: send reel to your WhatsApp', kind: 'computer', conversationId, meta: { grant: true, autoSubmit: true },
    instruction: `Send a file to the user's OWN WhatsApp chat (not to anyone else). Open https://web.whatsapp.com (wait for the chat list). Open the chat with the user himself — search his name or "You"; it is marked "(You)" / "Message yourself". Verify the open chat header is his own chat before attaching. Use the attach (+ / paperclip) control → "Photos & videos", and attach this file with browser_upload: ${path}\n${caption ? `Type the caption exactly: ${String(caption).slice(0, 500)}\n` : ''}Press Send (intent submit_external, expect the Send button label), wait until the video finishes uploading, and confirm it appears in the chat. If the chat is not clearly his own, stop and report.` });
  ctx.reels = new ReelPipeline({ store, nodes: ctx.nodes, chat: ctx.chat, notifications: ctx.notifications, bus, createSendTask: ctx.reelSendTask });
  { const prev = store.onEvent; store.onEvent = (e) => { prev?.(e); if (e.kind === 'task.completed') setTimeout(() => { ctx.reels.onTaskCompleted(e.taskId).catch(() => {}); }, 1500).unref?.(); }; }
  ctx.watches = new Watches({ store, ai, jobs: ctx.jobs, notifications: ctx.notifications, chat: ctx.chat, bus, settings, gmail: ctx.gmail });
  { const prev = store.onEvent; store.onEvent = (e) => { prev?.(e); if (['task.completed', 'task.failed'].includes(e.kind)) setTimeout(() => { ctx.watches.onTaskFinished(e.taskId, e.kind).catch(() => {}); }, 500).unref?.(); }; }
  kindRouter.byKind.team = new TeamOrchestrator({ store, router: kindRouter, ai });
  ctx.rules.proactive = ctx.proactive;
  ctx.salesJudge = new SalesJudge({ jev: new JevClient({ apiKey: env.FRIDAY_JEV_KEY ?? null, timeoutMs: 20_000 }) });
  ctx.pipeline = new Pipeline({ store, settings, gmail: ctx.gmailOutreach, notifications: ctx.notifications, bus, judge: ctx.salesJudge });
  ctx.prospector = new Prospector({ store, settings, ai, judge: ctx.salesJudge, pipeline: ctx.pipeline, approvals: ctx.approvals, notifications: ctx.notifications, bus, serpKey: env.SERPAPI_API_KEY ?? null, hunterKey: env.HUNTER_API_KEY ?? null, reoonKey: env.REOON_API_KEY ?? null });
  ctx.fridayTools = buildFridayTools(ctx);
  { // gated tools get their approved-execution path registered automatically
    const register = ctx.fridayTools.register;
    ctx.fridayTools.register = (tool) => { register(tool); if (tool.risk !== 'safe') ctx.approvals.register(tool.name, tool.run); };
    for (const tool of ctx.fridayTools.list()) if (tool.risk !== 'safe') ctx.approvals.register(tool.name, tool.run);
  }
  ctx.fridayTools.register(toolsLoadTool());
  for (const t of commitmentTools(ctx.commitments)) ctx.fridayTools.register(t);
  ctx.mood = new Mood({ settings, store });
  ctx.proactive.mood = ctx.mood; // after it exists (it was assigned while still undefined)
  ctx.habits = new Habits({ settings });
  ctx.autoMemory = new AutoMemory({ ai, memory, settings, indexer, bus, commitments: ctx.commitments });
  ctx.brain = new Brain({
    mood: ctx.mood, habits: ctx.habits,
    ai, fridayTools: ctx.fridayTools, settings, chat: ctx.chat, bus, audit: ctx.audit, skills, policy: ctx.policy, approvals: ctx.approvals,
    toolRouter: new ToolRouter({ enabled: env.FRIDAY_TOOL_ROUTING !== '0' }),
    contextBuilder: new ContextBuilder({ memory, store, indexer, researchMemory: ctx.researchMemory, questions: ctx.questions, profile: ctx.profile, dmChats: ctx.dmChats, commitments: ctx.commitments }),
  });
  ctx.chatBrain = () => {
    if (ai.hasProvider && !ctx.state.emergencyStopped) return { name: 'friday-brain', adapter: ctx.brain };
    if (ctx.nemotron.configured && !ctx.state.emergencyStopped) return { name: 'nemotron-direct', adapter: ctx.nemotronResilient };
    try {
      if (ctx.dshAdapter.status().ready && !ctx.state.emergencyStopped) return { name: 'dsh', adapter: ctx.dshAdapter };
    } catch {}
    return { name: 'local-fallback', adapter: null };
  };

  let governorTimer = null, pruneTimer = null;
  ctx.start = () => {
    let lastMode = governor.getSnapshot().mode;
    governorTimer = setInterval(() => {
      try {
        const snap = governor.sample();
        if (snap.mode !== lastMode) { bus.publish('resource.mode_changed', { from: lastMode, to: snap.mode }); lastMode = snap.mode; }
      } catch { /* never crash on sampling */ }
    }, 2000);
    governorTimer.unref();
    try { skills.syncTo(agentsSkillsDir); } catch {}
    dshInner.start?.();
    worker.start();
    if (ai.hasProvider) indexer.start();
    ctx.jobs.start();
    ctx.hermes.start();
    ctx.watches.start();
    ctx.pipeline.start();
    ctx.prospector.start();
    ctx.dmChats.start_timer();
    pruneTimer = setInterval(() => { try { prune(store.db); } catch { /* retention is best effort */ } }, 6 * 3600_000); pruneTimer.unref();
    try { prune(store.db); } catch {}
    ctx.rules.start();
    ctx.proactive.start();
  };
  ctx.stop = () => {
    worker.stop();
    ctx.hermes.stop();
    ctx.watches.stop();
    ctx.pipeline.stop();
    ctx.prospector.stop();
    ctx.dmChats.stop_timer();
    ctx.nodes?.stopAll();
    ctx.voiceServer?.stop();
    clearInterval(governorTimer); clearInterval(pruneTimer); dshInner.stop?.();
    indexer.stop();
    ctx.jobs.stop();
    ctx.rules.stop();
    ctx.proactive.stop();
    try { store.close(); } catch {}
  };
  return ctx;
}
