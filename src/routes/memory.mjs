export function memoryRoutes(router, { memory }) {
  const typeErr = (error) => { if (error instanceof TypeError) return [400, { error: error.message }]; throw error; };

  router.get('/v1/memory', () => [200, { memories: memory.list() }]);
  router.get('/v1/memory/search', ({ url }) => {
    try { return [200, { memories: memory.search(url.searchParams.get('q') ?? '') }]; } catch (e) { return typeErr(e); }
  });
  router.post('/v1/memory', async ({ body }) => {
    const b = await body();
    try { return [201, { memory: memory.create(b) }]; } catch (e) { return typeErr(e); }
  });
  router.delete('/v1/memory/:id([a-f0-9-]+)', ({ params }) => {
    const deleted = memory.delete(params.id);
    return [deleted ? 200 : 404, { deleted }];
  });
}
