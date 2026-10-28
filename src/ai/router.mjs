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
const NOT_FOUND_COOLDOWN_MS = 30 * 60_000; // "function not found / not entitled" does not fix itself in a minute
const MAX_HINT_MS = 6 * 3600_000;
// Failures that say "not now" skip the model at once (one wasted round trip, not three): rate limits for as long as the
// provider asks, overload (503 "high demand") and stalls for a minute. Hard skips are never retried as a last resort.
const HARD_KINDS = new Set(['auth', 'quota', 'not_found']);
// A screenshot question answers in 2-6 s when the model is healthy; waiting the default 30 s on a stalled one before
// falling back made "what's on my screen" take 41 s (28 Oct). Deep reasoning keeps the provider's longer limit.
const ROLE_STALL_MS = { vision: 12_000 };

export class AllModelsFailed extends Error {
  constructor(role, attempts) {
    super(`all_models_failed(${role}): ${attempts.map((a) => `${a.key}=${a.error}`).join('; ')}`);
    this.name = 'AllModelsFailed';
    this.attempts = attempts;
  }
}

// Roles that keep the model's reasoning pass. Tool turns (execute) MUST keep it: without it
// nemotron-3.5-super answered "remind me in 2 hours" with "Done!" and no tool call 6/6 times
// (6/6 correct with it, at 1.2-2.7 s). Tool-less chat and JSON extraction skip it.
export const DEFAULT_THINKING_ROLES = Object.freeze(['execute', 'reason', 'plan', 'computer', 'vision']);

export class ModelRouter {
  #providers = new Map();
  #breakers = new Map();
  #lastModel = null;

