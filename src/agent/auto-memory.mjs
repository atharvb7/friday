// Friday decides what to remember. After each exchange with the owner a small model call extracts
// durable facts/preferences/plans/important moments and saves them silently (the Memory tab shows
// them with source "auto:chat"; he can edit or delete anything). Never stores secrets, never runs
// for guests, is capped per day, and de-duplicates against what is already known.
const MIN_LEN = 14;
const DAILY_CAP = 60;
const SECRET_RE = /(nvapi-|sk-[a-z0-9]{12,}|ghp_[a-z0-9]{20,}|fdv_[a-f0-9]{16,}|api[_ -]?key|password|passcode|otp|\b\d{12,19}\b|-----BEGIN)/i;
const KINDS = new Set(['preference', 'long_term', 'project', 'episodic']);

const words = (t) => new Set(String(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const jaccard = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };

const SYSTEM = `You maintain a personal assistant's long-term memory about ONE user. From the exchange below, extract only durable, useful facts worth remembering about the USER: preferences, personal facts (people, pets, places, routines, health, studies, job), plans and deadlines, decisions, goals, projects, and emotionally significant events (e.g. "failed an exam today", "got the internship"). 
NOT worth saving: statements about what is NOT known or missing ("name not yet known"), small talk, jokes, questions, the assistant's own words, temporary context, things already known, opinions about the assistant, anything secret (passwords, keys, card numbers).
Output ONLY a JSON array, max 3 memory items, each {"content": "User ... (third person, one clear sentence, include a date/time reference if it is an event)", "kind": "preference|long_term|project|episodic", "importance": 0.0-1.0, "project": null or "name"}.
ALSO, for each concrete thing the USER says HE has to do / submit / finish / attend (assignments, lab manual, prototype, exam, meeting, payment), add a to-do item {"kind": "todo", "content": "short title, e.g. Lab manual", "due": "YYYY-MM-DD or YYYY-MM-DDTHH:MM in his local time, resolved from Now (today/tomorrow/in 2 days/30th), or null", "priority": "high|normal|low"} — up to 6 to-dos, one per item, even if the deadline is vague (null). Not for things the assistant will do. Output [] if nothing is worth saving.`;

export class AutoMemory {
  constructor({ ai, memory, settings, indexer = null, bus = null, commitments = null, now = () => Date.now() }) { Object.assign(this, { ai, memory, settings, indexer, bus, commitments, now }); }

  enabled() { return this.settings.get('auto_memory', true) !== false; }

  async observe({ userText, assistantText, userTimeIso = new Date(this.now()).toISOString() }) {
    if (!this.enabled() || !this.ai.hasProvider) return { saved: 0, reason: 'disabled' };
    const text = String(userText ?? '').trim();
    if (text.length < MIN_LEN || SECRET_RE.test(text)) return { saved: 0, reason: 'skipped' };
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const st = this.settings.get('auto_memory_day', { day, n: 0 });
    const counter = st.day === day ? st : { day, n: 0 };
    if (counter.n >= DAILY_CAP) return { saved: 0, reason: 'daily_cap' };

    let known = [];
    try { known = this.memory.search(text.slice(0, 180), { limit: 5 }); } catch { /* fts is optional */ }
    let out;
    try {
      out = await this.ai.run('extract', { maxTokens: 1800, temperature: 0, messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Now: ${userTimeIso}\n\nAlready known:\n${known.map((m) => `- ${m.content}`).join('\n') || '(nothing relevant)'}\n\nUser said: ${text.slice(0, 1500)}\nAssistant replied: ${String(assistantText ?? '').slice(0, 600)}` },
      ] });
    } catch { return { saved: 0, reason: 'model_unavailable' }; }
    const parsed = this.#parse(out.content);
    let todos = 0;
    for (const it of parsed.filter((x) => x.kind === 'todo').slice(0, 6)) { // deadlines become tracked to-dos, not just memories
      if (!this.commitments || SECRET_RE.test(it.content)) continue;
      try { const r = this.commitments.add({ title: it.content.trim().slice(0, 200), due: typeof it.due === 'string' ? it.due : null, priority: it.priority, source: 'auto:chat' }); if (r.created) todos++; } catch { /* bad date or cap: skip */ }
    }
    if (todos) this.bus?.publish('commitment.auto_added', { count: todos });
    const items = parsed.filter((x) => x.kind !== 'todo');
    let saved = 0;
    for (const it of items.slice(0, 3)) {
      const c = it.content.trim();
      if (c.length < 8 || c.length > 400 || SECRET_RE.test(c)) continue;
      const dup = this.memory.search(c.slice(0, 180), { limit: 5 }).some((m) => jaccard(m.content, c) >= 0.6);
      if (dup) continue;
      try {
        this.memory.create({ content: c, source: 'auto:chat', kind: KINDS.has(it.kind) ? it.kind : 'long_term', project: typeof it.project === 'string' && it.project.length < 100 ? it.project : null, importance: Math.min(1, Math.max(0, Number(it.importance) || 0.5)), confidence: 0.7 });
        saved++;
      } catch { /* invalid item: skip */ }
    }
    if (saved) { this.settings.set('auto_memory_day', { day, n: counter.n + saved }); this.bus?.publish('memory.auto_saved', { count: saved }); }
    return { saved, todos, reason: 'ok' };
  }

  #parse(text) {
    const m = /\[[\s\S]*\]/.exec(String(text ?? ''));
    if (!m) return [];
    try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a.filter((x) => x && typeof x.content === 'string') : []; } catch { return []; }
  }
}
