// Deterministic health report (no model involved). Each check is
// { name, status: ok|degraded|down|off, detail }.
import { statfsSync } from 'node:fs';

const MB = 1048576;

export function healthReport(ctx) {
  const checks = [];
  const add = (name, status, detail = '') => checks.push({ name, status, detail });

  try { ctx.store.db.prepare('SELECT 1').get(); add('database', 'ok', 'sqlite reachable'); }
  catch (e) { add('database', 'down', e.message); }

  if (!ctx.nemotron.configured) add('nemotron', 'off', 'no API key configured');
  else if ((ctx.nemotronResilient.breakerOpenUntil ?? 0) > Date.now()) add('nemotron', 'degraded', 'circuit open after repeated failures');
  else add('nemotron', 'ok', `configured (${ctx.nemotron.model})`);

  const dsh = ctx.dshAdapter.status();
  add('agent_runtime', dsh.ready ? 'ok' : 'off', dsh.ready ? `DSH ready (${dsh.model}, sandbox=${dsh.sandbox})` : (dsh.reason ?? 'not ready'));
  add('laptop_node', ctx.nodes.online ? 'ok' : 'off', ctx.nodes.online ? ctx.nodes.list().map((n) => n.name).join(', ') + ' connected' : 'offline (computer tasks wait in the queue)');
  { const v = ctx.voiceServer.status(); add('voice_devices', v.stt === 'ready' && v.tts === 'ready' ? 'ok' : 'off', `server STT ${v.stt}, TTS ${v.tts} (browser voice always works)`); }
  add('worker_pool', 'ok', `${ctx.worker.running.size}/${ctx.worker.maxConcurrent} running`);
  add('local_model', 'off', 'disabled by design');

  const snap = ctx.governor.getSnapshot();
  add('memory_pressure', snap.mode === 'normal' ? 'ok' : snap.mode === 'constrained' ? 'degraded' : 'down', `mode=${snap.mode}`);
  add('friday_rss', 'ok', `${Math.round(process.memoryUsage().rss / MB)} MiB`);

  try {
    const fs = statfsSync(ctx.dataDir);
    const freeGiB = (fs.bavail * fs.bsize) / 1073741824;
    add('disk', freeGiB > 5 ? 'ok' : freeGiB > 1 ? 'degraded' : 'down', `${freeGiB.toFixed(1)} GiB free`);
  } catch (e) { add('disk', 'degraded', e.message); }

  add('serpapi', ctx.env.SERPAPI_API_KEY ? 'ok' : 'off', ctx.env.SERPAPI_API_KEY ? 'key configured' : 'no key');
  try { const v = ctx.audit.verify(); add('audit_chain', v.ok === false ? 'down' : 'ok', v.ok === false ? 'hash chain broken' : 'verified'); }
  catch (e) { add('audit_chain', 'degraded', e.message); }
  add('remote_auth', ctx.auth.totpActive() ? 'ok' : 'degraded', ctx.auth.totpActive() ? 'TOTP active' : 'TOTP not enrolled (required before phone approvals)');
  add('devices', 'ok', `${ctx.auth.listDevices().filter((d) => !d.revoked_at).length} active`);
  add('event_bus', 'ok', `${ctx.bus.subscriberCount} subscribers`);
  add('emergency_stop', ctx.state.emergencyStopped ? 'down' : 'ok', ctx.state.emergencyStopped ? 'LATCHED' : 'clear');

  const rank = { down: 3, degraded: 2, ok: 0, off: 0 };
  const worst = checks.reduce((m, c) => Math.max(m, rank[c.status]), 0);
  return { overall: worst === 3 ? 'down' : worst === 2 ? 'degraded' : 'ok', checkedAt: new Date().toISOString(), checks };
}
