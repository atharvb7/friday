export function toolRoutes(router, { tools, store, effects }) {
  router.get('/v1/tools', () => [200, { tools: tools.list() }]);

  router.post('/v1/tools/run', async ({ body }) => {
    const b = await body();
    if (typeof b.tool !== 'string' || !b.tool || typeof b.args !== 'object' || b.args === null || Array.isArray(b.args)) return [400, { error: 'invalid_tool_call' }];
    const entry = tools.list().find((t) => t.name === b.tool);
    if (!entry) return [404, { error: 'unknown_tool' }];
    if (entry.permission !== 'safe') return [403, { error: 'tool_not_exposed' }];
    let taskId = 'ad-hoc-local';
    if (b.taskId !== undefined && b.taskId !== null) {
      if (typeof b.taskId !== 'string' || !store.getTask(b.taskId)) return [404, { error: 'task_not_found' }];
      taskId = b.taskId;
    }
    try {
      const out = await tools.run({ taskId, tool: b.tool, args: b.args, effects });
      return [200, { tool: out.tool, result: out.result }];
    } catch (error) {
      if (error instanceof TypeError) return [400, { error: error.message }];
      throw error;
    }
  });
}
