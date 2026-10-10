export function memoryRoutes(router, { memory, indexer, bus }) {
  const typeErr = (error) => { if (error instanceof TypeError) return [400, { error: error.message }]; throw error; };

  router.get('/v1/memory', () => [200, { memories: memory.list() }]);
  router.get('/v1/memory/search', async ({ url }) => {
    try {
      const q = url.searchParams.get('q') ?? '';
      if (typeof q !== 'string' || q.length > 200) throw new TypeError('invalid search');
      const queryVector = q.trim() ? await indexer.queryVector(q) : null;
      return [200, { memories: memory.searchHybrid(q, { queryVector, limit: 20 }), semantic: Boolean(queryVector) }];
    } catch (e) { return typeErr(e); }
  });
  router.post('/v1/memory', async ({ body }) => {
    const b = await body();
    try { return [201, { memory: memory.create(b) }]; } catch (e) { return typeErr(e); }
  });
  router.post('/v1/memory/:id([a-f0-9-]+)/pin', async ({ params, body }) => {
    const b = await body({ optional: true });
    const row = memory.pin(params.id, b.pinned !== false);
    if (row) bus.publish('memory.updated', { id: row.id });
    return row ? [200, { memory: row }] : [404, { error: 'not_found' }];
  });
  router.add('PATCH', '/v1/memory/:id([a-f0-9-]+)', async ({ params, body }) => {
    const b = await body();
    const allowed = ['content', 'project', 'sensitivity', 'kind', 'importance'];
    const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
    try { const row = memory.update(params.id, patch); return row ? [200, { memory: row }] : [404, { error: 'not_found' }]; } catch (e) { return typeErr(e); }
  });
  router.delete('/v1/memory/:id([a-f0-9-]+)', ({ params }) => {
    const deleted = memory.delete(params.id);
    return [deleted ? 200 : 404, { deleted }];
  });
}
