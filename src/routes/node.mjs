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

  // The laptop node uploads a bundle it made (e.g. a reel's zip of generated photos/videos) into Friday's files.
  router.post('/v1/node/upload', async ({ url, rawBody }) => {
    const name = url.searchParams.get('name') ?? '';
    if (!/\.zip$/i.test(name)) return [400, { error: 'only .zip bundles' }];
    const conversationId = url.searchParams.get('conversation') || null;
    if (conversationId && !ctx.chat.getConversation(conversationId)) return [404, { error: 'conversation_not_found' }];
    let data; try { data = await rawBody({ max: 300 * 1024 * 1024 }); } catch { return [413, { error: 'too large (300 MB)' }]; }
    try { return [201, { file: ctx.files.public(ctx.files.save({ name, data, source: 'task', conversationId, maxBytes: 300 * 1024 * 1024 })) }]; } catch (e) { return [400, { error: e.message }]; }
  });
  router.post('/v1/node/result', async ({ body, principal }) => {
    const b = await body({ max: 3 * 1024 * 1024 }); // screenshots ride in results
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
