import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

// Serves files under public/ only. A request resolves only if the real path stays
// inside public/, the extension is allow-listed, and no segment is a dotfile, so
// traversal and symlink escapes cannot leak anything. No auth (the token gate is
// in the app; /v1/* always requires it).
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};
const ALIASES = new Map([['/', '/index.html'], ['/privacy', '/privacy.html'], ['/terms', '/terms.html'], ['/outreach-privacy', '/outreach-privacy.html'], ['/favicon.ico', '/assets/favicon-64.png'], ['/pet.glb', '/assets/pet.glb']]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; worker-src 'self'",
  'Referrer-Policy': 'no-referrer',
};
// The pet stage loads Three.js modules from the same origin (vendored); no CDN needed.

export function makeStaticServer(publicDir) {
  const root = realpathSync(publicDir);
  return function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let p;
    try { p = decodeURIComponent(ALIASES.get(pathname) ?? pathname); } catch { return false; }
    if (p.includes('\0') || p.split('/').some((seg) => seg.startsWith('.') && seg.length > 0)) return false;
    const type = TYPES[extname(p).toLowerCase()];
    if (!type) return false;
    const abs = resolve(root, `.${p}`);
    if (!existsSync(abs)) return false;
    let real;
    try { real = realpathSync(abs); } catch { return false; }
    if (real !== root && !real.startsWith(root + sep)) return false;
    if (!statSync(real).isFile()) return false;
    const body = readFileSync(real);
    // The service worker must never be cached stale; everything else is no-store because content is private-adjacent.
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...(p === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
