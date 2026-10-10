// src/provider.mjs — resilient wrapper around any adapter with run()/status().
// Phase 1 durable-handoff requirements:
// - transient provider failures retry with capped exponential backoff;
// - consecutive failures open a circuit breaker (fast-fail without spawning);
// - abort/timeout/cancel are never retried; crash-after-click stays inspectable;
// - /v1/status can report breaker state honestly; no local-model impersonation.
const TRANSIENT_RE = /(timeout|temporar|rate.?limit|429|503|502|500|econn|etimedout|socket hang up|overloaded|try again)/i;

export function isTransientError(message) {
  return TRANSIENT_RE.test(String(message ?? ''));
}

export class ResilientAdapter {
  constructor({ inner, maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 8000, breakerThreshold = 3, breakerCooldownMs = 60000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (!inner || typeof inner.run !== 'function' || typeof inner.status !== 'function') throw new TypeError('inner adapter with run()/status() required');
    this.inner = inner;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.breakerThreshold = breakerThreshold;
    this.breakerCooldownMs = breakerCooldownMs;
    this.sleep = sleep;
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
    this.lastError = null;
    this.lastAttemptAt = null;
  }

  status(now = Date.now()) {
    if (now < this.breakerOpenUntil) {
      return { ...(this.inner.status?.() ?? { ready: false }), ready: false, reason: 'provider_circuit_open', consecutiveFailures: this.consecutiveFailures };
    }
    const s = this.inner.status();
    if (!s.ready) return s;
    return { ...s, consecutiveFailures: this.consecutiveFailures };
  }

  async run({ taskId, instruction, signal } = {}) {
    if (Date.now() < this.breakerOpenUntil) {
      return { status: 'failed', error: `provider_circuit_open: retry after ${new Date(this.breakerOpenUntil).toISOString()}` };
    }
    let attempt = 0;
    let lastError = 'provider failed';
    while (attempt < this.maxAttempts) {
      attempt += 1;
      this.lastAttemptAt = new Date().toISOString();
      if (signal?.aborted) {
        const e = new Error(signal.reason?.message ?? 'dsh_cancelled');
        e.name = 'AbortError';
        throw e;
      }
      let result;
      try {
        result = await this.inner.run({ taskId, instruction, signal });
      } catch (error) {
        // Abort must propagate so WorkerLoop marks blocked, not failed.
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        lastError = error?.message ?? 'provider failed';
        if (attempt < this.maxAttempts && isTransientError(lastError)) {
          await this.sleep(Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1)));
          continue;
        }
        this.#recordFailure(lastError);
        return { status: 'failed', error: lastError };
      }
      if (result?.status === 'completed') {
        this.consecutiveFailures = 0;
        this.lastError = null;
        return result;
      }
      lastError = result?.error ?? 'provider failed';
      // Do not retry explicit non-transient states (auth, missing binary, circuit).
      if (!isTransientError(lastError)) {
        this.#recordFailure(lastError);
        return result;
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1)));
        continue;
      }
      this.#recordFailure(lastError);
      return { status: 'failed', error: lastError };
    }
    this.#recordFailure(lastError);
    return { status: 'failed', error: lastError };
  }

  #recordFailure(message) {
    this.consecutiveFailures += 1;
    this.lastError = String(message ?? 'provider failed');
    if (this.consecutiveFailures >= this.breakerThreshold) {
      this.breakerOpenUntil = Date.now() + this.breakerCooldownMs;
    }
  }
}