  // chains: { chat: [{provider:'nvidia', model:'...'}], reason: [...], embed: [...] }
  constructor({ db = null, bus = null, chains = {}, now = () => Date.now(), thinkingRoles = DEFAULT_THINKING_ROLES } = {}) {
    this.db = db;
    this.thinkingRoles = new Set(thinkingRoles);
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
  #hardOpen(key) { const b = this.#breakers.get(key); return this.#open(key) && HARD_KINDS.has(b.kind); }
  #fail(key, error) {
    const b = this.#breakers.get(key) ?? { failures: 0, openUntil: 0, lastError: null, kind: null };
    b.failures += 1; b.lastError = error.message?.slice(0, 200); b.kind = error.kind;
    const hint = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? Math.min(error.retryAfterMs, MAX_HINT_MS) : null;
    if (error.kind === 'auth') b.openUntil = this.now() + AUTH_COOLDOWN_MS;
    else if (error.kind === 'not_found') b.openUntil = this.now() + NOT_FOUND_COOLDOWN_MS;
    else if (error.kind === 'rate' || error.kind === 'quota') b.openUntil = this.now() + (hint ?? BREAKER_COOLDOWN_MS);
    else if ((error.kind === 'overload' && error.status === 503) || (error.kind === 'timeout' && /stalled/.test(error.message))) b.openUntil = this.now() + BREAKER_COOLDOWN_MS;
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

  async run(role, { prefer = null, ...opts } = {}) {
    let chain = (this.chains[role] ?? this.chains.chat ?? []).filter((e) => this.#providers.get(e.provider)?.configured);
    // prefer: providers to try first for this call (stable within each group), e.g. a job one model does best
    if (Array.isArray(prefer) && prefer.length) chain = [...chain.filter((e) => prefer.includes(e.provider)), ...chain.filter((e) => !prefer.includes(e.provider))];
    if (!chain.length) throw new AllModelsFailed(role, [{ key: role, error: 'no_provider_configured' }]);
    const attempts = [];
    const rejectedBy = new Set(); // providers that refused this request as malformed: their other models would too
    // Last resort: when every model was skipped only for a soft reason (cooling down after overload/rate), try them
    // anyway rather than failing the turn without a single request.
    const passes = [chain, chain.filter((e) => this.#open(this.#key(e)) && !this.#hardOpen(this.#key(e)))];
    for (const [pass, list] of passes.entries()) {
      if (pass === 1 && attempts.some((a) => a.error !== 'circuit_open')) break;
      for (const entry of list) {
        const key = this.#key(entry);
        if (rejectedBy.has(entry.provider)) continue;
        if (pass === 0 && this.#open(key)) { attempts.push({ key, error: 'circuit_open' }); continue; }
        const t0 = this.now();
        try {
          const out = await this.#providers.get(entry.provider).complete({ thinking: this.thinkingRoles.has(role), ...(ROLE_STALL_MS[role] ? { stallMs: ROLE_STALL_MS[role] } : {}), ...opts, model: entry.model });
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
          if (!pe.retryable && pe.kind !== 'auth') {
            // Bad request: no model of this provider will accept it, but another provider may (schemas and
            // parameters are checked differently). Only when no other provider is left is it final.
            rejectedBy.add(entry.provider);
            if (!chain.some((e) => !rejectedBy.has(e.provider))) throw pe;
          }
        }
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

export function thinkingRolesFromEnv(env) {
  return env.FRIDAY_THINKING_ROLES !== undefined ? String(env.FRIDAY_THINKING_ROLES).split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_THINKING_ROLES;
}

// Env-driven wiring. Defaults: fast model for turns, biggest model for deep thinking.
export function chainsFromEnv(env) {
  const parse = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return { provider: x.slice(0, i), model: x.slice(i + 1) }; });
  const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b';
  const SUPER = 'nvidia/nemotron-3.5-super-vl-120b-a12b'; // nemotron-3-super's hosted endpoint returns 404 since Oct 2026
  const LIGHT = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const fb = env.FRIDAY_FALLBACK_MODEL ? [{ provider: 'fallback', model: env.FRIDAY_FALLBACK_MODEL }] : [];
  const n = (m) => ({ provider: 'nvidia', model: m });
  // Gemini Flash scores about twice Nemotron on the Intelligence Index, but the free tier allows 5 requests/minute and
  // 20 requests/DAY per model (AI Studio limits page, Oct 2026; 3.5-flash shares 3.6-flash's quota) and 3.8-flash is often "high
  // demand". So by default it only leads the low-volume, high-value roles (deep reasoning, planning); chat and tool turns
  // would spend the day's quota in ten messages. The router skips a limited model for as long as Google says (an hour
  // for the daily quota), so calls drop to Nemotron at once. FRIDAY_GEMINI_ROLES=chat,execute,reason,plan widens it.
  const gRoles = new Set(String(env.FRIDAY_GEMINI_ROLES ?? 'reason,plan').split(',').map((x) => x.trim()));
  const g = (role, ...models) => (gRoles.has(role) ? models.map((m) => ({ provider: 'gemini', model: m })) : []);
  const G38 = env.FRIDAY_GEMINI_MODEL ?? 'gemini-3.8-flash';
  const G36 = env.FRIDAY_GEMINI_MODEL_2 ?? 'gemini-3.6-flash';
  // Outage backup on a second company: when the whole NVIDIA chain is down, turns still get answered. Flash-Lite is
  // weaker than Nemotron (AA index 22 vs 23-26) but the free tier allows 15 RPM / 500 RPD. '' turns it off.
  const backup = (env.FRIDAY_GEMINI_BACKUP_MODEL ?? 'gemini-3.5-flash-lite') ? [{ provider: 'gemini', model: env.FRIDAY_GEMINI_BACKUP_MODEL ?? 'gemini-3.5-flash-lite' }] : [];
  const gVision = env.FRIDAY_GEMINI_VISION_MODEL ?? 'gemini-3.5-flash-lite';
  return {
    chat: env.FRIDAY_MODELS_CHAT ? parse(env.FRIDAY_MODELS_CHAT) : [...g('chat', G38, G36), n(SUPER), n(ULTRA), n(LIGHT), ...backup, ...fb],
    execute: env.FRIDAY_MODELS_EXECUTE ? parse(env.FRIDAY_MODELS_EXECUTE) : [...g('execute', G38, G36), n(SUPER), n(ULTRA), n(LIGHT), ...backup, ...fb],
    reason: env.FRIDAY_MODELS_REASON ? parse(env.FRIDAY_MODELS_REASON) : [...g('reason', G38), n(ULTRA), ...g('reason', G36), n(SUPER), n(LIGHT), ...backup, ...fb],
    plan: env.FRIDAY_MODELS_PLAN ? parse(env.FRIDAY_MODELS_PLAN) : [...g('plan', G38), n(ULTRA), ...g('plan', G36), n(SUPER), n(LIGHT), ...backup, ...fb],
    // Driving a real website needs the strongest model: slower per step, far fewer wasted steps.
    computer: env.FRIDAY_MODELS_COMPUTER ? parse(env.FRIDAY_MODELS_COMPUTER) : [n(ULTRA), n(SUPER), ...fb],
    extract: env.FRIDAY_MODELS_EXTRACT ? parse(env.FRIDAY_MODELS_EXTRACT) : [n(SUPER), n(LIGHT), ...fb], // Super follows the JSON-only instruction; Lightning rambles
    // Screenshots (voice "what's on my screen", computer agent screen reading + click coordinates on a 0-1000 grid).
    // Measured 28 Oct on real screenshots: Flash-Lite 2-6 s, exact text, 1-4 px at 1920x1080 (500 free requests/day);
    // Super-VL 4-8 px but 2.5-22 s and misread a path; Nemotron Omni 3-7 s when it answers (often 503). ~1k prompt
    // tokens per image on all three. FRIDAY_GEMINI_VISION_MODEL='' keeps images on NVIDIA.
    vision: env.FRIDAY_MODELS_VISION ? parse(env.FRIDAY_MODELS_VISION) : [...(gVision ? [{ provider: 'gemini', model: gVision }] : []), n(SUPER), n('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')],
    embed: [{ provider: 'nvidia', model: env.FRIDAY_EMBED_MODEL ?? 'nvidia/nemotron-3-embed-1b' }],
  };
}
