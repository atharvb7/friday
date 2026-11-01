// Spend and limits in one place. Every model call is already in model_calls (router + metered clients such as
// JEV); this prices them, knows each provider's daily request limits, and tells the router to skip a model whose
// day is used up (instead of spending a round trip on a refusal). Overrides: settings 'usage_limits'
// ({ "provider:model": requestsPerDay }), so a changed quota needs no deploy.
import { partsInTz, zonedToUtc } from './time.mjs';

// USD per million tokens. 0 = free tier. A model missing here is "unpriced" and listed as such, never guessed.
export const PRICES = {
  'nvidia:*': { in: 0, out: 0, note: 'NVIDIA hosted API (free tier)' },
  'gemini:*': { in: 0, out: 0, note: 'Google AI Studio free tier' },
  'local:*': { in: 0, out: 0, note: 'your own model' },
  'typesafe:jev-1.14.0': { in: 0.042, out: null, note: 'JEV: input price only (output tokens are tiny)' },
};

// Requests per day (AI Studio limits page, Oct 2026). Gemini's day resets at midnight Pacific time; a group shares one quota.
export const LIMITS = {
  'gemini:gemini-3.8-flash': { rpd: 20, tz: 'America/Los_Angeles' },
  'gemini:gemini-3.6-flash': { rpd: 20, tz: 'America/Los_Angeles', group: 'gemini-3.6-flash' },
  'gemini:gemini-3.5-flash': { rpd: 20, tz: 'America/Los_Angeles', group: 'gemini-3.6-flash' },
  'gemini:gemini-3.5-flash-lite': { rpd: 500, tz: 'America/Los_Angeles' },
};

const priceOf = (provider, model) => PRICES[`${provider}:${model}`] ?? PRICES[`${provider}:*`] ?? null;
function usd(p, inTok, outTok) {
  if (!p) return null;
  return (p.in ?? 0) * (inTok ?? 0) / 1e6 + (p.out ?? 0) * (outTok ?? 0) / 1e6;
}

export class Usage {
  constructor({ db, settings = null, now = () => Date.now() }) {
    Object.assign(this, { db, settings, now });
    try { db.exec('CREATE INDEX IF NOT EXISTS model_calls_pm_ts ON model_calls (provider, model, ts)'); } catch { /* table made by the router */ }
  }

  #tz() { return this.settings?.get('timezone', null) ?? Intl.DateTimeFormat().resolvedOptions().timeZone; }
  #dayStart(tz) { const p = partsInTz(new Date(this.now()), tz); return zonedToUtc({ y: p.y, m: p.m, d: p.d, h: 0, mi: 0 }, tz).toISOString(); }

  limits() {
    const out = structuredClone(LIMITS);
    const over = this.settings?.get('usage_limits', null) ?? {};
    for (const [k, v] of Object.entries(over)) { const n = Number(v); if (Number.isFinite(n) && n >= 0) out[k] = { ...(out[k] ?? { tz: 'UTC' }), rpd: Math.round(n) }; }
    return out;
  }

  setLimit(key, rpd) {
    if (!/^[a-z0-9_-]+:[\w./:-]+$/i.test(String(key))) throw new TypeError('key must be provider:model');
    const over = { ...(this.settings.get('usage_limits', null) ?? {}) };
    if (rpd === null) delete over[key];
    else { const n = Number(rpd); if (!Number.isInteger(n) || n < 0 || n > 1e6) throw new TypeError('rpd must be a whole number >= 0, or null to reset'); over[key] = n; }
    this.settings.set('usage_limits', over);
    return this.limits();
  }

  // Successful calls today (in the limit's own day) across the model's quota group.
  usedToday(key, lim = this.limits()[key]) {
    if (!lim) return 0;
    const members = Object.entries(this.limits()).filter(([k, l]) => k === key || (lim.group && l.group === lim.group)).map(([k]) => k.split(':'));
    let n = 0;
    for (const [provider, model] of members) {
      n += this.db.prepare('SELECT COUNT(*) AS n FROM model_calls WHERE provider=? AND model=? AND ok=1 AND ts >= ?').get(provider, model, this.#dayStart(lim.tz ?? 'UTC')).n;
    }
    return n;
  }

  // For the router: a reason to skip this model now, or null.
  capReason({ provider, model }) {
    const key = `${provider}:${model}`; const lim = this.limits()[key];
    if (!lim) return null;
    const used = this.usedToday(key, lim);
    return used >= lim.rpd ? `daily_cap: ${used}/${lim.rpd} requests used today (resets midnight ${lim.tz})` : null;
  }

  summary() {
    const tz = this.#tz(); const today = this.#dayStart(tz);
    const monthStart = (() => { const p = partsInTz(new Date(this.now()), tz); return zonedToUtc({ y: p.y, m: p.m, d: 1, h: 0, mi: 0 }, tz).toISOString(); })();
    const rows = (since) => this.db.prepare(`SELECT provider, model, COUNT(*) AS calls, SUM(ok=0) AS errors, SUM(COALESCE(prompt_tokens,0)) AS input_tokens,
      SUM(COALESCE(completion_tokens,0)) AS output_tokens FROM model_calls WHERE ts >= ? GROUP BY provider, model ORDER BY calls DESC`).all(since);
    const limits = this.limits();
    const shape = (r, withLimit) => {
      const p = priceOf(r.provider, r.model); const key = `${r.provider}:${r.model}`;
      const lim = withLimit ? limits[key] : null;
      return { provider: r.provider, model: r.model, calls: r.calls, errors: r.errors, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
        usd: usd(p, r.input_tokens, r.output_tokens), priced: !!p, ...(lim ? { limit: lim.rpd, used_today: this.usedToday(key, lim), resets: `midnight ${lim.tz}` } : {}) };
    };
    const t = rows(today).map((r) => shape(r, true)); const m = rows(monthStart).map((r) => shape(r, false));
    // Limited models with no calls yet today still show their headroom.
    for (const [key, lim] of Object.entries(limits)) if (!t.some((r) => `${r.provider}:${r.model}` === key)) {
      const [provider, model] = key.split(':'); t.push({ provider, model, calls: 0, errors: 0, input_tokens: 0, output_tokens: 0, usd: 0, priced: !!priceOf(provider, model), limit: lim.rpd, used_today: this.usedToday(key, lim), resets: `midnight ${lim.tz}` });
    }
    const total = (list) => list.reduce((s, r) => s + (r.usd ?? 0), 0);
    const serp = this.settings?.get('serp_usage', null);
    return {
      timezone: tz, today: t, month: m,
      usd_today: total(t), usd_month: total(m),
      unpriced: [...new Set(m.filter((r) => !r.priced).map((r) => `${r.provider}:${r.model}`))],
      serpapi: serp ? { month: serp.month, used: serp.n, budget: this.settings.get('prospecting', null)?.serp_budget ?? null } : null,
      prices: PRICES,
    };
  }
}
