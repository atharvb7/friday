// Bridge between the laptop node and the "Friday for WhatsApp Web" Chrome extension in his own Chrome.
// The extension long-polls 127.0.0.1:<port>/wa/next for a command and posts the result to /wa/result; every request
// must carry the per-install token (x-friday-wa). Nothing listens beyond loopback. ensureExtension() keeps a ready-to-load
// copy of the extension (with its config.js) in ~/.friday-node/wa-extension.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PORT = 47613;

export function bridgeConfig(confDir) {
  const f = join(confDir, 'wa-bridge.json');
  try { const c = JSON.parse(readFileSync(f, 'utf8')); if (c.token && c.port) return c; } catch { /* first run */ }
  const c = { port: DEFAULT_PORT, token: randomBytes(24).toString('hex') };
  mkdirSync(confDir, { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(c), { mode: 0o600 }); chmodSync(f, 0o600);
  return c;
}

// Copy the extension next to the node config with its config.js (port + token); returns the folder to "Load unpacked".
export function ensureExtension({ srcDir, confDir, port, token }) {
  const dest = join(confDir, 'wa-extension');
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of ['manifest.json', 'content.js', 'background.js']) cpSync(join(srcDir, f), join(dest, f));
  const cfg = `self.FRIDAY_WA = ${JSON.stringify({ port, token })};\n`;
  const cf = join(dest, 'config.js');
  if (!existsSync(cf) || readFileSync(cf, 'utf8') !== cfg) writeFileSync(cf, cfg, { mode: 0o600 });
  return dest;
}

export class WaBridge {
  #queue = []; #waiters = []; #pending = new Map(); #lastSeen = 0; #server = null;
  constructor({ port, token, now = () => Date.now() }) { Object.assign(this, { port, token, now }); }

  get connected() { return this.now() - this.#lastSeen < 40_000; } // the extension polls at least every ~28 s

  start() {
    this.#server = createServer((req, res) => this.#handle(req, res));
    this.#server.listen(this.port, '127.0.0.1');
    return this;
  }
  stop() { this.#server?.close(); }

  // Run one op in his WhatsApp tab (status | read | open | send).
  command(op, args = {}, timeoutMs = 25_000) {
    if (!this.connected) return Promise.reject(new Error('wa_extension_offline: the Friday extension is not connected (Chrome closed, no WhatsApp Web tab, or the extension is not loaded)'));
    const cmd = { id: randomUUID(), op, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(cmd.id); reject(new Error('wa_timeout: the WhatsApp tab did not answer')); }, timeoutMs);
      this.#pending.set(cmd.id, (r) => { clearTimeout(timer); r?.error ? reject(new Error(`wa_${op}_failed: ${r.error}`)) : resolve(r); });
      const w = this.#waiters.shift();
      if (w) w(cmd); else this.#queue.push(cmd);
    });
  }

  #handle(req, res) {
    const done = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.headers['x-friday-wa'] !== this.token) return done(403, { error: 'forbidden' });
    this.#lastSeen = this.now();
    if (req.method === 'GET' && req.url === '/wa/next') {
      const cmd = this.#queue.shift();
      if (cmd) return done(200, cmd);
      let settled = false;
      const w = (c) => { if (settled) { this.#queue.unshift(c); return; } settled = true; clearTimeout(t); done(200, c); };
      const t = setTimeout(() => { settled = true; this.#waiters = this.#waiters.filter((x) => x !== w); this.#lastSeen = this.now(); done(204); }, 25_000);
      req.on('close', () => { if (!settled) { settled = true; clearTimeout(t); this.#waiters = this.#waiters.filter((x) => x !== w); } });
      this.#waiters.push(w);
      return;
    }
    if (req.method === 'POST' && req.url === '/wa/result') {
      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 2_000_000) req.destroy(); });
      req.on('end', () => { try { const { id, result } = JSON.parse(raw); this.#pending.get(id)?.(result); this.#pending.delete(id); done(200, { ok: true }); } catch { done(400, { error: 'bad json' }); } });
      return;
    }
    done(404, { error: 'not found' });
  }
}
