// Laptop-node hub. The node (a small program on the user's laptop) dials OUT to
// this server, so the server never needs inbound access to the laptop:
//   node  --GET /v1/node/stream (SSE)-->  receives commands
//   node  --POST /v1/node/result-->       returns results
//   node  --POST /v1/node/events-->       reports activity (user is typing) and hello/caps
// If no node is online, commands fail fast with `node_offline` so callers can
// queue or tell the user instead of hanging.
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PENDING = 50;
const HEARTBEAT_MS = 15_000;

export class NodeHub {
  #nodes = new Map();   // deviceId -> { id, name, caps, res, lastSeen, userActiveUntil }
  #pending = new Map(); // commandId -> { nodeId, resolve, reject, timer }
  constructor({ bus = null, now = () => Date.now() } = {}) { this.bus = bus; this.now = now; }

  // Called when a node opens its command stream.
  attach(deviceId, name, res, req) {
    this.detach(deviceId, 'replaced');
    const node = { id: deviceId, name, caps: [], res, lastSeen: this.now(), userActiveUntil: 0, connectedAt: new Date().toISOString() };
    this.#nodes.set(deviceId, node);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, HEARTBEAT_MS);
    hb.unref?.();
    const gone = () => { clearInterval(hb); if (this.#nodes.get(deviceId)?.res === res) this.detach(deviceId, 'disconnected'); };
    req.on('close', gone); res.on('error', gone);
    this.bus?.publish('device.connected', { id: deviceId, name, kind: 'laptop-node' });
    return node;
  }

  detach(deviceId, reason = 'disconnected') {
    const n = this.#nodes.get(deviceId);
    if (!n) return;
    this.#nodes.delete(deviceId);
    for (const [cid, p] of this.#pending) if (p.nodeId === deviceId) { clearTimeout(p.timer); this.#pending.delete(cid); p.reject(Object.assign(new Error('node_disconnected'), { code: 'node_disconnected' })); }
    try { n.res.end(); } catch { /* already closed */ }
    this.bus?.publish('device.disconnected', { id: deviceId, name: n.name, reason });
  }

  hello(deviceId, { caps = [], platform = null } = {}) {
    const n = this.#nodes.get(deviceId);
    if (!n) throw new Error('not_connected');
    n.caps = Array.isArray(caps) ? caps.filter((c) => typeof c === 'string').slice(0, 50) : [];
    n.platform = typeof platform === 'string' ? platform.slice(0, 80) : null;
    n.lastSeen = this.now();
    this.bus?.publish('node.ready', { id: deviceId, caps: n.caps });
  }

  // User touched mouse/keyboard on the laptop: pause automation for `holdMs`.
  activity(deviceId, holdMs = 15_000) {
    const n = this.#nodes.get(deviceId);
    if (!n) return;
    n.lastSeen = this.now();
    n.userActiveUntil = this.now() + Math.min(Math.max(holdMs, 1000), 120_000);
    this.bus?.publish('node.user_active', { id: deviceId });
  }

  list() { return [...this.#nodes.values()].map((n) => ({ id: n.id, name: n.name, caps: n.caps, platform: n.platform ?? null, connectedAt: n.connectedAt, userActive: n.userActiveUntil > this.now() })); }
  get online() { return this.#nodes.size > 0; }
  pick(nodeId = null) { return nodeId ? this.#nodes.get(nodeId) : this.#nodes.values().next().value; }

  // Send a command and await its result. `interactive` actions (input/focus) are
  // refused while the user is active so Friday never fights them for the mouse.
  dispatch({ action, args = {}, nodeId = null, timeoutMs = DEFAULT_TIMEOUT_MS, interactive = false }) {
    const node = this.pick(nodeId);
    if (!node) return Promise.reject(Object.assign(new Error('node_offline'), { code: 'node_offline' }));
    if (!node.caps.includes(action)) return Promise.reject(Object.assign(new Error(`node_lacks_capability:${action}`), { code: 'node_lacks_capability' }));
    if (interactive && node.userActiveUntil > this.now()) return Promise.reject(Object.assign(new Error('user_active'), { code: 'user_active', retryAfterMs: node.userActiveUntil - this.now() }));
    if (this.#pending.size >= MAX_PENDING) return Promise.reject(new Error('too_many_pending_commands'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(Object.assign(new Error('node_timeout'), { code: 'node_timeout' })); }, timeoutMs);
      this.#pending.set(id, { nodeId: node.id, resolve, reject, timer });
      node.res.write(`event: command\ndata: ${JSON.stringify({ id, action, args })}\n\n`);
      this.bus?.publish('computer.action', { action, nodeId: node.id });
    });
  }

  // A node posts a command result.
  resolve(deviceId, { id, ok, result = null, error = null }) {
    const p = this.#pending.get(id);
    if (!p || p.nodeId !== deviceId) return false; // a node can only answer its own commands
    clearTimeout(p.timer);
    this.#pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(Object.assign(new Error(String(error ?? 'node_error').slice(0, 300)), { code: 'node_error' }));
    return true;
  }

  stopAll() { for (const id of [...this.#nodes.keys()]) this.detach(id, 'server_stop'); }
}
