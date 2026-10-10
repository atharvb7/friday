// Model router: the ONLY place that knows which provider/model answers.
//   ai.chat / ai.execute  — interactive turns (fast model first)
//   ai.reason / ai.plan   — hard thinking (biggest model first)
//   ai.embed              — vectors for memory
// Fallback walks the role's chain; per-model circuit breakers skip models that
// keep failing. Every call is recorded (latency, tokens, outcome) in SQLite.
import { ProviderError } from './openai-compat.mjs';

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;

export class AllModelsFailed extends Error {
  constructor(role, attempts) {
    super(`all_models_failed(${role}): ${attempts.map((a) => `${a.key}=${a.error}`).join('; ')}`);
    this.name = 'AllModelsFailed';
    this.attempts = attempts;
  }
}

export class ModelRouter {
  #providers = new Map();
  #breakers = new Map();
  #lastModel = null;

  // chains: { chat: [{provider:'nvidia', model:'...'}], reason: [...], embed: [...] }
  constructor({ db = null, bus = null, chains = {}, now = () => Date.now() } = {}) {
    this.db = db;
    this.bus = bus;
    this.chains = chains;
    this.now = now;
    if (db) {
      db.exec(`CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        latency_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, ok INTEGER NOT NULL, error TEXT
      )`);
    }
  }

