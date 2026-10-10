// Network layer: bearer token, JSON requests, SSE-over-fetch (so no secret is ever in a URL).
const KEY = 'friday.token';
let token = '';
try { token = localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || ''; } catch { /* storage blocked */ }

export const auth = {
  get token() { return token; },
  set(t, remember) {
    token = t;
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); (remember ? localStorage : sessionStorage).setItem(KEY, t); } catch { /* ignore */ }
  },
  clear() { token = ''; try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
};

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

export async function api(path, { method = 'GET', body, totp, headers = {}, signal } = {}) {
  const res = await fetch(path, {
    method, signal, cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(totp ? { 'X-Friday-Totp': totp } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data.error || `request failed (${res.status})`);
  return data;
}

// Parse a text/event-stream body into {event, data} frames.
export async function readSse(res, onFrame) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message', data = '', id = null;
      for (const l of raw.split('\n')) { if (l.startsWith('event: ')) event = l.slice(7); else if (l.startsWith('data: ')) data += l.slice(6); else if (l.startsWith('id: ')) id = l.slice(4); }
      if (data) { try { onFrame({ event, data: JSON.parse(data), id }); } catch { /* skip bad frame */ } }
    }
  }
}

// Live event feed with auto-reconnect and Last-Event-ID resume.
export function startEvents(onEvent, onState) {
  let stop = false, lastId = 0, ctrl = null, delay = 1000;
  (async function loop() {
    while (!stop) {
      ctrl = new AbortController();
      try {
        const res = await fetch('/v1/events', { headers: { Authorization: `Bearer ${token}`, ...(lastId ? { 'Last-Event-ID': String(lastId) } : {}) }, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401) { onState('unauthorized'); return; }
        if (!res.ok) throw new Error(`events ${res.status}`);
        onState('online'); delay = 1000;
        await readSse(res, (f) => { lastId = Math.max(lastId, Number(f.id) || 0); onEvent(f.data); });
      } catch { /* fall through to reconnect */ }
      if (stop) return;
      onState('offline');
      await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 15000);
    }
  })();
  return () => { stop = true; ctrl?.abort(); };
}

// Streaming chat. Calls handlers for meta/delta/thinking/tool/done/error.
export async function streamChat({ message, conversationId }, h, signal) {
  const res = await fetch('/v1/chat', { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, conversationId, stream: true }) });
  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    let e = {}; try { e = await res.json(); } catch { /* ignore */ }
    throw new ApiError(res.status, e.error || `chat failed (${res.status})`);
  }
  await readSse(res, (f) => h[f.event]?.(f.data));
}
