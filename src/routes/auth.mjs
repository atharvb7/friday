import { WAITLIST_SHEET_SCRIPT } from '../waitlist.mjs';
// Device management + TOTP enrolment. Owner-only (scope 'admin' is never grantable to devices).
export function authRoutes(router, ctx) {
  const { auth, audit } = ctx;
  const a = (type, data) => { try { audit.append('ad-hoc-local', type, data); } catch {} };
  const typeErr = (e) => (e instanceof TypeError ? [400, { error: e.message }] : [400, { error: e.message }]);

  router.get('/v1/auth/whoami', ({ principal }) => [200, { principal: { kind: principal.kind, sessionOf: principal.sessionOf ?? null, id: principal.id, name: principal.name ?? null, scopes: principal.scopes }, totpActive: auth.totpActive() }]);
  router.get('/v1/devices', () => [200, { devices: auth.listDevices() }]);
  router.get('/v1/sessions', () => [200, { sessions: auth.listSessions() }]);
  router.get('/v1/auth/login-settings', () => [200, ctx.login.status()]);
  router.get('/v1/users', () => [200, { users: ctx.users.list() }]);
  // The landing-page waitlist (joining is public, see server.mjs). Owner-only, private address.
  router.get('/v1/waitlist', () => [200, { count: ctx.waitlist.count(), entries: ctx.waitlist.list() }]);
  // Google Sheet mirror (literal routes first: 'sheet' would otherwise match the :email route).
  router.get('/v1/waitlist/sheet', () => [200, ctx.waitlist.sheetStatus()]);
  router.get('/v1/waitlist/sheet/script', () => [200, { script: WAITLIST_SHEET_SCRIPT }]);
  router.post('/v1/waitlist/sheet', async ({ body }) => { const b = await body(); try { return [200, ctx.waitlist.setSheet(b)]; } catch (e) { return [400, { error: e.message }]; } });
  router.delete('/v1/waitlist/sheet', () => [200, ctx.waitlist.clearSheet()]);
  router.post('/v1/waitlist/sheet/sync', async () => { const added = await ctx.waitlist.syncSheet(); return [200, { added, ...ctx.waitlist.sheetStatus() }]; });
  router.delete('/v1/waitlist/:email([^/]+)', ({ params }) => { let e; try { e = decodeURIComponent(params.email); } catch { return [400, { error: 'bad email' }]; } const ok = ctx.waitlist.remove(e); return [ok ? 200 : 404, { ok }]; });
  router.post('/v1/users/:id([a-f0-9-]+)/status', async ({ params, body }) => {
    const b = await body();
    if (!['approved', 'disabled'].includes(b.status)) return [400, { error: 'status must be approved or disabled' }];
    const ok = ctx.users.setStatus(params.id, b.status); if (ok && b.status === 'disabled') ctx.auth.revokeMemberSessions(params.id);
    return [ok ? 200 : 404, { ok }];
  });
  router.post('/v1/auth/password', async ({ body }) => { const b = await body(); try { return [200, ctx.login.setPassword(b.email, b.password)]; } catch (e) { return [400, { error: e.message }]; } });
  router.delete('/v1/auth/password', () => [200, ctx.login.clearPassword()]);
  router.post('/v1/auth/google-login', async ({ body }) => { const b = await body(); try { return [200, ctx.login.setGoogle({ email: b.email, skipTotp: b.skipTotp })]; } catch (e) { return [400, { error: e.message }]; } });
  router.delete('/v1/sessions/:id([A-Za-z0-9-]+)', ({ params }) => { const ok = auth.revokeSession(params.id); return [ok ? 200 : 404, { revoked: ok }]; });
  router.post('/v1/devices', async ({ body }) => {
    const b = await body();
    try { const d = auth.createDevice({ name: b.name, scopes: b.scopes }); a('device.created', { id: d.id, name: d.name, scopes: d.scopes }); return [201, { device: d }]; }
    catch (e) { return typeErr(e); }
  });
  router.delete('/v1/devices/:id([A-Za-z0-9-]+)', ({ params }) => {
    const revoked = auth.revokeDevice(params.id);
    if (revoked) a('device.revoked', { id: params.id });
    return [revoked ? 200 : 404, { revoked }];
  });
  router.post('/v1/auth/totp/enroll', () => { try { return [201, auth.enrollTotp()]; } catch (e) { return typeErr(e); } });
  router.post('/v1/auth/totp/confirm', async ({ body }) => {
    const b = await body();
    try { const ok = auth.confirmTotp(String(b.code ?? '')); if (ok) a('totp.activated', {}); return [ok ? 200 : 400, { active: ok }]; }
    catch (e) { return typeErr(e); }
  });
}
