// Regression tests for bugs found in the Oct 2026 code review (HTTP server, web fetch, egress proxy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetch } from '../src/web.mjs';
import { makeProxy } from '../egress-proxy/proxy.mjs';

const PORT = 43321, PUB = 43322;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');
const raw = (port, text) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(text));
  let out = ''; s.on('data', (d) => { out += d; }); s.on('close', () => resolve(out)); s.on('error', () => resolve(out));
  setTimeout(() => s.destroy(), 1500);
});

test('server: a malformed request line or a `null` JSON body gets a 400 and the server stays up; split UTF-8 bodies survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-review-http-'));
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_PUBLIC_PORT: String(PUB) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  let exited = false; child.on('exit', () => { exited = true; });
  try {
    for (const s = Date.now(); ;) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).status === 200) break; } catch {} if (Date.now() - s > 15000) throw new Error('no boot'); await new Promise((r) => setTimeout(r, 100)); }
    const bad = await raw(PORT, 'GET //[ HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.match(bad, /^HTTP\/1\.1 400/);
    const login = await fetch(`http://127.0.0.1:${PUB}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
    assert.equal(login.status, 400);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(exited, false, 'server still running');
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 200);
    // A message whose UTF-8 bytes arrive in two chunks, split inside a character.
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    const body = Buffer.from(JSON.stringify({ message: 'remember नमस्ते दोस्त' }));
    const cut = body.indexOf(Buffer.from('न')) + 1;
    const head = `POST /v1/chat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const reply = await new Promise((resolve) => {
      const s = net.connect(PORT, '127.0.0.1', () => { s.write(head); s.write(body.subarray(0, cut)); setTimeout(() => s.write(body.subarray(cut)), 100); });
      let out = ''; s.setEncoding('utf8'); s.on('data', (d) => { out += d; }); s.on('end', () => resolve(out));
    });
    assert.ok(reply.includes('नमस्ते दोस्त'), reply.slice(-300));
    assert.ok(!reply.includes('�'));
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => (exited ? r() : child.on('exit', r)));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web fetch: a redirect with an invalid Location rejects instead of crashing; a dripping server hits the deadline', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/bad') { res.writeHead(302, { Location: 'http://[' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); const t = setInterval(() => res.write('x'), 40); res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(() => safeFetch(`${base}/bad`, { allowPrivate: true }), /bad_redirect/);
    const t0 = Date.now();
    await assert.rejects(() => safeFetch(`${base}/drip`, { allowPrivate: true, timeoutMs: 200 }), /timeout/);
    assert.ok(Date.now() - t0 < 2000);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('egress proxy: a client reset while the CONNECT is being resolved does not crash the proxy', async () => {
  const proxy = makeProxy({ allowPrivate: true });
  const socket = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
  socket.setTimeout = () => socket;
  proxy.emit('connect', { url: 'localhost:443' }, socket, Buffer.alloc(0));
  assert.doesNotThrow(() => socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
  await new Promise((r) => setTimeout(r, 50));
});
