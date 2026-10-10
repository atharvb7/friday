// src/nemotron.mjs — Nemotron direct HTTP provider for Friday.
// Same adapter interface as DshAdapter: status() / run({taskId, instruction,
// signal}). Calls NVIDIA's OpenAI-compatible Chat Completions endpoint, so no
// `dsh` binary is needed. DSH remains the agent-turn runtime when its binary +
// verified profile exist; this provider is the reasoning route behind it.
//
// Key ONLY from FRIDAY_NVIDIA_API_KEY (never NVIDIA_API_KEY passthrough,
// never logged, redacted from errors). Without a key status() reports
// `nemotron_not_configured` and run() fails closed — the server then serves
// chat in local-fallback mode with an honest banner.
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length > 4) out = out.split(s).join('[redacted]');
  }
  return out;
}

export class NemotronProvider {
  constructor({ apiKey = null, baseUrl = null, model = null, models = null, systemPrompt = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey ?? process.env.FRIDAY_NVIDIA_API_KEY ?? null;
    this.baseUrl = (baseUrl ?? process.env.FRIDAY_NEMOTRON_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const chain = models
      ?? (process.env.FRIDAY_NEMOTRON_MODELS ? process.env.FRIDAY_NEMOTRON_MODELS.split(',').map((s) => s.trim()).filter(Boolean) : null)
      ?? [model ?? process.env.FRIDAY_NEMOTRON_MODEL ?? DEFAULT_MODEL];
    this.models = [...new Set(chain)];
    this.model = this.models[0];
    this.systemPrompt = systemPrompt ?? 'You are Friday, a concise personal computer agent. Answer briefly, never claim an action you did not take, and ask for confirmation before anything consequential.';
    this.timeoutMs = timeoutMs;
    this.maxOutputChars = maxOutputChars;
    this.fetchImpl = fetchImpl;
  }

  get configured() { return typeof this.apiKey === 'string' && this.apiKey.length > 8; }

  status() {
    if (!this.configured) return { ready: false, reason: 'nemotron_not_configured' };
    return { ready: true, model: this.model };
  }

  // Tries each model in order; moves on after overload (503/429/overloaded),
  // missing entitlement (404), or an empty reasoning-only reply. Other HTTP
  // errors fail fast. Returns the answering model for transparency.
  async run({ taskId, instruction, signal, messages = null } = {}) {
    void taskId;
    if (!this.configured) return { status: 'failed', error: 'nemotron_not_configured' };
    if (signal?.aborted) {
      const e = new Error(signal.reason?.message ?? 'cancelled');
      e.name = 'AbortError';
      throw e;
    }
    const chatMessages = Array.isArray(messages) && messages.length
      ? messages
      : [{ role: 'user', content: String(instruction ?? '') }];
    let lastError = 'nemotron failed';
    for (const model of this.models) {
      let attempt;
      try {
        attempt = await this.#attempt(model, chatMessages, signal);
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
          const e = new Error(signal?.reason?.message ?? error.message ?? 'cancelled');
          e.name = 'AbortError';
          throw e;
        }
        lastError = redact(`nemotron_error: ${error.message ?? error}`, [this.apiKey]).slice(0, 300);
        continue;
      }
      if (attempt.status === 'completed') return attempt;
      lastError = attempt.error;
      if (!attempt.retryNext) return attempt;
    }
    return { status: 'failed', error: lastError };
  }

  async #attempt(model, chatMessages, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('nemotron_timeout')), this.timeoutMs);
    const onAbort = () => ctrl.abort(new Error(signal.reason?.message ?? 'cancelled'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: this.systemPrompt }, ...chatMessages],
          temperature: 0.4,
          max_tokens: 1024,
        }),
      });
      if (!res.ok) {
        const tail = redact(await res.text().catch(() => ''), [this.apiKey]).slice(0, 200);
        const retryNext = res.status === 503 || res.status === 429 || res.status === 404 || /overload/i.test(tail);
        return { status: 'failed', error: `nemotron_http_${res.status}${tail ? `: ${tail}` : ''} [${model}]`, retryNext };
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message ?? {};
      // Reasoning models may put the answer in reasoning_content when the
      // token budget runs out mid-think; prefer real content, fall back to it.
      const text = String(msg.content ?? '').trim() || String(msg.reasoning_content ?? '').trim();
      if (!text) return { status: 'failed', error: `nemotron_empty_reply [${model}]`, retryNext: true };
      const out = text.slice(0, this.maxOutputChars);
      return { status: 'completed', output: out + (text.length > out.length ? '\n[truncated]' : ''), model };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}
