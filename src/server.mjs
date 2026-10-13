import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { createContext } from './context.mjs';
import { Router, mapError } from './http/router.mjs';
import { makeStaticServer } from './http/static.mjs';
import { systemRoutes } from './routes/system.mjs';
import { taskRoutes } from './routes/tasks.mjs';
import { memoryRoutes } from './routes/memory.mjs';
import { toolRoutes } from './routes/tools.mjs';
import { chatRoutes } from './routes/chat.mjs';
import { workRoutes } from './routes/work.mjs';
import { authRoutes } from './routes/auth.mjs';
import { platformRoutes } from './routes/platform.mjs';
import { assistantRoutes } from './routes/assistant.mjs';
import { nodeRoutes } from './routes/node.mjs';
import { voiceRoutes } from './routes/voice.mjs';
import { profileRoutes } from './routes/profile.mjs';
import { agentRoutes } from './routes/agents.mjs';
import { fileRoutes } from './routes/files.mjs';
import { openEventStream } from './http/sse.mjs';
import { requiredScope, needsTotp } from './auth.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Local secrets file (gitignored, 0600). Real env vars win. FRIDAY_NO_DOTENV=1 keeps tests hermetic.
if (process.env.FRIDAY_NO_DOTENV !== '1') loadEnvFile(resolve(appRoot, '.env'));

const host = process.env.FRIDAY_HOST ?? '127.0.0.1';
// Loopback unless explicitly opened (containers); real exposure goes through Tailscale Serve/TLS.
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.FRIDAY_ALLOW_NONLOOPBACK !== '1') {
  console.error(`Refusing to bind ${host}: set FRIDAY_ALLOW_NONLOOPBACK=1 only behind a firewall/proxy.`);
  process.exit(2);
}
const port = Number(process.env.FRIDAY_PORT ?? 4317);
// Optional PUBLIC listener for a Cloudflare Tunnel (e.g. https://fridayy.site). It is never published on the host:
// only the cloudflared container reaches it, so anything arriving here is internet traffic and gets the strict rules.
const publicPort = Number(process.env.FRIDAY_PUBLIC_PORT ?? 0);
const ctx = createContext({ appRoot });
ctx.start();

const router = new Router();
for (const register of [systemRoutes, taskRoutes, memoryRoutes, toolRoutes, chatRoutes, workRoutes, authRoutes, platformRoutes, assistantRoutes, nodeRoutes, voiceRoutes, profileRoutes, agentRoutes, fileRoutes]) register(router, ctx);
const serveStatic = makeStaticServer(resolve(appRoot, 'public'));

// Buckets: authenticated traffic is keyed by principal (behind `tailscale serve`
// every request arrives from 127.0.0.1, so IP is useless); failed auth is keyed
// by IP with a much lower ceiling to blunt token guessing.
const RATE_WINDOW_MS = 60_000;
const buckets = new Map();
function limited(key, max) {
  const now = Date.now();
  const e = buckets.get(key);
  if (!e || now - e.start >= RATE_WINDOW_MS) { buckets.set(key, { start: now, count: 1 }); return false; }
  e.count += 1;
  return e.count > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (now - v.start >= RATE_WINDOW_MS) buckets.delete(k); }, RATE_WINDOW_MS).unref();

function send(res, status, payload, extraHeaders = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(data);
}

const MAX_BODY = 64 * 1024;
function rawReader(req) {
  return async ({ max = 4 * 1024 * 1024 } = {}) => {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > max) throw new Error('body_too_large'); chunks.push(c); }
    return Buffer.concat(chunks);
  };
}
function bodyReader(req) {
  return async ({ optional = false, max = MAX_BODY } = {}) => {
    try {
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > max) throw new Error('body_too_large');
      }
      return JSON.parse(text || '{}');
    } catch (error) {
      if (optional && error.message !== 'body_too_large') return {};
      throw error;
    }
  };
}

