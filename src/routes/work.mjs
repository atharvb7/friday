const ID = '[A-Za-z0-9_-]+';

export function workRoutes(router, { rules }) {
  const bad = (error, code = 400) => [code, { error: error.message }];

  // Event-driven rules (standing automations)
  router.get('/v1/rules', () => [200, { rules: rules.list() }]);
  router.post('/v1/rules', async ({ body }) => { const b = await body(); try { return [201, { rule: rules.create({ name: b.name, event: b.event, where: b.where, action: b.action, cooldownSec: b.cooldownSec, maxPerDay: b.maxPerDay }) }]; } catch (e) { return bad(e); } });
  router.post(`/v1/rules/:id(${ID})/enabled`, async ({ params, body }) => { const b = await body(); return [rules.setEnabled(params.id, b.enabled !== false) ? 200 : 404, { ok: true }]; });
  router.delete(`/v1/rules/:id(${ID})`, ({ params }) => { const ok = rules.remove(params.id); return [ok ? 200 : 404, { removed: ok }]; });
  router.post('/v1/rules/kill-all', () => [200, { disabled: rules.killAll() }]);
}
