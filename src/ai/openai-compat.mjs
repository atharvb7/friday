// OpenAI-compatible chat/embeddings client with streaming + tool calls.
// Works for NVIDIA Build (Nemotron), OpenAI, Gemini's compat endpoint,
// OpenRouter, Anthropic's compat layer — anything speaking /chat/completions.
// Keys never leave this class: redacted from every error it throws.

export class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false, kind = 'error', retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.kind = kind; // 'auth' | 'rate' | 'quota' | 'overload' | 'not_found' | 'timeout' | 'empty' | 'bad_request' | 'error'
    this.retryAfterMs = retryAfterMs; // how long this model should be skipped (from the provider's own hint), null = unknown
  }
}

// Rate limits say when to come back: Retry-After, Gemini's "retryDelay": "29s" / "retry in 29.3s".
// A daily quota (Gemini "...PerDay...") is skipped for an hour, then probed again.
function retryHint(headers, text) {
  const h = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(h) && h > 0) return h * 1000;
  const m = /retry ?(?:delay"?:\s*"|in\s+)(\d+(?:\.\d+)?)s/i.exec(text);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

function classify(status, text, headers = null) {
  if (status === 401 || status === 403) return { retryable: false, kind: 'auth' };
  if (status === 404) return { retryable: true, kind: 'not_found' }; // model not entitled -> try next model
  if (status === 429 && /per ?day|daily/i.test(text)) return { retryable: true, kind: 'quota', retryAfterMs: 60 * 60_000 };
  if (status === 429) return { retryable: true, kind: 'rate', retryAfterMs: retryHint(headers, text) };
  if (status >= 500 || /overload/i.test(text)) return { retryable: true, kind: 'overload' };
  return { retryable: false, kind: 'bad_request' };
}

// Placeholder Google accepts for a tool call that another model made (Gemini 3 otherwise rejects the turn with a 400).
const FOREIGN_SIGNATURE = { google: { thought_signature: 'skip_thought_signature_validator' } };

export class OpenAICompatProvider {
  // noThinking: extra body fields that switch a reasoning model's thinking off (provider-specific; null = no switch).
  // thoughtSignatures: Gemini 3 returns a signature on each tool call (extra_content) that must be sent back on the
  //   next step; other providers get the field stripped.
  // stallMs: a streamed reply that sends nothing for this long is abandoned so the router can try the next model.
  // alwaysStream: stream on the wire even when the caller wants one result, so stallMs also guards those calls
  //   (a busy Gemini otherwise holds a plain request open until the full timeout).
  constructor({ name, baseUrl, apiKey = null, fetchImpl = globalThis.fetch, timeoutMs = 120_000, headers = {}, noThinking = null, thoughtSignatures = false, stallMs = 0, alwaysStream = false }) {
    this.alwaysStream = alwaysStream;
    this.name = name;
    this.noThinking = noThinking;
    this.thoughtSignatures = thoughtSignatures;
    this.stallMs = stallMs;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }

  get configured() { return typeof this.apiKey === 'string' && this.apiKey.length > 8; }

