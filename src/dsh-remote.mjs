// Adapter that sends agent tasks to the isolated agent-runner container instead of spawning DSH locally.
// Same contract as DshAdapter (status/run); cancel = abort the request, which makes the runner kill the agent.
import { Buffer } from 'node:buffer';

const abortError = (m = 'dsh_cancelled') => Object.assign(new Error(m), { name: 'AbortError' });

export class RemoteDshAdapter {
  #healthy = { ready: false, reason: 'runner_unreachable' };
  #timer = null; #files = new Map();
  constructor({ url, secret, prepare = null, fetchImpl = globalThis.fetch, pollMs = 10_000, model = null }) {
    Object.assign(this, { url: String(url).replace(/\/+$/, ''), secret, prepare, fetchImpl, pollMs, model });
  }

  start() { void this.#poll(); this.#timer = setInterval(() => void this.#poll(), this.pollMs); this.#timer.unref?.(); }
  stop() { clearInterval(this.#timer); }
  async #poll() {
    try {
      const r = await this.fetchImpl(`${this.url}/health`, { headers: { Authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      this.#healthy = r.ok && j.ready ? { ready: true, model: j.model, sandbox: 'container', active: j.active } : { ready: false, reason: j.reason ?? (r.status === 401 ? 'runner_auth_failed' : 'runner_not_ready') };
    } catch { this.#healthy = { ready: false, reason: 'runner_unreachable' }; }
  }

  status() { return this.#healthy; }
  // Files the agent produced (research findings) for the finished task, handed over once.
  takeFiles(taskId) { const f = this.#files.get(taskId); this.#files.delete(taskId); return f ?? null; }

  async run({ taskId, instruction, signal, onTrace = () => {}, kind = 'agent', workspace = null } = {}) {
    if (!this.#healthy.ready) { await this.#poll(); if (!this.#healthy.ready) return { status: 'failed', error: this.#healthy.reason }; }
    if (signal?.aborted) throw abortError(signal.reason?.message);
    let prep = {}; try { prep = this.prepare?.() ?? {}; } catch { prep = {}; }
    let res;
    try {
      res = await this.fetchImpl(`${this.url}/run`, { method: 'POST', signal, headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, instruction, kind, workspace, overlay: prep.overlay ?? null, skills: prep.skills ?? {} }) });
    } catch (e) { if (signal?.aborted) throw abortError(signal.reason?.message); return { status: 'failed', error: `runner_unreachable: ${e.message}`.slice(0, 200) }; }
    if (!res.ok) return { status: 'failed', error: `runner_http_${res.status}` };
    let result = null, buf = '';
    const dec = new TextDecoder();
    const handle = (line) => { try { const m = JSON.parse(line); if (m.t === 'trace') onTrace(m.kind, m.detail); else if (m.t === 'result') result = m; } catch { /* ignore */ } };
    try {
      for await (const chunk of res.body) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } }
      if (buf.trim()) handle(buf.trim());
    } catch (e) { if (signal?.aborted) throw abortError(signal.reason?.message); return { status: 'failed', error: `runner_stream_broken: ${e.message}`.slice(0, 200) }; }
    if (signal?.aborted) throw abortError(signal.reason?.message);
    if (!result) return { status: 'failed', error: 'runner_no_result' };
    if (result.status === 'aborted') throw abortError('dsh_cancelled');
    if (result.status === 'completed') {
      if (result.files && Object.keys(result.files).length) this.#files.set(taskId, result.files);
      return { status: 'completed', output: result.output ?? '', tokens: result.tokens };
    }
    return { status: 'failed', error: result.error ?? 'agent_failed' };
  }
}

// Pack skill folders for transport (SKILL.md + references only; size-capped).
export function packSkills(skills) {
  const out = {}; let total = 0;
  for (const s of skills.list()) {
    const stack = [[s.path, s.name]];
    while (stack.length) {
      const [dir, rel] = stack.pop();
      for (const e of skills.readDir(dir)) {
        if (e.isDirectory) stack.push([e.path, `${rel}/${e.name}`]);
        else if (e.size < 200_000 && total < 2_000_000) { out[`${rel}/${e.name}`] = Buffer.from(skills.readFile(e.path)).toString('base64'); total += e.size; }
      }
    }
  }
  return out;
}
