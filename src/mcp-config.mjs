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
    if (s.transport === 'streamable-http') {
      let u; try { u = new URL(s.url); } catch { throw new TypeError(`${name}: url must be https (or loopback http)`); }
      if (!(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new TypeError(`${name}: url must be https (or loopback http)`);
    }
    for (const e of s.envPassthrough ?? []) if (!ENV_RE.test(e)) throw new TypeError(`${name}: bad env name ${e}`);
    for (const [h, v] of Object.entries(s.headersFromEnv ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(h) || !ENV_RE.test(v?.env ?? '') || (v.prefix != null && !/^[A-Za-z0-9 ._-]{0,20}$/.test(v.prefix))) throw new TypeError(`${name}: bad headersFromEnv ${h}`);
    }
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
      const hdrs = Object.entries(s.headersFromEnv ?? {});
      if (hdrs.length) { lines.push('        headers:'); for (const [h, v] of hdrs) lines.push(`          ${h}: !!js '\`${v.prefix ?? ''}\${process.env.${v.env}}\`'`); }
    }
    if (s.toolCallTimeoutMs) lines.push(`        toolCallTimeoutMs: ${Number(s.toolCallTimeoutMs)}`);
    rows.push(lines.join('\n'));
  }
  if (!rows.length) return '# no MCP servers configured\n[]\n';
  return `- insert:\n${rows.join('\n')}\n`;
}

export function envToForward(cfg) {
  const names = new Set();
  for (const s of Object.values(cfg.servers)) if (s.enabled !== false) { for (const e of s.envPassthrough ?? []) names.add(e); for (const v of Object.values(s.headersFromEnv ?? {})) names.add(v.env); }
  return [...names];
}

// Servers Friday enables on its own when the matching credential exists in its
// environment. User config with the same name always wins.
export function withDefaults(cfg, env) {
  const servers = { ...cfg.servers };
  if (env.SERPAPI_API_KEY && !servers.serpapi) {
    servers.serpapi = { transport: 'streamable-http', url: 'https://mcp.serpapi.com/mcp', headersFromEnv: { Authorization: { env: 'SERPAPI_API_KEY', prefix: 'Bearer ' } } };
  }
  if (env.GITHUB_TOKEN && !servers.github) {
    servers.github = { transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', headersFromEnv: { Authorization: { env: 'GITHUB_TOKEN', prefix: 'Bearer ' } } };
  }
  return { servers };
}