  #redact(text) {
    let out = String(text ?? '');
    if (this.apiKey && this.apiKey.length > 4) out = out.split(this.apiKey).join('[redacted]');
    return out;
  }

  #signal(signal, extra = null) {
    const t = AbortSignal.timeout(this.timeoutMs);
    return AbortSignal.any([t, ...(signal ? [signal] : []), ...(extra ? [extra] : [])]);
  }

  // Abort when nothing arrives for stallMs (headers, then each chunk resets it). ping() on progress, stop() when done.
  #stallGuard(ms = this.stallMs) {
    const ctl = new AbortController();
    if (!ms) return { signal: null, ping() {}, stop() {}, get fired() { return false; }, ms };
    let fired = false;
    let timer = null;
    const ping = () => { clearTimeout(timer); timer = setTimeout(() => { fired = true; ctl.abort(); }, ms); };
    ping();
    return { signal: ctl.signal, ping, stop() { clearTimeout(timer); }, get fired() { return fired; }, ms };
  }

  #messages(messages) {
    return messages.map((m) => {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
      return { ...m, tool_calls: m.tool_calls.map(({ extra_content, ...c }) => (this.thoughtSignatures ? { ...c, extra_content: extra_content ?? FOREIGN_SIGNATURE } : c)) };
    });
  }

  async #post(path, body, signal, stall = null) {
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: this.#signal(signal, stall?.signal),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal?.aborted) throw error; // caller cancelled: propagate as-is
      if (stall?.fired) throw new ProviderError(`${this.name}: stalled (no response for ${Math.round(stall.ms / 1000)}s)`, { retryable: true, kind: 'timeout' });
      const timedOut = error?.name === 'TimeoutError' || /timeout/i.test(error?.message ?? '');
      throw new ProviderError(this.#redact(`${this.name}: ${timedOut ? 'timeout' : error.message}`), { retryable: true, kind: timedOut ? 'timeout' : 'error' });
    }
    if (!res.ok) {
      const tail = this.#redact(await res.text().catch(() => '')).slice(0, 300);
      const c = classify(res.status, tail, res.headers);
      throw new ProviderError(`${this.name}_http_${res.status}${tail ? `: ${tail}` : ''}`, { status: res.status, ...c });
    }
    return res;
  }

  // Returns { content, toolCalls, reasoning, usage, finishReason, model }.
  // onDelta(text) receives visible content only; onThinking(text) receives
  // reasoning deltas (never part of the reply).
  async complete({ model, messages, tools = null, toolChoice = 'auto', maxTokens = 4096, temperature = 0.4, stream = false, onDelta = null, onThinking = null, signal = null, thinking = true, extra = {}, stallMs = this.stallMs }) {
    const body = { model, messages: this.#messages(messages), temperature, max_tokens: maxTokens, ...(thinking === false && this.noThinking ? this.noThinking : {}), ...extra };
    if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice; }
    const wire = stream || this.alwaysStream;
    if (wire) { body.stream = true; body.stream_options = { include_usage: true }; }
    const stall = wire ? this.#stallGuard(stallMs) : null;
    let out;
    try {
      const res = await this.#post('/chat/completions', body, signal, stall);
      stall?.ping();
      const ctype = res.headers?.get?.('content-type') ?? 'application/json';
      out = (wire && /event-stream/.test(ctype))
        ? await this.#readStream(res, stream ? onDelta : null, stream ? onThinking : null, stall)
        : this.#readJson(await res.json());
    } catch (error) {
      if (stall?.fired && !signal?.aborted && !(error instanceof ProviderError)) throw new ProviderError(`${this.name}: stalled (no data for ${Math.round(stall.ms / 1000)}s)`, { retryable: true, kind: 'timeout' });
      throw error;
    } finally { stall?.stop(); }
    out.model = model;
    if (!out.content.trim() && !out.toolCalls.length) {
      throw new ProviderError(`${this.name}: empty reply (finish=${out.finishReason ?? '?'})`, { retryable: true, kind: 'empty' });
    }
    if (onDelta && !stream && out.content) onDelta(out.content);
    return out;
  }

  #readJson(data) {
    const choice = data?.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    return {
      content: String(msg.content ?? ''),
      reasoning: String(msg.reasoning_content ?? msg.reasoning ?? ''),
      toolCalls: normalizeToolCalls(msg.tool_calls),
      usage: data?.usage ?? null,
      finishReason: choice.finish_reason ?? null,
    };
  }

  async #readStream(res, onDelta, onThinking, stall = null) {
    const acc = { content: '', reasoning: '', usage: null, finishReason: null };
    const calls = new Map();
    let buf = '';
    const decoder = new TextDecoder();
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch { return; }
      if (j.usage) acc.usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) return;
      if (ch.finish_reason) acc.finishReason = ch.finish_reason;
      const d = ch.delta ?? {};
      if (d.content) { acc.content += d.content; onDelta?.(d.content); }
      const think = d.reasoning_content ?? d.reasoning;
      if (think) { acc.reasoning += think; onThinking?.(think); }
      for (const tc of d.tool_calls ?? []) {
        // OpenAI streams fragments keyed by index; Gemini sends whole calls, sometimes without an index.
        const byId = tc.id ? [...calls.entries()].find(([, c]) => c.id === tc.id)?.[0] : undefined;
        const i = tc.index ?? byId ?? calls.size;
        const cur = calls.get(i) ?? { id: '', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.extra_content) cur.extra_content = tc.extra_content;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(i, cur);
      }
    };
    for await (const chunk of res.body) {
      stall?.ping();
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
    }
    if (buf.trim()) handle(buf.trim());
    acc.toolCalls = normalizeToolCalls([...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v));
    return acc;
  }

  async embed({ model, input, inputType = 'passage', signal = null }) {
    const res = await this.#post('/embeddings', { model, input, input_type: inputType, encoding_format: 'float' }, signal);
    const data = await res.json();
    const vectors = (data?.data ?? []).sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    if (vectors.length !== input.length) throw new ProviderError(`${this.name}: embedding count mismatch`, { retryable: true });
    return { vectors, usage: data.usage ?? null, model };
  }
}

function normalizeToolCalls(raw) {
  return (raw ?? []).filter((t) => t?.function?.name).map((t, i) => {
    const argsText = t.function.arguments ?? '';
    let args = null;
    try { args = argsText ? JSON.parse(argsText) : {}; } catch { args = null; }
    return { id: t.id || `call_${i}`, name: t.function.name, argumentsText: argsText, args, ...(t.extra_content ? { extra: t.extra_content } : {}) };
  });
}
