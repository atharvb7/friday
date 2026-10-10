// src/pet.mjs — PetStateMachine: display-only companion state for the dashboard.
//
// AUTHORITY NOTE: this machine NEVER grants authority. It is a read-only
// renderer hint driven by task/worker/provider events. It cannot approve
// effects, run tools, claim tasks, or touch the network. Effect approval
// stays exclusively in the existing POST /v1/effects/:id/approve flow with
// a single-use token + exact-args match. Emergency stop / circuit-breaker
// decisions are made by the worker/governor; this machine only mirrors them
// as `blocked` / `offline` for the pet face.

export const STATES = Object.freeze([
  'sleeping',
  'listening',
  'thinking',
  'acting',
  'waiting',
  'blocked',
  'offline',
  'done',
]);

// Event -> { from: allowed origins ('*' = any), to: destination }.
// Derived from /v1/status + task events:
// - task running            -> acting
// - approval needed         -> waiting (human must approve in dashboard)
// - emergency stop latched  -> blocked
// - provider circuit open   -> offline
const TRANSITIONS = Object.freeze({
  wake: Object.freeze({ from: ['sleeping'], to: 'listening' }),
  hear: Object.freeze({ from: ['listening'], to: 'thinking' }),
  task_running: Object.freeze({ from: ['thinking', 'listening'], to: 'acting' }),
  approval_needed: Object.freeze({ from: ['thinking', 'acting'], to: 'waiting' }),
  approved: Object.freeze({ from: ['waiting'], to: 'thinking' }),
  task_done: Object.freeze({ from: ['acting'], to: 'done' }),
  rest: Object.freeze({ from: ['done'], to: 'sleeping' }),
  sleep: Object.freeze({ from: ['listening', 'thinking', 'waiting', 'done'], to: 'sleeping' }),
  emergency: Object.freeze({ from: ['sleeping', 'listening', 'thinking', 'acting', 'waiting', 'offline', 'done'], to: 'blocked' }),
  circuit_open: Object.freeze({ from: ['sleeping', 'listening', 'thinking', 'acting', 'waiting', 'blocked', 'done'], to: 'offline' }),
  recovered: Object.freeze({ from: ['blocked', 'offline'], to: 'sleeping' }),
  adapter_ready: Object.freeze({ from: ['offline'], to: 'listening' }),
});

export const EVENTS = Object.freeze(Object.keys(TRANSITIONS));

export class PetStateMachine {
  constructor(initial = 'sleeping') {
    if (!STATES.includes(initial)) throw new RangeError(`unknown pet state: ${initial}`);
    this.state = initial;
    this.listeners = new Set();
  }

  getState() {
    return this.state;
  }

  // Register a read-only observer. Receives frozen { from, to, event, at }.
  // Returns an unsubscribe function. Listeners cannot mutate the machine.
  subscribe(cb) {
    if (typeof cb !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // Apply one event. Throws RangeError on unknown events or disallowed
  // (from, event) pairs. Returns the new state on success.
  transition(event) {
    if (typeof event !== 'string' || !event) throw new TypeError('event must be a non-empty string');
    const rule = TRANSITIONS[event];
    if (!rule) throw new RangeError(`unknown_event: ${event}`);
    if (!rule.from.includes(this.state)) {
      throw new RangeError(`invalid_transition: event ${event} not allowed from ${this.state}`);
    }
    const from = this.state;
    this.state = rule.to;
    const payload = Object.freeze({ from, to: rule.to, event, at: new Date().toISOString() });
    for (const cb of [...this.listeners]) {
      try {
        cb(payload);
      } catch {
        // Listener errors never break machine logic.
      }
    }
    return this.state;
  }
}
