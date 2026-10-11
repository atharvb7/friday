import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStaticServer } from '../src/http/static.mjs';

const call = (serve, path, method = 'GET') => {
  const out = { status: null, headers: null, body: null };
  const res = { writeHead: (s, h) => { out.status = s; out.headers = h; }, end: (b) => { out.body = b; } };
  const handled = serve({ method }, res, path);
  return { handled, ...out };
};

test('static: serves allow-listed files with CSP; blocks traversal, dotfiles, symlink escapes, unknown types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-static-'));
  try {
    const pub = join(dir, 'public'); mkdirSync(join(pub, 'js'), { recursive: true }); mkdirSync(join(pub, '.hidden'));
    writeFileSync(join(pub, 'index.html'), '<h1>hi</h1>'); writeFileSync(join(pub, 'js', 'a.js'), '1'); writeFileSync(join(pub, '.hidden', 'x.js'), 'x');
    writeFileSync(join(pub, 'notes.txt'), 'nope'); writeFileSync(join(dir, 'secret.js'), 'SECRET');
    symlinkSync(join(dir, 'secret.js'), join(pub, 'link.js'));
    const serve = makeStaticServer(pub);
    const root = call(serve, '/');
    assert.equal(root.status, 200); assert.match(root.headers['Content-Type'], /text\/html/);
    assert.match(root.headers['Content-Security-Policy'], /script-src 'self'/);
    assert.equal(root.headers['Cache-Control'], 'no-store');
    assert.equal(call(serve, '/js/a.js').status, 200);
    for (const bad of ['/../secret.js', '/%2e%2e/secret.js', '/js/../../secret.js', '/.hidden/x.js', '/notes.txt', '/link.js', '/nope.js', '/js', '/%00.js', '/%zz']) assert.equal(call(serve, bad).handled, false, bad);
    assert.equal(call(serve, '/', 'POST').handled, false);
    assert.equal(call(serve, '/', 'HEAD').body, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qr encoder: deterministic, right version/size for an otpauth link, finder patterns in the corners', async () => {
  const { encodeQr, qrSvg } = await import('../public/js/qr.js');
  const uri = 'otpauth://totp/Friday:owner?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Friday';
  const a = encodeQr(uri), b = encodeQr(uri);
  assert.deepEqual(a.modules, b.modules);
  assert.equal(a.size, a.version * 4 + 17);
  for (const [x, y] of [[0, 0], [a.size - 7, 0], [0, a.size - 7]]) { assert.equal(a.modules[y][x], true); assert.equal(a.modules[y + 1][x + 1], false); assert.equal(a.modules[y + 3][x + 3], true); }
  assert.match(qrSvg('hi'), /^<svg[\s\S]*<path d="M/);
  assert.throws(() => encodeQr('x'.repeat(3000)), /too long/);
});
