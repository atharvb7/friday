const ID = '[A-Za-z0-9_-]+';

export function workRoutes(router, { automations }) {
  const bad = (error, code = 400) => [code, { error: error.message }];

  // Automations (explicit owner/trigger, read-only caps, kill switch)
  router.get('/v1/automations', () => [200, { automations: automations.list() }]);
  router.post('/v1/automations', async ({ body }) => { const b = await body(); try { return [201, { automation: automations.create(b) }]; } catch (e) { return bad(e); } });
  router.post('/v1/automations/fire', async ({ body }) => { const b = await body(); try { return [200, { due: automations.fire(b.trigger ?? b) }]; } catch (e) { return bad(e); } });
  router.post(`/v1/automations/:id(${ID})/kill`, ({ params }) => { try { return [200, { killed: automations.kill(params.id) }]; } catch (e) { return bad(e); } });
}
