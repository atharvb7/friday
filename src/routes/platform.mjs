// Skills, MCP servers and notifications.
import { saveMcpConfig, loadMcpConfig } from '../mcp-config.mjs';
import { resolve } from 'node:path';

export function platformRoutes(router, ctx) {
  const { skills, notifications, bus, dataDir } = ctx;
  const bad = (e, code = 400) => [code, { error: e.message }];

  router.get('/v1/skills', () => [200, { skills: skills.list().map(({ name, description, source }) => ({ name, description, source })) }]);
  router.get('/v1/skills/:name([a-z0-9-]+)', ({ params }) => { const s = skills.load(params.name); return s ? [200, { skill: s }] : [404, { error: 'not_found' }]; });
  // Install from a folder inside Friday's own skills inbox only (no arbitrary paths, no git clone).
  router.post('/v1/skills/install', async ({ body }) => {
    const b = await body();
    if (typeof b.folder !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b.folder)) return [400, { error: 'invalid_folder' }];
    try { const r = skills.install(resolve(dataDir, 'skills-inbox', b.folder), resolve(dataDir, 'skills')); bus.publish('skill.installed', { name: r.name }); return [201, r]; }
    catch (e) { return bad(e); }
  });

  router.get('/v1/mcp', () => [200, { config: loadMcpConfig(ctx.mcpPath) }]);
  router.post('/v1/mcp', async ({ body }) => {
    const b = await body();
    try { saveMcpConfig(ctx.mcpPath, b.config); bus.publish('mcp.changed', {}); return [200, { config: loadMcpConfig(ctx.mcpPath) }]; } catch (e) { return bad(e); }
  });

  router.get('/v1/research/projects', () => [200, { projects: ctx.researchMemory.list() }]);
  router.get('/v1/research/projects/search', ({ url }) => [200, { projects: ctx.researchMemory.search(url.searchParams.get('q') ?? '') }]);
  router.get('/v1/research/projects/:id([a-f0-9-]+)', ({ params }) => { const p = ctx.researchMemory.project(params.id); return p ? [200, { project: p }] : [404, { error: 'not_found' }]; });
  router.get('/v1/research/projects/:id([a-f0-9-]+)/report', ({ params }) => { const r = ctx.researchMemory.report(params.id); return r ? [200, { markdown: r }] : [404, { error: 'not_found' }]; });

  router.get('/v1/push/key', () => [200, { publicKey: ctx.push.publicKey, subscriptions: ctx.push.count() }]);
  router.post('/v1/push/subscribe', async ({ body, principal }) => {
    const b = await body();
    try { ctx.push.subscribe(b.subscription ?? b, principal.name ?? principal.id); return [201, { ok: true }]; } catch (e) { return bad(e); }
  });
  router.post('/v1/push/unsubscribe', async ({ body }) => { const b = await body(); return [200, { removed: ctx.push.unsubscribe(String(b.endpoint ?? '')) }]; });

  router.get('/v1/notifications', ({ url }) => [200, { notifications: notifications.list({ unreadOnly: url.searchParams.get('unread') === '1' }), unread: notifications.unreadCount() }]);
  router.post('/v1/notifications/read-all', () => [200, { marked: notifications.markAllRead() }]);
  router.post('/v1/notifications/:id([a-f0-9-]+)/read', ({ params }) => { const ok = notifications.markRead(params.id); return [ok ? 200 : 404, { read: ok }]; });
}