  register(provider) { this.#providers.set(provider.name, provider); return this; }
  get hasProvider() { return [...this.#providers.values()].some((p) => p.configured); }

  #key(e) { return `${e.provider}:${e.model}`; }
  #open(key) { const b = this.#breakers.get(key); return b && b.openUntil > this.now(); }
  #fail(key, error) {
    const b = this.#breakers.get(key) ?? { failures: 0, openUntil: 0, lastError: null };
    b.failures += 1; b.lastError = error.message?.slice(0, 200);
    if (error.kind === 'auth') b.openUntil = this.now() + AUTH_COOLDOWN_MS;
    else if (b.failures >= BREAKER_THRESHOLD) b.openUntil = this.now() + BREAKER_COOLDOWN_MS;
    this.#breakers.set(key, b);
  }
  #ok(key) { this.#breakers.delete(key); }

  #record(role, entry, ms, usage, ok, error) {
    if (!this.db) return;
    try {
      this.db.prepare('INSERT INTO model_calls (ts, role, provider, model, latency_ms, prompt_tokens, completion_tokens, ok, error) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(new Date().toISOString(), role, entry.provider, entry.model, ms, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, ok ? 1 : 0, error ? String(error).slice(0, 300) : null);
    } catch { /* observability must never break a call */ }
  }

  async run(role, opts = {}) {
    const chain = (this.chains[role] ?? this.chains.chat ?? []).filter((e) => this.#providers.get(e.provider)?.configured);
    if (!chain.length) throw new AllModelsFailed(role, [{ key: role, error: 'no_provider_configured' }]);
    const attempts = [];
    for (const entry of chain) {
      const key = this.#key(entry);
      if (this.#open(key)) { attempts.push({ key, error: 'circuit_open' }); continue; }
      const t0 = this.now();
      try {
        const out = await this.#providers.get(entry.provider).complete({ ...opts, model: entry.model });
        this.#ok(key);
        this.#record(role, entry, this.now() - t0, out.usage, true);
        if (this.#lastModel !== key) { this.bus?.publish('model.changed', { role, provider: entry.provider, model: entry.model, from: this.#lastModel }); this.#lastModel = key; }
        return { ...out, provider: entry.provider, role, attempts };
      } catch (error) {
        if (opts.signal?.aborted) throw error; // user cancelled: never fall through
        const pe = error instanceof ProviderError ? error : new ProviderError(error.message, { retryable: true });
        this.#record(role, entry, this.now() - t0, null, false, pe.message);
        this.#fail(key, pe);
        this.bus?.publish('model.failed', { role, provider: entry.provider, model: entry.model, kind: pe.kind, error: pe.message.slice(0, 160) });
        attempts.push({ key, error: pe.message.slice(0, 120) });
        if (!pe.retryable && pe.kind !== 'auth') throw pe; // bad request: another model will not fix it
      }
    }
    throw new AllModelsFailed(role, attempts);
  }

  chat(messages, opts = {}) { return this.run('chat', { messages, ...opts }); }
  execute(messages, opts = {}) { return this.run('execute', { messages, ...opts }); }
  reason(messages, opts = {}) { return this.run('reason', { messages, maxTokens: 8192, ...opts }); }
  plan(messages, opts = {}) { return this.run('plan', { messages, maxTokens: 8192, ...opts }); }

  async embed(texts, { inputType = 'passage', signal = null } = {}) {
    const chain = (this.chains.embed ?? []).filter((e) => this.#providers.get(e.provider)?.configured);
    const attempts = [];
    for (const entry of chain) {
      const key = this.#key(entry);
      if (this.#open(key)) { attempts.push({ key, error: 'circuit_open' }); continue; }
      const t0 = this.now();
      try {
        const out = await this.#providers.get(entry.provider).embed({ model: entry.model, input: texts, inputType, signal });
        this.#ok(key);
        this.#record('embed', entry, this.now() - t0, out.usage, true);
        return { ...out, provider: entry.provider };
      } catch (error) {
        if (signal?.aborted) throw error;
        const pe = error instanceof ProviderError ? error : new ProviderError(error.message, { retryable: true });
        this.#record('embed', entry, this.now() - t0, null, false, pe.message);
        this.#fail(key, pe);
        attempts.push({ key, error: pe.message.slice(0, 120) });
      }
    }
    throw new AllModelsFailed('embed', attempts.length ? attempts : [{ key: 'embed', error: 'no_provider_configured' }]);
  }

  status() {
    const rows = {};
    for (const [role, chain] of Object.entries(this.chains)) {
      rows[role] = chain.map((e) => {
        const key = this.#key(e);
        const b = this.#breakers.get(key);
        return { ...e, configured: Boolean(this.#providers.get(e.provider)?.configured), circuitOpen: this.#open(key), consecutiveFailures: b?.failures ?? 0, lastError: b?.lastError ?? null };
      });
    }
    return { chains: rows, lastModel: this.#lastModel };
  }

  stats(sinceMs = 24 * 3600_000) {
    if (!this.db) return [];
    const since = new Date(this.now() - sinceMs).toISOString();
    return this.db.prepare(`SELECT role, provider, model, COUNT(*) AS calls, SUM(ok) AS ok_calls, ROUND(AVG(latency_ms)) AS avg_ms,
      COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens
      FROM model_calls WHERE ts >= ? GROUP BY role, provider, model ORDER BY calls DESC`).all(since);
  }
}

// Env-driven wiring. Defaults: fast model for turns, biggest model for deep thinking.
export function chainsFromEnv(env) {
  const parse = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return { provider: x.slice(0, i), model: x.slice(i + 1) }; });
  const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b';
  const SUPER = 'nvidia/nemotron-3-super-120b-a12b';
  const LIGHT = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const fb = env.FRIDAY_FALLBACK_MODEL ? [{ provider: 'fallback', model: env.FRIDAY_FALLBACK_MODEL }] : [];
  const n = (m) => ({ provider: 'nvidia', model: m });
  return {
    chat: env.FRIDAY_MODELS_CHAT ? parse(env.FRIDAY_MODELS_CHAT) : [n(SUPER), n(ULTRA), n(LIGHT), ...fb],
    execute: env.FRIDAY_MODELS_EXECUTE ? parse(env.FRIDAY_MODELS_EXECUTE) : [n(SUPER), n(ULTRA), n(LIGHT), ...fb],
    reason: env.FRIDAY_MODELS_REASON ? parse(env.FRIDAY_MODELS_REASON) : [n(ULTRA), n(SUPER), n(LIGHT), ...fb],
    plan: env.FRIDAY_MODELS_PLAN ? parse(env.FRIDAY_MODELS_PLAN) : [n(ULTRA), n(SUPER), n(LIGHT), ...fb],
    vision: env.FRIDAY_MODELS_VISION ? parse(env.FRIDAY_MODELS_VISION) : [n('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')],
    embed: [{ provider: 'nvidia', model: env.FRIDAY_EMBED_MODEL ?? 'nvidia/nemotron-3-embed-1b' }],
  };
}
