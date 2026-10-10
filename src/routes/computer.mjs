// Browser snapshot, staged WhatsApp send, and the desktop lease. All fail closed.
export function computerRoutes(router, { liveBrowser, whatsapp, liveDesktop, lease, store }) {
  const bad = (error, code = 400) => [code, { error: error.message }];

  router.get('/v1/browser/snapshot', async ({ url }) => {
    try { return [200, { snapshot: await liveBrowser.snapshot(url.searchParams.get('url') ?? '') }]; } catch (e) { return bad(e); }
  });

  router.post('/v1/whatsapp/stage', async ({ body }) => {
    const b = await body();
    if (b.taskId && !store.getTask(b.taskId)) return [404, { error: 'task_not_found' }];
    try { return [201, await whatsapp.stage({ taskId: b.taskId, recipientId: b.recipientId, filePath: b.filePath, caption: b.caption })]; } catch (e) { return bad(e); }
  });
  router.post('/v1/whatsapp/commit', async ({ body }) => {
    const b = await body();
    try { return [200, await whatsapp.commit({ effectId: b.effectId, token: b.approvalToken ?? b.token, exactArgs: b.exactArgs })]; } catch (e) { return bad(e); }
  });

  router.post('/v1/desktop/lease', async ({ body }) => {
    const b = await body({ optional: true });
    try { return [201, { lease: lease.request({ reason: b.reason ?? 'user-request', ttlMs: b.ttlMs }) }]; } catch (e) { return bad(e, 409); }
  });
  router.post('/v1/desktop/release', async ({ body }) => {
    const b = await body({ optional: true });
    try { lease.release(b.leaseId); return [200, { released: true }]; } catch (e) { return bad(e); }
  });
  router.post('/v1/desktop/activity', () => { lease.revokeOnActivity(); return [200, { revoked: true }]; });
  router.post('/v1/desktop/type', async ({ body }) => { const b = await body(); try { return [200, await liveDesktop.type(b.leaseId, b.text)]; } catch (e) { return bad(e); } });
  router.post('/v1/desktop/click', async ({ body }) => { const b = await body(); try { return [200, await liveDesktop.click(b.leaseId, { x: b.x, y: b.y })]; } catch (e) { return bad(e); } });
}
