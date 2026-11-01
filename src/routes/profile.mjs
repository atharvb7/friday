// The owner's saved details and questions paused tasks are waiting on.
export function profileRoutes(router, ctx) {
  const { profile, questions } = ctx;
  const bad = (e, code = 400) => [code, { error: e.message }];
  router.get('/v1/profile', () => [200, { profile: profile.all() }]);
  router.post('/v1/profile', async ({ body }) => {
    const b = await body();
    try { profile.set(b.field, b.value); return [200, { profile: profile.all() }]; } catch (e) { return bad(e); }
  });
  router.delete('/v1/profile/:field([a-z]+)', ({ params }) => { try { profile.clear(params.field); return [200, { profile: profile.all() }]; } catch (e) { return bad(e); } });
  router.get('/v1/questions', () => [200, { questions: questions.pending() }]);
  router.post('/v1/questions/:id([a-f0-9-]+)/answer', async ({ params, body }) => {
    const b = await body();
    try { questions.answer(params.id, b.answer); return [200, { answered: true }]; } catch (e) { return bad(e, e.message === 'not_found' ? 404 : e instanceof TypeError ? 400 : 409); }
  });
}
