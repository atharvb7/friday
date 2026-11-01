// Egress proxy for the agent container. The agent lives on an internal-only network and can reach the
// internet ONLY through this proxy, which refuses private/loopback/link-local/tailnet/docker addresses
// (so an injected agent cannot pivot to your LAN, tailnet devices, other containers or cloud metadata).
// The resolved address is validated and then used for the connection itself (no DNS-rebinding gap).
import { createServer, request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { isPrivateAddress } from '../src/web.mjs';

const PORT = Number(process.env.PROXY_PORT ?? 3128);
const ALLOWED_PORTS = new Set((process.env.PROXY_PORTS ?? '80,443,8080,8443').split(',').map(Number));

export async function resolvePublic(host, allowPrivate = false) {
  const h = host.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) { if (!allowPrivate && isPrivateAddress(h)) throw new Error('blocked_address'); return h; }
  const addrs = await lookup(h, { all: true });
  if (!addrs.length || (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address)))) throw new Error('blocked_address');
  return addrs[0].address;
}

export function makeProxy({ allowPrivate = false, ports = ALLOWED_PORTS } = {}) {
  const server = createServer(async (req, res) => {          // plain HTTP forward
    try {
      const u = new URL(req.url);
      const port = Number(u.port || 80);
      if (u.protocol !== 'http:' || !ports.has(port)) throw new Error('blocked_port');
      const ip = await resolvePublic(u.hostname, allowPrivate);
      const headers = { ...req.headers }; delete headers['proxy-connection'];
      const up = httpRequest({ host: ip, port, method: req.method, path: u.pathname + u.search, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
    } catch (e) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end(`blocked: ${e.message}\n`); }
  });
  server.on('connect', async (req, socket, head) => {          // HTTPS tunnel
    // Node drops its own error listener from a CONNECT socket: without this, a client reset during the DNS lookup
    // (or after the 403) is an unhandled 'error' event that kills the proxy.
    let up = null;
    socket.on('error', () => { up?.destroy(); socket.destroy(); });
    socket.on('close', () => up?.destroy());
    try {
      const [host, p] = req.url.split(/:(?=\d+$)/); const port = Number(p || 443);
      if (!ports.has(port)) throw new Error('blocked_port');
      const ip = await resolvePublic(host, allowPrivate);
      if (socket.destroyed) return;
      up = net.connect(port, ip, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) up.write(head); up.pipe(socket); socket.pipe(up); });
      up.on('error', () => socket.destroy()); socket.setTimeout(10 * 60_000, () => socket.destroy());
    } catch (e) { socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n`); }
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  makeProxy().listen(PORT, '0.0.0.0', () => console.log(`egress proxy on :${PORT}`));
}
