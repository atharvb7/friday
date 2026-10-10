// Reminders/jobs, autonomy, approvals, proactive settings, timezone.
import { isValidTimezone } from '../time.mjs';

export function assistantRoutes(router, ctx) {
  const { jobs, policy, approvals, proactive, settings, bus } = ctx;
  const bad = (e, code = 400) => [code, { error: e.message }];

  router.get('/v1/jobs', ({ url }) => [200, { jobs: jobs.list({ status: url.searchParams.get('status') ?? 'active' }) }]);
  router.post('/v1/jobs', async ({ body }) => {
    const b = await body();
    try { return [201, { job: jobs.create({ kind: b.kind, title: b.title, body: b.body, when: b.when, recurrence: b.recurrence }) }]; } catch (e) { return bad(e); }
  });
  router.delete('/v1/jobs/:id([a-f0-9-]+)', ({ params }) => { const ok = jobs.cancel(params.id); return [ok ? 200 : 404, { cancelled: ok }]; });
  router.post('/v1/jobs/:id([a-f0-9-]+)/snooze', async ({ params, body }) => {
    const b = await body();
    try { const ok = jobs.snooze(params.id, Number(b.minutes)); return [ok ? 200 : 404, { snoozed: ok }]; } catch (e) { return bad(e); }
  });

  router.get('/v1/autonomy', () => [200, { autonomy: policy.snapshot() }]);
  router.post('/v1/autonomy', async ({ body }) => {
    const b = await body();
    try { return [200, { autonomy: policy.set(b.category, b.level, { hours: b.hours }) }]; } catch (e) { return bad(e); }
  });
  router.post('/v1/autonomy/revoke-high', () => { policy.revokeHigh(); return [200, { autonomy: policy.snapshot() }]; });

  router.get('/v1/approvals', ({ url }) => [200, { approvals: approvals.list(url.searchParams.get('status') ?? 'pending') }]);
  router.post('/v1/approvals/:id([a-f0-9-]+)/decide', async ({ params, body, principal }) => {
    const b = await body();
    if (typeof b.approve !== 'boolean') return [400, { error: 'approve must be boolean' }];
    try { return [200, { approval: await approvals.decide(params.id, b.approve, principal.id) }]; }
    catch (e) { return bad(e, e.message === 'not_found' ? 404 : 409); }
  });

  router.get('/v1/proactive', () => [200, { proactive: proactive.config() }]);
  router.post('/v1/proactive', async ({ body }) => { const b = await body(); try { return [200, { proactive: proactive.setConfig(b) }]; } catch (e) { return bad(e); } });
  router.post('/v1/briefing/now', async () => [200, { briefing: await proactive.composeBriefing(settings.get('timezone', null) ?? Intl.DateTimeFormat().resolvedOptions().timeZone) }]);

  router.get('/v1/settings/timezone', () => [200, { timezone: jobs.timezone }]);
  router.post('/v1/settings/timezone', async ({ body }) => {
    const b = await body();
    if (!isValidTimezone(b.timezone)) return [400, { error: 'unknown timezone' }];
    settings.set('timezone', b.timezone); bus.publish('settings.changed', { key: 'timezone' });
    return [200, { timezone: b.timezone }];
  });
}
