const ID = '[A-Za-z0-9_-]+';

export function workRoutes(router, { scheduler, research, codework, automations, audit }) {
  const a = (taskId, type, data) => { try { audit.append(taskId, type, data); } catch {} };
  const bad = (error, code = 400) => [code, { error: error.message }];

  // Schedules
  router.get('/v1/schedules', () => [200, { schedules: scheduler.list() }]);
  router.post('/v1/schedules', async ({ body }) => {
    const b = await body();
    try { const s = scheduler.schedule(b); a(s.task_id ?? 'ad-hoc-local', 'schedule.created', { id: s.id }); return [201, { schedule: s }]; }
    catch (error) { return bad(error, error.message === 'task_not_found' ? 404 : 400); }
  });
  router.post('/v1/schedules/due/claim', () => { try { return [200, { due: scheduler.claimDue() }]; } catch (e) { return bad(e); } });
  router.post(`/v1/schedules/:id(${ID})/:action(cancel|done)`, ({ params }) => {
    try { return [200, { schedule: params.action === 'cancel' ? scheduler.cancel(params.id) : scheduler.done(params.id) }]; }
    catch (e) { return bad(e); }
  });

  // Research records (no network fetch here)
  router.get('/v1/research/report', ({ url }) => {
    try { return [200, { report: research.exportReport(url.searchParams.get('taskId') ?? undefined) }]; } catch (e) { return bad(e); }
  });
  router.post('/v1/research/sources', async ({ body }) => { const b = await body(); try { return [201, { source: research.recordSource(b) }]; } catch (e) { return bad(e); } });
  router.post('/v1/research/claims', async ({ body }) => { const b = await body(); try { return [201, { claim: research.recordClaim(b) }]; } catch (e) { return bad(e); } });

  // Isolated coding workspaces
  router.post('/v1/workspaces', () => {
    try { const ws = codework.createWorkspace(); a('ad-hoc-local', 'workspace.created', { id: ws.id ?? ws }); return [201, { workspace: ws }]; }
    catch (e) { return bad(e); }
  });
  const ws = (method) => async ({ params, url, body }) => {
    const b = method === 'POST' ? await body() : Object.fromEntries(url.searchParams.entries());
    try {
      switch (params.op) {
        case 'write': return [200, { wrote: codework.writeFile(params.id, b.path, b.content) }];
        case 'read': return [200, codework.readFile(params.id, b.path, b.maxBytes ? Number(b.maxBytes) : undefined)];
        case 'diff': return [200, { diff: codework.gitDiff(params.id) }];
        default: return [200, { test: codework.runTests(params.id, b.command ?? 'npm test') }];
      }
    } catch (e) { return bad(e); }
  };
  const wsPath = `/v1/workspaces/:id(${ID})/:op(write|read|diff|test)`;
  router.post(wsPath, ws('POST'));
  router.get(wsPath, ws('GET'));

  // Automations (explicit owner/trigger, read-only caps, kill switch)
  router.get('/v1/automations', () => [200, { automations: automations.list() }]);
  router.post('/v1/automations', async ({ body }) => { const b = await body(); try { return [201, { automation: automations.create(b) }]; } catch (e) { return bad(e); } });
  router.post('/v1/automations/fire', async ({ body }) => { const b = await body(); try { return [200, { due: automations.fire(b.trigger ?? b) }]; } catch (e) { return bad(e); } });
  router.post(`/v1/automations/:id(${ID})/kill`, ({ params }) => { try { return [200, { killed: automations.kill(params.id) }]; } catch (e) { return bad(e); } });
}
