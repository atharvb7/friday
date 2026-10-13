// Device management + TOTP enrolment. Owner-only (scope 'admin' is never grantable to devices).
export function authRoutes(router, ctx) {
  const { auth, audit } = ctx;
  const a = (type, data) => { try { audit.append('ad-hoc-local', type, data); } catch {} };
  const typeErr = (e) => (e instanceof TypeError ? [400, { error: e.message }] : [400, { error: e.message }]);

  router.get('/v1/auth/whoami', ({ principal }) => [200, { principal: { kind: principal.kind, id: principal.id, name: principal.name ?? null, scopes: principal.scopes }, totpActive: auth.totpActive() }]);
  router.get('/v1/devices', () => [200, { devices: auth.listDevices() }]);
  router.get('/v1/sessions', () => [200, { sessions: auth.listSessions() }]);
  router.get('/v1/auth/login-settings', () => [200, ctx.login.status()]);
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
