// Central event bus: one stream of typed events that every interface (web, phone,
// pet, ESP32, logs) consumes. In-memory ring buffer for replay; durable truth
// stays in SQLite (task events, audit chain).
export class EventBus {
  #subs = new Set();
  #buf = [];
  #seq = 0;
  constructor({ size = 500 } = {}) { this.size = size; }

  publish(type, data = {}) {
    if (typeof type !== 'string' || !type) throw new TypeError('event type required');
    const evt = { id: ++this.#seq, ts: new Date().toISOString(), type, data };
    this.#buf.push(evt);
    if (this.#buf.length > this.size) this.#buf.shift();
    for (const fn of this.#subs) { try { fn(evt); } catch { /* a bad subscriber must never break publishing */ } }
    return evt;
  }

  subscribe(fn) { this.#subs.add(fn); return () => this.#subs.delete(fn); }
  since(id = 0) { return this.#buf.filter((e) => e.id > id); }
  get lastId() { return this.#seq; }
  get subscriberCount() { return this.#subs.size; }
}
