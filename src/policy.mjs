// Autonomy policy. Personality never reaches this file: privileges are decided
// only by (category, risk class, the user's configured level for that category).
//
//   levels:  ask < trusted < autonomous < high
//   risk:    routine        reversible / low impact
//            consequential  affects other people or lasting state (send, publish, write outside workspace)
//            critical       money, destructive deletes, security/system changes, production deploys
//
//   routine       -> allowed from `trusted` up
//   consequential -> allowed from `autonomous` up
//   critical      -> allowed ONLY under `high`, which is time-boxed and auto-reverts
export const CATEGORIES = Object.freeze(['research', 'coding', 'browser', 'computer', 'messaging', 'spending', 'deletion', 'system']);
export const LEVELS = Object.freeze(['ask', 'trusted', 'autonomous', 'high']);
export const RISKS = Object.freeze(['routine', 'consequential', 'critical']);

export const DEFAULT_LEVELS = Object.freeze({
  // computer is trusted: the owner gave Friday full routine use of his laptop (apps, screen, typing, shell, files) without
  // asking. Anything that sends, spends, deletes or changes the system is classified into those categories and still asks.
  research: 'autonomous', coding: 'trusted', browser: 'trusted', computer: 'trusted', messaging: 'ask', spending: 'ask', deletion: 'ask', system: 'ask',
});

const MAX_HIGH_HOURS = 12;
const rank = (l) => LEVELS.indexOf(l);

export class Policy {
  constructor({ settings, bus = null, now = () => Date.now() }) { Object.assign(this, { settings, bus, now }); }

  #state() {
    const s = this.settings.get('autonomy', {});
    return { levels: { ...DEFAULT_LEVELS, ...(s.levels ?? {}) }, highUntil: s.highUntil ?? {} };
  }

  // Effective level after expiring any lapsed `high` grant.
  level(category) {
    const s = this.#state();
    const l = s.levels[category] ?? 'ask';
    if (l === 'high' && !(Date.parse(s.highUntil[category] ?? '') > this.now())) return 'autonomous';
    return l;
  }

  snapshot() {
    const s = this.#state();
    return Object.fromEntries(CATEGORIES.map((c) => [c, { level: this.level(c), until: this.level(c) === 'high' ? s.highUntil[c] : null }]));
  }

  set(category, level, { hours = 4 } = {}) {
    if (!CATEGORIES.includes(category)) throw new TypeError('unknown category');
    if (!LEVELS.includes(level)) throw new TypeError('unknown level');
    const s = this.#state();
    s.levels[category] = level;
    if (level === 'high') {
      if (!(hours > 0 && hours <= MAX_HIGH_HOURS)) throw new TypeError(`high autonomy lasts at most ${MAX_HIGH_HOURS}h`);
      s.highUntil[category] = new Date(this.now() + hours * 3600_000).toISOString();
    } else delete s.highUntil[category];
    this.settings.set('autonomy', s);
    this.bus?.publish('autonomy.changed', { category, level });
    return this.snapshot()[category];
  }

  // Panic button: every `high` grant ends immediately (levels fall back to autonomous).
  revokeHigh() {
    const s = this.#state();
    for (const c of CATEGORIES) if (s.levels[c] === 'high') s.levels[c] = 'autonomous';
    s.highUntil = {};
    this.settings.set('autonomy', s);
    this.bus?.publish('autonomy.changed', { category: '*', level: 'revoked-high' });
  }

  // -> 'allow' | 'ask' | 'deny'
  decide({ category, risk = 'routine', forbidden = false }) {
    if (forbidden) return 'deny';
    if (!CATEGORIES.includes(category) || !RISKS.includes(risk)) return 'ask'; // unknown => fail closed to a human
    const r = rank(this.level(category));
    if (risk === 'routine') return r >= rank('trusted') ? 'allow' : 'ask';
    if (risk === 'consequential') return r >= rank('autonomous') ? 'allow' : 'ask';
    return this.level(category) === 'high' ? 'allow' : 'ask';
  }
}
