// src/scheduler-runner.mjs — pure scheduler → task-queue handoff.
//
// DueRunner polls Scheduler.claimDue() every 30s (unref'd) and hands each due
// row to the Store task queue (status 'queued'). It NEVER executes effects:
// the default onTask only logs; real execution still happens via WorkerLoop
// plus the approvals/effects pipeline. Governor gates admission: background
// workers must be admittable and the mode must not be 'emergency', otherwise
// rows stay 'scheduled' (we do NOT claim them while blocked).

const POLL_MS = 30_000;

function defaultOnTask({ schedule, task } = {}) {
  console.log(`[due-runner] queued task ${task?.id ?? '?'} for schedule ${schedule?.id ?? '?'}`);
  return { schedule, task };
}

export class DueRunner {
  constructor({ store, scheduler, governor, onTask = defaultOnTask, pollMs = POLL_MS } = {}) {
    if (!store || typeof store.getTask !== 'function' || typeof store.createTask !== 'function') {
      throw new TypeError('store with getTask/createTask required');
    }
    if (!scheduler || typeof scheduler.claimDue !== 'function') {
      throw new TypeError('scheduler with claimDue required');
    }
    if (!governor || typeof governor.canAdmit !== 'function') {
      throw new TypeError('governor with canAdmit required');
    }
    if (typeof onTask !== 'function') throw new TypeError('onTask must be a function');
    if (!Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError('pollMs must be a positive number');
    this.store = store;
    this.scheduler = scheduler;
    this.governor = governor;
    this.onTask = onTask;
    this.pollMs = pollMs;
    this.timer = null;
    this.started = false;
  }

  // Single handoff pass. Returns an array of { schedule, task } handed off.
  // Governor-blocked or emergency → returns [] and leaves rows 'scheduled'.
  claimDue() {
    return this.runOnce();
  }

  runOnce() {
    return this.pollOnce();
  }

  pollOnce() {
    // Emergency short-circuit before touching the scheduler table.
    const snapshot =
      typeof this.governor.sample === 'function'
        ? this.governor.sample()
        : typeof this.governor.getSnapshot === 'function'
          ? this.governor.getSnapshot()
          : { mode: 'normal' };
    if (snapshot?.mode === 'emergency') return [];
    const admission = this.governor.canAdmit('background');
    if (!admission?.allowed) return [];
    const dueRows = this.scheduler.claimDue();
    const handedOff = [];
    for (const schedule of dueRows) {
      let task = null;
      try {
        task = schedule?.task_id ? this.store.getTask(schedule.task_id) : null;
      } catch {
        task = null;
      }
      if (!task) {
        task = this.store.createTask({
          title: schedule?.title ?? 'Scheduled task',
          instruction: schedule?.instruction ?? '',
          idempotencyKey: `schedule:${schedule.id}`,
        });
      }
      // Pure handoff: invoke the callback (default logs only). Never run
      // effects/adapters here — WorkerLoop owns execution.
      this.onTask({ schedule, task });
      handedOff.push({ schedule, task });
    }
    return handedOff;
  }

  start({ immediate = false } = {}) {
    if (this.timer) return { started: true, stop: () => this.stop() };
    this.timer = setInterval(() => {
      try {
        const out = this.pollOnce();
        if (out?.catch) out.catch(() => {});
      } catch {
        // Polling must never throw; WorkerLoop surfaces errors separately.
      }
    }, this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.started = true;
    if (immediate) {
      try {
        this.pollOnce();
      } catch {
        // ignore immediate errors; interval continues
      }
    }
    return { started: true, stop: () => this.stop() };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    return { stopped: true };
  }
}

export const DUE_RUNNER_POLL_MS = POLL_MS;
