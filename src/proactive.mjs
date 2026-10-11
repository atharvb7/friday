// Proactive Friday: speaks up only when something deserves attention, with hard
// anti-annoyance limits: quiet hours, a daily cap, and per-topic dedupe.
// Reminders the user asked for and task results are NOT subject to these limits
// (they asked for them); this module covers what Friday volunteers.
import { statfsSync } from 'node:fs';
import { inQuietHours, partsInTz, systemTimezone } from './time.mjs';
import { buildSystemPrompt, normalizePersonality } from './personality.mjs';

export const DEFAULT_PROACTIVE = Object.freeze({
  enabled: true, maxPerDay: 6, quietHours: { start: '22:00', end: '08:00' },
  briefing: { enabled: true, time: '09:00' }, stuckMinutes: 30, queuedStallMinutes: 10,
});

const HOUR = 3600_000;

export class Proactive {
  #timer = null;
  constructor({ store, notifications, jobs, ai, memory, settings, bus = null, agentReady = () => true, dataDir = '.', now = () => new Date() }) {
    Object.assign(this, { store, notifications, jobs, ai, memory, settings, bus, agentReady, dataDir, now });
    this.db = store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS proactive_log (key TEXT NOT NULL, ts TEXT NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS proactive_log_idx ON proactive_log (key, ts)');
  }

  config() {
    const c = this.settings.get('proactive', {});
    return { ...DEFAULT_PROACTIVE, ...c, quietHours: { ...DEFAULT_PROACTIVE.quietHours, ...(c.quietHours ?? {}) }, briefing: { ...DEFAULT_PROACTIVE.briefing, ...(c.briefing ?? {}) } };
  }
  setConfig(patch) {
    const next = { ...this.config(), ...patch, quietHours: { ...this.config().quietHours, ...(patch.quietHours ?? {}) }, briefing: { ...this.config().briefing, ...(patch.briefing ?? {}) } };
    const t = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (![next.quietHours.start, next.quietHours.end, next.briefing.time].every((x) => t.test(x))) throw new TypeError('times must be HH:MM');
    if (!(Number.isInteger(next.maxPerDay) && next.maxPerDay >= 0 && next.maxPerDay <= 50)) throw new TypeError('maxPerDay 0..50');
    this.settings.set('proactive', next);
    return next;
  }

  start(intervalMs = 60_000) {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
    this.#timer.unref();
  }
  stop() { clearInterval(this.#timer); this.#timer = null; }

  #seen(key, windowMs) { return Boolean(this.db.prepare('SELECT 1 FROM proactive_log WHERE key=? AND ts > ? LIMIT 1').get(key, new Date(this.now().getTime() - windowMs).toISOString())); }
  #sentLast24h() { return this.db.prepare('SELECT COUNT(*) AS n FROM proactive_log WHERE ts > ?').get(new Date(this.now().getTime() - 24 * HOUR).toISOString()).n; }
  #note(key) { this.db.prepare('INSERT INTO proactive_log (key, ts) VALUES (?, ?)').run(key, this.now().toISOString()); }

  #send(key, windowMs, n) {
    if (this.#seen(key, windowMs)) return false;
    if (this.#sentLast24h() >= this.config().maxPerDay) return false;
    this.#note(key);
    this.notifications.create(n);
    this.bus?.publish('proactive.sent', { key });
    return true;
  }

  async tick() {
    const cfg = this.config();
    if (!cfg.enabled) return { sent: 0 };
    const tz = this.settings.get('timezone', null) ?? systemTimezone();
    const quiet = inQuietHours(this.now(), tz, cfg.quietHours);
    let sent = 0;
    if (!quiet) {
      const now = this.now().getTime();
      for (const t of this.store.listTasks()) {
        if (t.status === 'running' && now - Date.parse(t.updated_at) > cfg.stuckMinutes * 60_000) {
          sent += this.#send(`stuck:${t.id}`, 365 * 24 * HOUR, { level: 'warning', title: `Still working: ${t.title}`, body: `This has been running over ${cfg.stuckMinutes} minutes. Say the word and I'll cancel it.`, taskId: t.id }) ? 1 : 0;
        }
      }
      const stalled = this.store.listTasks().filter((t) => t.status === 'queued' && now - Date.parse(t.created_at) > cfg.queuedStallMinutes * 60_000);
      if (stalled.length && !this.agentReady()) {
        sent += this.#send('runtime-down', 6 * HOUR, { level: 'warning', title: 'My agent runtime is down', body: `${stalled.length} task(s) are waiting and can't start until it's back.` }) ? 1 : 0;
      }
      try {
        const fs = statfsSync(this.dataDir);
        if ((fs.bavail * fs.bsize) / 1073741824 < 2) sent += this.#send('disk-low', 24 * HOUR, { level: 'error', title: 'Disk space is low', body: 'Under 2 GiB free where I store data.' }) ? 1 : 0;
      } catch { /* no statfs: skip */ }
      const chat = this.ai.status().chains.chat ?? [];
      if (chat.length && chat.every((e) => !e.configured || e.circuitOpen)) {
        sent += this.#send('brain-down', 6 * HOUR, { level: 'error', title: 'My cloud brain is unreachable', body: "Chat falls back to offline mode until a model answers again." }) ? 1 : 0;
      }
      try { // things that are blocked on the user: one gentle nudge each, after 2 hours
        for (const a of this.db.prepare("SELECT id, summary, created_at FROM approvals WHERE status='pending'").all()) {
          if (now - Date.parse(a.created_at) > 2 * HOUR) sent += this.#send(`nudge-approval:${a.id}`, 365 * 24 * HOUR, { level: 'warning', title: 'Still waiting for your OK', body: `${String(a.summary).slice(0, 200)}\nApprove or deny it in the Inbox and I'll carry on.` }) ? 1 : 0;
        }
        for (const q of this.db.prepare("SELECT id, question, created_at FROM agent_questions WHERE status='pending'").all()) {
          if (now - Date.parse(q.created_at) > 2 * HOUR) sent += this.#send(`nudge-question:${q.id}`, 365 * 24 * HOUR, { level: 'warning', title: 'A task is paused on your answer', body: String(q.question).slice(0, 200) }) ? 1 : 0;
        }
      } catch { /* tables may not exist in minimal setups */ }
      sent += (await this.maybeBriefing(cfg, tz)) ? 1 : 0;
    }
    return { sent, quiet };
  }

  async maybeBriefing(cfg, tz) {
    if (!cfg.briefing.enabled) return false;
    const p = partsInTz(this.now(), tz);
    const today = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const [bh, bm] = cfg.briefing.time.split(':').map(Number);
    const since = p.h * 60 + p.mi - (bh * 60 + bm);
    if (since < 0 || since > 180) return false; // a briefing is for the morning: a late start skips it
    if (this.settings.get('last_briefing_date') === today) return false;
    this.settings.set('last_briefing_date', today); // set first: a slow model call must not double-send
    const text = await this.composeBriefing(tz);
    this.notifications.create({ level: 'info', title: '☀️ Your briefing', body: text });
    this.bus?.publish('proactive.sent', { key: `briefing:${today}` });
    return true;
  }

  gather(tz) {
    const now = this.now().getTime();
    const tasks = this.store.listTasks();
    const active = tasks.filter((t) => ['queued', 'planning', 'running', 'waiting'].includes(t.status));
    const attention = tasks.filter((t) => ['blocked', 'failed'].includes(t.status) && now - Date.parse(t.updated_at) < 3 * 24 * HOUR);
    const finished = tasks.filter((t) => t.status === 'completed' && now - Date.parse(t.updated_at) < 24 * HOUR);
    const endOfDay = new Date(now + 24 * HOUR).toISOString();
    const reminders = this.jobs ? this.jobs.list({ status: 'active' }).filter((j) => j.due_at <= endOfDay) : [];
    const pinned = this.memory.pinned(4);
    return { active, attention, finished, reminders, pinned, tz };
  }

  async composeBriefing(tz) {
    const g = this.gather(tz);
    const fmt = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    const facts = [
      `Reminders next 24h: ${g.reminders.map((r) => `${r.title} @ ${fmt(r.due_at)}`).join('; ') || 'none'}`,
      `Needs attention (blocked/failed): ${g.attention.map((t) => `${t.title} [${t.status}]`).join('; ') || 'none'}`,
      `In progress: ${g.active.map((t) => t.title).join('; ') || 'none'}`,
      `Finished in last 24h: ${g.finished.map((t) => `${t.title}: ${String(t.result ?? '').slice(0, 120)}`).join(' | ') || 'none'}`,
      `Pinned context: ${g.pinned.map((m) => m.content).join('; ') || 'none'}`,
    ].join('\n');
    const fallback = `Morning. ${g.reminders.length} reminder(s) in the next 24h, ${g.attention.length} item(s) needing attention, ${g.active.length} task(s) in progress, ${g.finished.length} finished.`;
    if (!this.ai.hasProvider) return fallback;
    try {
      const sys = buildSystemPrompt({ personality: normalizePersonality(this.settings.get('personality', {})), mood: this.mood?.current?.() ?? null, userName: this.settings.get('user_name', null), timezone: tz, now: this.now() });
      const out = await this.ai.chat([
        { role: 'system', content: `${sys}\n\nWrite the user's morning briefing from ONLY the facts below. Max ~120 words. Sections in this order, skipping empty ones: needs you today, in progress, finished, one suggested focus. Do not invent items.` },
        { role: 'user', content: facts },
      ], { maxTokens: 1200, temperature: 0.5 });
      return out.content.trim() || fallback;
    } catch { return fallback; }
  }
}
