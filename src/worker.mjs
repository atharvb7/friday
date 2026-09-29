export class WorkerLoop {
  constructor({ store, governor, adapter, intervalMs = 3000, onEvent = () => {} }) {
    this.store = store;
    this.governor = governor;
    this.adapter = adapter;
    this.intervalMs = intervalMs;
    this.onEvent = onEvent;
    this.timer = null;
    this.current = null;
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => this.onEvent({ kind: 'worker.error', error: error.message })), this.intervalMs);
    this.timer.unref();
    void this.tick().catch(error => this.onEvent({ kind: 'worker.error', error: error.message }));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current?.controller.abort(new Error('Friday shutting down'));
  }

  cancel(taskId) {
    if (this.current?.taskId === taskId) this.current.controller.abort(new Error('Task cancelled'));
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const snapshot = this.governor.sample();
      if (this.current) {
        if (snapshot.mode === 'emergency') this.current.controller.abort(new Error('Memory emergency'));
        return;
      }
      if (!this.adapter.status().ready) return;
      const admission = this.governor.canAdmit('background');
      if (!admission.allowed) return;
      const task = this.store.claimNextQueuedTask();
      if (!task) return;
      const lease = this.governor.acquire('background');
      if (!lease.allowed) {
        this.store.transition(task.id, 'blocked', { error: lease.reason });
        return;
      }
      const controller = new AbortController();
      this.current = { taskId: task.id, controller };
      this.onEvent({ kind: 'task.running', taskId: task.id });
      void this.#execute(task, controller, lease);
    } finally {
      this.ticking = false;
    }
  }

  async #execute(task, controller, lease) {
    try {
      const result = await this.adapter.run({ taskId: task.id, instruction: task.instruction, signal: controller.signal });
      if (this.store.getTask(task.id)?.status !== 'running') return;
      if (result.status === 'completed') this.store.transition(task.id, 'completed', { result: result.output ?? '' });
      else this.store.transition(task.id, 'failed', { error: result.error ?? result.status ?? 'worker failed' });
    } catch (error) {
      if (this.store.getTask(task.id)?.status === 'running') {
        this.store.transition(task.id, controller.signal.aborted ? 'blocked' : 'failed', { error: error.message ?? 'worker failed' });
      }
    } finally {
      lease.release();
      this.current = null;
      this.onEvent({ kind: 'task.finished', taskId: task.id });
    }
  }
}
