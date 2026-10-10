import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Exact-path map only: the request path must be a key, so no traversal exists.
// Served without auth (the token gate lives in app.js); /v1/* always requires it.
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/voice.js', ['voice.js', 'text/javascript; charset=utf-8']],
  ['/pet.html', ['pet.html', 'text/html; charset=utf-8']],
  ['/pet-viewer.js', ['pet-viewer.js', 'text/javascript; charset=utf-8']],
  ['/pet.css', ['pet.css', 'text/css; charset=utf-8']],
  ['/favicon.ico', ['favicon.svg', 'image/svg+xml']],
  ['/vendor/three.module.js', ['vendor/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/loaders/GLTFLoader.js', ['vendor/loaders/GLTFLoader.js', 'text/javascript; charset=utf-8']],
  ['/vendor/utils/BufferGeometryUtils.js', ['vendor/utils/BufferGeometryUtils.js', 'text/javascript; charset=utf-8']],
  ['/pet.js', ['pet.js', 'text/javascript; charset=utf-8']],
  ['/pet.glb', ['assets/pet.glb', 'model/gltf-binary']],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function makeStaticServer(publicDir) {
  return function serveStatic(req, res, pathname) {
    const asset = ASSETS.get(pathname);
    if (!asset || req.method !== 'GET') return false;
    let body;
    try { body = readFileSync(resolve(publicDir, asset[0])); } catch { return false; }
    res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length, ...SECURITY_HEADERS });
    res.end(body);
    return true;
  };
}
