// Manages the Python voice worker (Whisper STT + Kokoro TTS). It is started on demand and stopped after
// an idle period so its ~0.5-1 GB of model RAM is only used while someone is talking.
import { spawn } from 'node:child_process';

export class PythonWorker {
  #child = null; #pending = new Map(); #nextId = 1; #buf = ''; #idle = null; #queue = Promise.resolve();
  constructor({ python, script, env = {}, idleMs = 5 * 60_000, timeoutMs = 180_000 }) { Object.assign(this, { python, script, env, idleMs, timeoutMs }); }

  get running() { return Boolean(this.#child); }

  #ensure() {
    if (this.#child) return;
    const child = spawn(this.python, [this.script], { env: { ...process.env, ...this.env, PYTHONUNBUFFERED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    child.stdout.on('data', (c) => {
      this.#buf += c.toString('utf8'); let i;
      while ((i = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, i); this.#buf = this.#buf.slice(i + 1);
        try { const m = JSON.parse(line); const p = this.#pending.get(m.id); if (p) { this.#pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); } } catch { /* ignore noise */ }
      }
    });
    child.stderr.on('data', () => {}); // model download/progress chatter
    const gone = () => { if (this.#child === child) this.#child = null; for (const [id, p] of this.#pending) { clearTimeout(p.timer); p.reject(new Error('voice_worker_exited')); this.#pending.delete(id); } };
    child.on('exit', gone); child.on('error', gone);
  }

  // One request at a time (CPU-bound); each call has its own timeout.
  call(req) {
    const run = () => new Promise((resolve, reject) => {
      try { this.#ensure(); } catch (e) { return reject(e); }
      clearTimeout(this.#idle);
      const id = this.#nextId++;
      const timer = setTimeout(() => { this.#pending.delete(id); this.stop(); reject(new Error('voice_worker_timeout')); }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ ...req, id })}\n`, (e) => { if (e) { clearTimeout(timer); this.#pending.delete(id); reject(e); } });
    }).finally(() => { clearTimeout(this.#idle); this.#idle = setTimeout(() => this.stop(), this.idleMs); this.#idle.unref?.(); });
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }

  stop() { clearTimeout(this.#idle); const c = this.#child; this.#child = null; try { c?.kill('SIGTERM'); } catch { /* gone */ } }
}
