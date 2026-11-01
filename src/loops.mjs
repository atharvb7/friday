// One record for every background loop (pipeline tick, watches, prospector, jobs...), so a loop that keeps
// failing, has stopped running, or hangs is visible instead of looking like a loop with nothing to do.
// loop(name, fn, { everyMs }) wraps a timer callback; attach() gives it a database (state survives restarts)
// and a notifier (one warning per failing streak, one note on recovery). Without attach it works in memory.
const FAIL_ALERT = 3;          // consecutive failures before the owner hears about it
const SAVE_OK_EVERY_MS = 5 * 60_000; // successful runs are saved at most this often (state changes always are)

class LoopRegistry {
  #state = new Map();
  db = null; notify = null; now = () => Date.now();

  attach({ db, notify = null, now } = {}) {
    this.db = db ?? null; this.notify = notify; if (now) this.now = now;
    if (!this.db) return this;
    this.db.exec(`CREATE TABLE IF NOT EXISTS loop_state (
      name TEXT PRIMARY KEY, every_ms INTEGER, last_run TEXT, last_ok TEXT, last_error TEXT, failing_since TEXT,
      streak INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0
    )`);
    for (const r of this.db.prepare('SELECT * FROM loop_state').all()) {
      const cur = this.#state.get(r.name);
      // A loop that already ran in this process keeps its live numbers; the saved row only fills the history.
      if (!cur || !cur.runs) this.#state.set(r.name, { ...this.#blank(r.name, r.every_ms ?? cur?.everyMs), ...this.#fromRow(r), running: cur?.running ?? new Map() });
    }
    return this;
  }

  // Wraps fn for setInterval. Errors are recorded (and never thrown back into the timer).
  loop(name, fn, { everyMs = null } = {}) {
    const s = this.#get(name); if (everyMs) s.everyMs = everyMs;
    let seq = 0;
    return () => {
      const id = ++seq; const started = this.now();
      s.running.set(id, started);
      let p;
      try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
      return p.then(() => this.#done(s, id, started, null), (e) => this.#done(s, id, started, e ?? new Error('failed')));
    };
  }

  #done(s, id, started, error) {
    s.running.delete(id);
    const at = new Date(this.now()).toISOString();
    s.runs++; s.lastRun = at; s.lastMs = this.now() - started;
    if (!error) {
      const recovered = s.streak > 0; const was = s.streak;
      s.lastOk = at; s.streak = 0; s.failingSince = null; s.lastError = null;
      if (recovered && s.alerted) this.#tell('success', `Background job recovered: ${s.name}`, `It is working again after ${was} failed run${was === 1 ? '' : 's'}.`);
      if (recovered) s.alerted = false;
      if (recovered || this.now() - s.savedAt >= SAVE_OK_EVERY_MS) this.#save(s);
      return;
    }
    s.failures++; s.streak++; s.failingSince ??= at;
    s.lastError = String(error?.message ?? error).slice(0, 300);
    if (s.streak >= FAIL_ALERT && !s.alerted) {
      s.alerted = true;
      this.#tell('warning', `Background job failing: ${s.name}`, `${s.streak} runs in a row have failed since ${s.failingSince}. Last error: ${s.lastError}`);
    }
    this.#save(s);
  }

  // Per loop: ok | failing | down (FAIL_ALERT+ in a row) | stale (no run for 3 intervals) | stuck (a run going 10 intervals).
  list() {
    const now = this.now();
    return [...this.#state.values()].map((s) => {
      const oldest = Math.min(...s.running.values());
      const stuck = s.everyMs && Number.isFinite(oldest) && now - oldest > 10 * Math.max(s.everyMs, 60_000);
      const stale = s.everyMs && s.lastRun && now - Date.parse(s.lastRun) > 3 * s.everyMs + 60_000 && !s.running.size;
      const status = stuck ? 'stuck' : s.streak >= FAIL_ALERT ? 'down' : s.streak > 0 ? 'failing' : stale ? 'stale' : s.runs ? 'ok' : 'waiting';
      return { name: s.name, status, every_ms: s.everyMs, last_run: s.lastRun, last_ok: s.lastOk, last_error: s.lastError, failing_since: s.failingSince,
        streak: s.streak, runs: s.runs, failures: s.failures, running: s.running.size, last_ms: s.lastMs ?? null };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  reset() { this.#state.clear(); this.db = null; this.notify = null; this.now = () => Date.now(); }

  #blank(name, everyMs = null) { return { name, everyMs, lastRun: null, lastOk: null, lastError: null, failingSince: null, streak: 0, runs: 0, failures: 0, alerted: false, savedAt: 0, running: new Map() }; }
  #fromRow(r) { return { lastRun: r.last_run, lastOk: r.last_ok, lastError: r.last_error, failingSince: r.failing_since, streak: r.streak, runs: r.runs, failures: r.failures, alerted: !!r.alerted }; }
  #get(name) { let s = this.#state.get(name); if (!s) { s = this.#blank(name); this.#state.set(name, s); } return s; }

  #save(s) {
    s.savedAt = this.now();
    if (!this.db) return;
    try {
      this.db.prepare(`INSERT INTO loop_state (name, every_ms, last_run, last_ok, last_error, failing_since, streak, runs, failures, alerted) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET every_ms=excluded.every_ms, last_run=excluded.last_run, last_ok=excluded.last_ok, last_error=excluded.last_error,
        failing_since=excluded.failing_since, streak=excluded.streak, runs=excluded.runs, failures=excluded.failures, alerted=excluded.alerted`)
        .run(s.name, s.everyMs, s.lastRun, s.lastOk, s.lastError, s.failingSince, s.streak, s.runs, s.failures, s.alerted ? 1 : 0);
    } catch { /* recording must never break the loop */ }
  }

  #tell(level, title, body) { try { this.notify?.({ level, title, body }); } catch { /* best effort */ } }
}

export const loops = new LoopRegistry();
export const loop = (name, fn, opts) => loops.loop(name, fn, opts);
