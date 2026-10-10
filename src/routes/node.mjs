// Endpoints used BY the laptop node (scope `node`) plus a read-only listing.
export function nodeRoutes(router, ctx) {
  const { nodes } = ctx;

  // Long-lived SSE stream of commands for this node.
  router.get('/v1/node/stream', ({ req, principal }) => ({
    raw: async (res) => { nodes.attach(principal.id, principal.name ?? principal.id, res, req); },
  }));

  router.post('/v1/node/hello', async ({ body, principal }) => {
    const b = await body();
    try { nodes.hello(principal.id, b); return [200, { ok: true }]; } catch (e) { return [409, { error: e.message }]; }
  });

  router.post('/v1/node/result', async ({ body, principal }) => {
    const b = await body();
    if (typeof b.id !== 'string') return [400, { error: 'id required' }];
    return [nodes.resolve(principal.id, { id: b.id, ok: b.ok === true, result: b.result ?? null, error: b.error ?? null }) ? 200 : 404, { ok: true }];
  });

  // Local input detected on the laptop: pause automation for a moment.
  router.post('/v1/node/events', async ({ body, principal }) => {
    const b = await body({ optional: true });
    if (b.type === 'activity') nodes.activity(principal.id, Number(b.holdMs) || 15_000);
    return [200, { ok: true }];
  });

  router.get('/v1/nodes', () => [200, { nodes: nodes.list() }]);
}
