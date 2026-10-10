// Composition root: builds every Friday service once and owns their lifecycle.
// Route modules receive this object and never construct services themselves.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
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
  const governor = new ResourceGovernor({ telemetryPath: resolve(dataDir, 'resource-telemetry.jsonl') });
  governor.sample();

  // DSH stays disabled until a restricted profile is explicitly verified.
  const dshInner = new DshAdapter({
    homeDir: resolve(dataDir, 'dsh-home'),
    profile: env.FRIDAY_DSH_PROFILE ?? 'friday-restricted',
    model: env.FRIDAY_DSH_MODEL ?? null,
    restrictedVerified: env.FRIDAY_DSH_VERIFIED === '1',
    allowEnv: env.FRIDAY_NVIDIA_API_KEY ? { NVIDIA_API_KEY: env.FRIDAY_NVIDIA_API_KEY } : {},
  });
  const dshAdapter = new ResilientAdapter({ inner: dshInner });
  const nemotron = new NemotronProvider({});
  const nemotronResilient = new ResilientAdapter({ inner: nemotron });
  const worker = new WorkerLoop({ store, governor, adapter: dshAdapter, onEvent: (e) => bus.publish(e.kind === 'task.running' ? 'worker.claimed' : e.kind, e) });

  const workspaceDir = resolve(env.FRIDAY_WORKSPACE ?? resolve(dataDir, 'workspace'));
  try { mkdirSync(workspaceDir, { recursive: true, mode: 0o700 }); chmodSync(workspaceDir, 0o700); } catch {}

  const lease = new ComputerControlLease();
  const scheduler = new Scheduler(store);
  const ctx = {
    appRoot, env, dataDir, token,
    bus, auth: new Auth(store, token),
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
  ctx.chatBrain = () => {
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
    worker.start();
    ctx.dueRunner.start();
  };
  ctx.stop = () => {
    worker.stop();
    clearInterval(governorTimer);
    try { ctx.dueRunner.stop?.(); } catch {}
    try { store.close(); } catch {}
  };
  return ctx;
}
