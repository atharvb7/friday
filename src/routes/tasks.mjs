const HEX = '[a-f0-9-]+';

export function taskRoutes(router, ctx) {
  const { store, effects, worker } = ctx;

  router.get('/v1/tasks', () => [200, { tasks: store.listTasks() }]);

  router.post('/v1/tasks', async ({ req, body }) => {
    const b = await body();
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200 || typeof b.instruction !== 'string' || !b.instruction.trim() || b.instruction.length > 20000) return [400, { error: 'invalid_task' }];
    const key = req.headers['idempotency-key'];
    if (key && (typeof key !== 'string' || key.length > 200)) return [400, { error: 'invalid_idempotency_key' }];
    return [201, { task: store.createTask({ title: b.title.trim(), instruction: b.instruction.trim(), idempotencyKey: key ?? null }) }];
  });

  const withTask = (fn) => (input) => {
    const task = store.getTask(input.params.id);
    return task ? fn(task, input) : [404, { error: 'not_found' }];
  };

  router.get(`/v1/tasks/:id(${HEX})`, withTask((task) => [200, { task }]));
  router.get(`/v1/tasks/:id(${HEX})/events`, withTask((task) => [200, { events: store.listEvents(task.id) }]));
  router.get(`/v1/tasks/:id(${HEX})/effects`, withTask((task) => [200, { effects: effects.list(task.id) }]));

  router.post(`/v1/tasks/:id(${HEX})/cancel`, withTask((task) => {
    worker.cancel(task.id);
    const result = store.transition(task.id, 'cancelled');
    return [result.error ? 409 : 200, result];
  }));

  // Explicit re-queue of a failed/blocked task (never automatic: tool calls may already have had effects).
  router.post(`/v1/tasks/:id(${HEX})/retry`, withTask((task) => {
    const result = store.transition(task.id, 'queued', { note: 'manual_retry' });
    return [result.error ? 409 : 200, result];
  }));

  // Propose + stage + request in one call (no outbound sink here). Returns the
  // single-use approvalToken once; the UI approves in a separate call.
  router.post(`/v1/tasks/:id(${HEX})/effects`, withTask(async (task, { body }) => {
    const b = await body();
    if (typeof b.kind !== 'string' || typeof b.exactArgs !== 'object' || b.exactArgs === null || Array.isArray(b.exactArgs)) return [400, { error: 'invalid_effect' }];
    try {
      const proposed = effects.propose(task.id, b.kind, b.exactArgs);
      effects.stage(proposed.id, b.exactArgs);
      const { effect, token: approvalToken } = effects.requestApproval(proposed.id);
      return [201, { effect, approvalToken, approvalExpiresAt: effect.approval_expires_at }];
    } catch (error) { return [400, { error: error.message }]; }
  }));

  router.post(`/v1/effects/:id(${HEX})/approve`, async ({ params, body }) => {
    const b = await body();
    if (typeof b.approvalToken !== 'string' || typeof b.exactArgs !== 'object' || b.exactArgs === null) return [400, { error: 'invalid_approval' }];
    try { return [200, { effect: effects.approve(params.id, b.approvalToken, b.exactArgs) }]; }
    catch (error) { return [400, { error: error.message }]; }
  });

  router.get(`/v1/effects/:id(${HEX})`, ({ params }) => {
    const effect = effects.get(params.id);
    if (!effect) return [404, { error: 'not_found' }];
    const { approval_hash, ...publicEffect } = effect; // never leak the hash
    void approval_hash;
    return [200, { effect: publicEffect }];
  });
}
