// Chat files: upload (raw body), list, download (always as an attachment), delete.
import { MAX_FILE_BYTES } from '../files.mjs';

export function fileRoutes(router, ctx) {
  const { files } = ctx;
  router.post('/v1/files', async ({ url, rawBody }) => {
    const name = url.searchParams.get('name') ?? '';
    const conversationId = url.searchParams.get('conversation') || null;
    if (conversationId && !ctx.chat.getConversation(conversationId)) return [404, { error: 'conversation_not_found' }];
    let data;
    try { data = await rawBody({ max: MAX_FILE_BYTES }); } catch { return [413, { error: 'file too large (max 25 MB)' }]; }
    try { return [201, { file: files.public(files.save({ name, data, source: 'upload', conversationId })) }]; } catch (e) { return [400, { error: e.message }]; }
  });
  router.get('/v1/files', ({ url }) => [200, { files: files.list({ conversationId: url.searchParams.get('conversation') || null }).map((f) => files.public(f)) }]);
  router.get('/v1/files/:id([a-f0-9-]{36})', ({ params }) => {
    const f = files.get(params.id);
    if (!f) return [404, { error: 'not_found' }];
    return { raw: async (res) => {
      const data = files.read(f.id);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': data.length,
        'Content-Disposition': `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store',
      });
      res.end(data);
    } };
  });
  router.delete('/v1/files/:id([a-f0-9-]{36})', ({ params }) => { const ok = files.remove(params.id); return [ok ? 200 : 404, { deleted: ok }]; });
}
