// Worker pool: claims queued tasks and runs them through the adapter, up to
// `maxConcurrent` at once (further capped by the resource governor). Every
// start/finish/cancel is durable; a crash leaves tasks `blocked`, never
// silently re-run (see Store recovery).
export class WorkerLoop {
  constructor({ store, governor, adapter, intervalMs = 3000, onEvent = () => {}, maxConcurrent = 1, workerClass = 'background' }) {
    Object.assign(this, { store, governor, adapter, intervalMs, onEvent, maxConcurrent, workerClass });
    this.timer = null;
    this.running = new Map(); // taskId -> { taskId, controller }
    this.ticking = false;
  }

  // Back-compat view: the oldest running task, or null.
  get current() { return this.running.values().next().value ?? null; }

  start() {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error) => this.onEvent({ kind: 'worker.error', error: error.message }));
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
    tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.running.values()) r.controller.abort(new Error('Friday shutting down'));
  }

  cancel(taskId) { this.running.get(taskId)?.controller.abort(new Error('Task cancelled')); }
  cancelAll(reason = 'cancelled') { for (const r of this.running.values()) r.controller.abort(new Error(reason)); }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const snapshot = this.governor.sample();
      if (snapshot.mode === 'emergency') this.cancelAll('Memory emergency');
      if (this.running.size >= this.maxConcurrent) return;
      if (!this.adapter.status().ready) return;
      while (this.running.size < this.maxConcurrent) {
        if (!this.governor.canAdmit(this.workerClass).allowed) return;
        const kinds = this.adapter.readyKinds?.() ?? null;
        const task = this.store.claimNextQueuedTask(kinds);
        if (!task) return;
        const lease = this.governor.acquire(this.workerClass);
        if (!lease.allowed) {
          this.store.transition(task.id, 'blocked', { error: lease.reason });
          return;
        }
        const controller = new AbortController();
        this.running.set(task.id, { taskId: task.id, controller });
        this.onEvent({ kind: 'task.running', taskId: task.id });
        void this.#execute(task, controller, lease);
      }
    } finally {
      this.ticking = false;
    }
  }

  async #execute(task, controller, lease) {
    const trace = (kind, detail) => { try { this.store.addEvent(task.id, `trace.${kind}`, detail); } catch { /* trace is best effort */ } };
    try {
      const result = await this.adapter.run({ taskId: task.id, instruction: task.instruction, signal: controller.signal, title: task.title, kind: task.kind, workspace: task.workspace, onTrace: trace });
      if (this.store.getTask(task.id)?.status !== 'running') return;
      if (result.status === 'completed') this.store.transition(task.id, 'completed', { result: result.output ?? '' });
      else this.store.transition(task.id, 'failed', { error: result.error ?? result.status ?? 'worker failed' });
    } catch (error) {
      if (this.store.getTask(task.id)?.status === 'running') {
        this.store.transition(task.id, controller.signal.aborted ? 'blocked' : 'failed', { error: error.message ?? 'worker failed' });
      }
    } finally {
      lease.release();
      this.running.delete(task.id);
      this.onEvent({ kind: 'task.finished', taskId: task.id });
    }
  }
}
