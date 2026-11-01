// Routes a task to the runtime that can execute its kind. Kinds whose runtime
// is not ready stay queued (e.g. `computer` while the laptop node is offline).
export class KindRouterAdapter {
  constructor({ byKind, fallback = null }) { this.byKind = byKind; this.fallback = fallback; }

  #for(kind) { return this.byKind[kind] ?? this.fallback; }

  readyKinds() { return Object.entries(this.byKind).filter(([, a]) => a.status().ready).map(([k]) => k); }

  status() {
    const ready = this.readyKinds();
    if (ready.length) return { ready: true, kinds: ready };
    const first = Object.values(this.byKind)[0];
    return first ? first.status() : { ready: false, reason: 'no_adapters' };
  }

  get consecutiveFailures() { return Math.max(0, ...Object.values(this.byKind).map((a) => a.consecutiveFailures ?? 0)); }
  get breakerOpenUntil() { return Math.max(0, ...Object.values(this.byKind).map((a) => a.breakerOpenUntil ?? 0)); }

  run(opts) {
    const a = this.#for(opts.kind ?? 'agent');
    if (!a) return Promise.resolve({ status: 'failed', error: `no_runtime_for_kind:${opts.kind}` });
    return a.run(opts);
  }
}
