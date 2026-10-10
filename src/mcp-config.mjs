// MCP servers for the background agent. Friday keeps a small JSON file
// (<data>/config/mcp.json); this renders it into a DSH overlay. Secrets are never
// written: servers name env vars (`envPassthrough`) which are forwarded to the
// agent process from Friday's own environment and referenced via !!js.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function validateMcpConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || typeof cfg.servers !== 'object') throw new TypeError('config.servers required');
  for (const [name, s] of Object.entries(cfg.servers)) {
    if (!NAME_RE.test(name)) throw new TypeError(`invalid server name: ${name}`);
    if (!['stdio', 'streamable-http'].includes(s.transport)) throw new TypeError(`${name}: transport must be stdio or streamable-http`);
    if (s.transport === 'stdio' && (typeof s.command !== 'string' || !s.command)) throw new TypeError(`${name}: command required`);
    if (s.transport === 'streamable-http' && !/^https:\/\//.test(s.url ?? '') && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(s.url ?? '')) throw new TypeError(`${name}: url must be https (or loopback http)`);
    for (const e of s.envPassthrough ?? []) if (!ENV_RE.test(e)) throw new TypeError(`${name}: bad env name ${e}`);
  }
  return cfg;
}

export function loadMcpConfig(path) {
  if (!existsSync(path)) return { servers: {} };
  try { return validateMcpConfig(JSON.parse(readFileSync(path, 'utf8'))); } catch { return { servers: {} }; }
}

export function saveMcpConfig(path, cfg) {
  validateMcpConfig(cfg);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const q = (v) => JSON.stringify(String(v)); // JSON strings are valid YAML scalars

export function renderOverlay(cfg) {
  const rows = [];
  for (const [name, s] of Object.entries(cfg.servers)) {
    if (s.enabled === false) continue;
    const lines = [`    - id: mcp-${name}`, `      name: '@deepseek-ai/dsh-mcp-client'`, `      config:`, `        serverName: ${name}`, `        transport: ${s.transport}`];
    if (s.transport === 'stdio') {
      lines.push(`        command: ${q(s.command)}`);
      if (s.args?.length) lines.push(`        args: [${s.args.map(q).join(', ')}]`);
      if (s.envPassthrough?.length) { lines.push('        env:'); for (const e of s.envPassthrough) lines.push(`          ${e}: !!js process.env.${e}`); }
    } else {
      lines.push(`        url: ${q(s.url)}`);
    }
    if (s.toolCallTimeoutMs) lines.push(`        toolCallTimeoutMs: ${Number(s.toolCallTimeoutMs)}`);
    rows.push(lines.join('\n'));
  }
  if (!rows.length) return '# no MCP servers configured\n[]\n';
  return `- insert:\n${rows.join('\n')}\n`;
}

export function envToForward(cfg) {
  const names = new Set();
  for (const s of Object.values(cfg.servers)) if (s.enabled !== false) for (const e of s.envPassthrough ?? []) names.add(e);
  return [...names];
}