// Public-internet abuse control: wrong logins per real client IP -> 1 hour block.
const PUBLIC_FAIL_MAX = 10, PUBLIC_FAIL_WINDOW = 15 * 60_000, PUBLIC_BLOCK_MS = 60 * 60_000;
const publicFails = new Map(); // ip -> { n, start, blockedUntil }
const publicBlocked = (ip) => (publicFails.get(ip)?.blockedUntil ?? 0) > Date.now();
function publicFail(ip) {
  const now = Date.now(); const e = publicFails.get(ip);
  const cur = !e || now - e.start > PUBLIC_FAIL_WINDOW ? { n: 0, start: now, blockedUntil: e?.blockedUntil ?? 0 } : e;
  cur.n += 1; if (cur.n >= PUBLIC_FAIL_MAX) { cur.blockedUntil = now + PUBLIC_BLOCK_MS; cur.n = 0; cur.start = now; }
  publicFails.set(ip, cur);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of publicFails) if (v.blockedUntil < now && now - v.start > PUBLIC_FAIL_WINDOW) publicFails.delete(k); }, 600_000).unref();

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  const isPublic = Boolean(publicPort) && req.socket.localPort === publicPort;
  const clientIp = isPublic ? String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 64) : (req.socket.remoteAddress ?? 'unknown');
  if (isPublic) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
    if (publicBlocked(clientIp)) return send(res, 429, { error: 'too_many_failed_logins', retry: 'later' }, { 'Retry-After': '3600' });
  }
  if (serveStatic(req, res, url.pathname)) return;
  if (req.method === 'GET' && url.pathname === '/v1/auth/mode') return send(res, 200, { public: isPublic, totpActive: ctx.auth.totpActive() });
  // Internet sign-in: owner/device token + a fresh authenticator code -> a 30-day, revocable browser session.
  if (isPublic && req.method === 'POST' && url.pathname === '/v1/auth/session') {
    let b = {}; try { b = await bodyReader(req)(); } catch { return send(res, 400, { error: 'bad_request' }); }
    const who = ctx.auth.authenticate(String(b.token ?? ''));
    if (!who || who.kind === 'session' || (who.kind === 'device' && who.scopes.includes('node'))) { publicFail(clientIp); return send(res, 401, { error: 'unauthorized' }); }
    if (!ctx.auth.totpActive()) return send(res, 403, { error: 'totp_not_set_up', message: 'Set up the authenticator from your private (Tailscale) Friday first — internet sign-in needs it.' });
    if (!ctx.auth.checkTotp(String(b.code ?? ''))) { publicFail(clientIp); return send(res, 401, { error: 'bad_code' }); }
    const s = ctx.auth.createSession(who, { ip: clientIp, userAgent: req.headers['user-agent'], days: b.remember === false ? 1 : 30 });
    try { ctx.audit.append('auth', 'session.created', { kind: who.kind, ip: clientIp }); } catch { /* best effort */ }
    return send(res, 201, { token: s.token, expires_at: s.expires_at });
  }
  if (req.method === 'GET' && url.pathname === '/oauth/google/callback') { // browser redirect from Google: protected by the single-use state
    const page = (title, msg) => { const b = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${title}</h2><p>${msg}</p><p><a href="/">Back to Friday</a></p>`; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer' }); res.end(b); };
    const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
    ctx.google.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') })
      .then((r) => { ctx.bus.publish('google.connected', {}); page('Gmail connected ✅', `Friday can now use ${esc(r.email ?? 'your Gmail')}. You can close this tab.`); })
      .catch((e) => page('Gmail not connected', esc(e.message)));
    return;
  }
  const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const principal = ctx.auth.authenticate(bearer);
  const ip = clientIp;
  if (!principal) {
    if (isPublic) { if (bearer) publicFail(ip); return send(res, 401, { error: 'unauthorized' }); }
    if (limited(`fail:${ip}`, 30)) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    return send(res, 401, { error: 'unauthorized' });
  }
  // On the internet only browser sessions (token + authenticator) are accepted; raw tokens are for the private address.
  if (isPublic && principal.kind !== 'session') return send(res, 401, { error: 'session_required' });
  if (limited(`p:${principal.id}`, 240)) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  const scope = requiredScope(req.method, url.pathname);
  const guestChat = principal.scopes.includes('guest') && req.method === 'POST' && url.pathname === '/v1/chat'; // guests may ONLY chat (as guests)
  if (!principal.scopes.includes(scope) && !guestChat) return send(res, 403, { error: 'forbidden', needs: scope, ...(isPublic && ['admin', 'node'].includes(scope) ? { hint: 'owner and laptop-node functions only work on the private Tailscale address' } : {}) });
  // Everyone except the owner on the private address backs consequential actions with a fresh TOTP code.
  if (principal.kind !== 'owner' && req.method !== 'GET' && needsTotp(url.pathname) && ctx.auth.totpActive()
      && !ctx.auth.checkTotp(String(req.headers['x-friday-totp'] ?? ''))) {
    return send(res, 403, { error: 'totp_required' });
  }
  if (req.method === 'GET' && url.pathname === '/v1/events') return openEventStream(req, res, ctx.bus, { principal: principal.id });
  try {
    const out = await router.dispatch(req.method, url.pathname, { req, url, body: bodyReader(req), rawBody: rawReader(req), principal });
    if (!out) return send(res, 404, { error: 'not_found' });
    if (!Array.isArray(out) && typeof out.raw === 'function') return await out.raw(res);
    return send(res, out[0], out[1], out[2]);
  } catch (error) {
    const [status, payload] = mapError(error);
    return send(res, status, payload);
  }
};
const server = createServer(handler);
const publicServer = publicPort ? createServer(handler) : null;


server.listen(port, host, () => console.log(`Friday core listening on http://${host}:${port}`));
publicServer?.listen(publicPort, '0.0.0.0', () => console.log(`Friday public listener (Cloudflare Tunnel) on :${publicPort}`));
server.on('error', (error) => {
  console.error(`Friday core failed to listen: ${error.message}`);
  try { ctx.stop(); } catch {}
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  publicServer?.close();
  server.close(() => { ctx.stop(); process.exit(0); });
  setTimeout(() => { ctx.stop(); process.exit(0); }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
