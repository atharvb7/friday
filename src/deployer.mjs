// Client for the deployer container (deployer/server.mjs). Friday's own apps only; see that file for the limits.
export class Deployer {
  constructor({ url, secret, fetchImpl = globalThis.fetch }) { Object.assign(this, { url: url ? String(url).replace(/\/+$/, '') : '', secret: secret ?? '', fetchImpl }); }
  get configured() { return Boolean(this.url && this.secret); }
  async #call(method, path, body = undefined, timeoutMs = 60_000) {
    if (!this.configured) return { error: 'deployer_not_configured' };
    try {
      const r = await this.fetchImpl(`${this.url}${path}`, { method, headers: { Authorization: `Bearer ${this.secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
      return await r.json().catch(() => ({ error: `deployer_${r.status}` }));
    } catch (e) { return { error: `deployer_unreachable: ${String(e.message).slice(0, 120)}` }; }
  }
  list() { return this.#call('GET', '/apps'); }
  deploy({ name, project, memoryMb }) { return this.#call('POST', '/apps/deploy', { name, project, memoryMb }, 20 * 60_000); }
  logs(name, tail = 200) { return this.#call('GET', `/apps/${encodeURIComponent(name)}/logs?tail=${Number(tail) || 200}`); }
  act(name, action) { return this.#call('POST', `/apps/${encodeURIComponent(name)}/${action}`); }
  remove(name) { return this.#call('DELETE', `/apps/${encodeURIComponent(name)}`); }
}
