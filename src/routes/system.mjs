import { healthReport } from '../health.mjs';

export function systemRoutes(router, ctx) {
  const { governor, store, worker, dshAdapter, nemotron, state, jev, audit, pet, voice, lease } = ctx;

  router.get('/v1/status', () => {
    const adapterStatus = state.emergencyStopped
      ? { ready: false, reason: 'emergency_stopped', consecutiveFailures: dshAdapter.consecutiveFailures ?? 0 }
      : dshAdapter.status();
    return [200, {
      name: 'Friday',
      phase: 'phase1',
      resources: governor.getSnapshot(),
      tasks: store.countTasks(),
      worker: { running: worker.running.size > 0, runningCount: worker.running.size, maxConcurrent: worker.maxConcurrent, currentTaskId: worker.current?.taskId ?? null, adapterReady: adapterStatus.ready, adapterReason: adapterStatus.reason ?? null },
      capabilities: { localModel: false, dsh: adapterStatus.ready, computerUse: ctx.nodes.online, remoteAccess: false },
      nodes: ctx.nodes.list().map((n) => ({ name: n.name, userActive: n.userActive })),
      provider: { consecutiveFailures: dshAdapter.consecutiveFailures ?? 0, circuitOpen: (dshAdapter.breakerOpenUntil ?? 0) > Date.now() },
      brain: ctx.chatBrain().name, nemotronConfigured: nemotron.configured, aiConfigured: ctx.ai.hasProvider,
      emergencyStopped: state.emergencyStopped, emergencyStoppedAt: state.emergencyStoppedAt,
    }];
  });

  router.get('/v1/health', () => [200, healthReport(ctx)]);

  router.post('/v1/emergency-stop', () => {
    state.emergencyStopped = true;
    state.emergencyStoppedAt = new Date().toISOString();
    for (const id of [...worker.running.keys()]) {
      worker.cancel(id);
      try { store.transition(id, 'cancelled', { error: 'emergency_stop' }); } catch {}
    }
    worker.stop();
    try { ctx.policy.revokeHigh(); } catch {}
    ctx.bus.publish('system.emergency_stop', { at: state.emergencyStoppedAt });
    return [200, { emergencyStopped: state.emergencyStopped, emergencyStoppedAt: state.emergencyStoppedAt }];
  });

  router.post('/v1/emergency-clear', () => {
    state.emergencyStopped = false;
    state.emergencyStoppedAt = null;
    worker.start();
    ctx.bus.publish('system.emergency_cleared', {});
    return [200, { emergencyStopped: false }];
  });

  router.get('/v1/presence', () => {
    const comp = ctx.companion.compute();
    const petState = comp.pet;
    return [200, {
      presence: {
        pet: petState, voice: voice.state ?? 'idle',
        lease: lease.active ? { active: true, expiresAt: lease.active.expiresAt ?? null } : { active: false },
        drivers: { browser: 'scaffold-disabled', atspi: 'not-verified', portal: 'lease-gated', localModel: false },
        companion: comp,
      },
      jevConfigured: jev.configured,
    }];
  });

  // Compact state for small devices (ESP32): poll this, or stream /v1/companion/stream.
  router.get('/v1/companion', () => [200, ctx.companion.compute()]);
  router.get('/v1/companion/stream', ({ req }) => ({
    raw: async (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const send = (c) => res.write(`event: state\ndata: ${JSON.stringify(c)}\n\n`);
      send(ctx.companion.compute());
      const off = ctx.bus.subscribe((e) => { if (e.type === 'companion.state_changed') send(e.data); });
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { clearInterval(hb); off(); });
    },
  }));

  // Hardware events (ESP32): presence sensor, button press. Pure telemetry, no authority.
  router.post('/v1/companion/events', async ({ body, principal }) => {
    const b = await body({ optional: true });
    const type = ['presence', 'absence', 'button'].includes(b.type) ? b.type : null;
    if (!type) return [400, { error: 'type must be presence|absence|button' }];
    ctx.bus.publish(`companion.${type}`, { device: principal.name ?? principal.id, distanceCm: Number.isFinite(b.distanceCm) ? b.distanceCm : null });
    return [200, { ok: true, state: ctx.companion.compute() }];
  });

  router.get('/v1/audit/verify', () => {
    try { return [200, audit.verify()]; } catch (error) { return [500, { error: error.message }]; }
  });

  // JEV fast router: typed intent/risk/approval advice, no execution.
  router.post('/v1/route', async ({ body }) => {
    const b = await body();
    if (typeof b.instruction !== 'string' || !b.instruction.trim() || b.instruction.length > 20000) return [400, { error: 'invalid_instruction' }];
    const out = await jev.routeInstruction(b.instruction.trim());
    try { audit.append('ad-hoc-local', 'route.decided', { intent: out.intent, needsApproval: out.needsApproval, source: out.source }); } catch {}
    return [200, { route: out }];
  });
}
