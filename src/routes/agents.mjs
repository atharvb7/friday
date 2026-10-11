// Hermes status, learned playbooks, watches.
export function agentRoutes(router, ctx) {
  const { learner, watches, hermes, settings } = ctx;
  router.get('/v1/hermes', () => [200, { hermes: { configured: hermes.configured, ...hermes.status() } }]);
  router.get('/v1/learned', () => [200, { enabled: learner.enabled(), playbooks: learner.playbooks().map(({ name, description, hosts, body }) => ({ name, description, hosts, body })) }]);
  router.delete('/v1/learned/:name([a-z0-9-]+)', ({ params }) => { const ok = learner.forget(params.name); return [ok ? 200 : 404, { deleted: ok }]; });
  router.post('/v1/learned/settings', async ({ body }) => { const b = await body(); if (typeof b.enabled !== 'boolean') return [400, { error: 'enabled must be boolean' }]; settings.set('auto_learn', b.enabled); return [200, { enabled: b.enabled }]; });
  router.get('/v1/apps', async () => [200, await ctx.composio.status()]);
  router.post('/v1/apps/:app([a-z]+)/connect', async ({ params }) => { try { return [200, await ctx.composio.connectLink(params.app)]; } catch (e) { return [400, { error: e.message }]; } });
  router.get('/v1/watches', ({ url }) => [200, { watches: watches.list(url.searchParams.get('status') ?? 'active') }]);
  router.delete('/v1/watches/:id([a-f0-9-]+)', ({ params }) => { const ok = watches.cancel(params.id); return [ok ? 200 : 404, { cancelled: ok }]; });
}
