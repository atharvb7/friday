// One Friday state for every body: web pet, desktop pet, phone orb, ESP32 desk
// companion, future AR/VR. Derived purely from real events — never random.
//
// states: idle listening thinking planning researching browsing coding computer_use
//         speaking waiting verifying success error offline
export const COMPANION_STATES = Object.freeze(['idle', 'listening', 'thinking', 'planning', 'researching', 'browsing', 'coding', 'computer_use', 'speaking', 'waiting', 'verifying', 'success', 'error', 'offline']);

// Mapping onto the 3D pet's existing pose vocabulary (public/pet-viewer.js).
const PET = { idle: 'listening', listening: 'listening', thinking: 'thinking', planning: 'thinking', researching: 'acting', browsing: 'acting', coding: 'acting', computer_use: 'acting', speaking: 'listening', waiting: 'waiting', verifying: 'acting', success: 'done', error: 'blocked', offline: 'offline' };
const KIND_STATE = { research: 'researching', coding: 'coding', computer: 'computer_use', agent: 'planning' };
const FLASH_MS = 6000;

export class Companion {
  #flash = null; // { state, until }
  #chatBusy = 0;
  #listening = false;
  #last = null;
  constructor({ ctx, now = () => Date.now() }) {
    this.ctx = ctx; this.now = now;
    ctx.bus.subscribe((e) => this.#on(e));
  }

  #on(e) {
    const t = e.type;
    if (t === 'task.completed') this.#flash = { state: 'success', until: this.now() + FLASH_MS };
    else if (t === 'task.failed' || t === 'system.emergency_stop') this.#flash = { state: 'error', until: this.now() + FLASH_MS };
    else if (t === 'voice.listening') this.#listening = Boolean(e.data?.on);
    if (!['companion.state_changed', 'pet.state_changed'].includes(t) && !t.startsWith('model.') && !t.startsWith('memory.')) this.#emitIfChanged();
  }

  chatStart() { this.#chatBusy++; this.#emitIfChanged(); }
  chatEnd() { this.#chatBusy = Math.max(0, this.#chatBusy - 1); this.#emitIfChanged(); }

  compute() {
    const { ctx } = this;
    const snap = (() => { try { return ctx.governor.getSnapshot(); } catch { return null; } })();
    const running = ctx.worker.running.size ? [...ctx.worker.running.keys()].map((id) => ctx.store.getTask(id)).filter(Boolean) : [];
    const pending = ctx.approvals.list().length;
    let state = 'idle', detail = null;
    if (!ctx.ai.hasProvider && !ctx.dshAdapter.status().ready) state = 'offline';
    else if (ctx.state.emergencyStopped) { state = 'error'; detail = 'emergency stop'; }
    else if (this.#flash && this.#flash.until > this.now()) state = this.#flash.state;
    else if (this.#listening) state = 'listening';
    else if (this.#chatBusy) state = 'thinking';
    else if (pending) { state = 'waiting'; detail = `${pending} approval(s)`; }
    else if (running.length) { const k = running[0].kind; state = KIND_STATE[k] ?? 'planning'; detail = running[0].title; }
    return { state, detail, pet: PET[state], unread: ctx.notifications.unreadCount(), approvals: pending, nodeOnline: ctx.nodes.online, at: new Date(this.now()).toISOString() };
  }

  #emitIfChanged() {
    const c = this.compute();
    if (c.state === this.#last?.state && c.detail === this.#last?.detail) return;
    this.#last = c;
    this.ctx.bus.publish('companion.state_changed', c);
  }
}
