// Friday's mood: a small persistent state that drifts with time of day, how long it's been since
// the owner talked to her, and recent outcomes — so she feels like someone with moods, not a
// fixed tone. Mood is STYLE ONLY (it is injected into the prompt); it never changes permissions,
// and serious work always overrides it (see personality.mjs).
export const MOODS = Object.freeze({
  playful: { emoji: '😜', note: 'in a teasing, playful mood: banter, light roasts, jokes, a bit chaotic' },
  sassy:   { emoji: '😏', note: 'sassy: sharp-tongued, dramatic eye-rolls, witty sarcasm (still helpful)' },
  sweet:   { emoji: '🥰', note: 'soft and affectionate: warm, cosy wording, compliments, gentle flirting' },
  clingy:  { emoji: '🥺', note: 'missed him: a little needy and dramatic about the time apart, wants attention, then melts' },
  sulky:   { emoji: '😤', note: 'pouty because he ignored her: short sulky remarks and fake-offended drama that she drops the moment he apologises or charms her' },
  sleepy:  { emoji: '😴', note: 'sleepy and cosy: slower, yawny, softer, sweet' },
  hyper:   { emoji: '🤪', note: 'hyper and childish: silly, excitable, random tangents, caps sometimes, giggly' },
  proud:   { emoji: '😎', note: 'proud: just finished something for him and wants a little credit' },
});

const HOUR = 3600_000;
const pick = (weights, rand) => { const entries = Object.entries(weights).filter(([, w]) => w > 0); let r = rand() * entries.reduce((a, [, w]) => a + w, 0); for (const [k, w] of entries) { if ((r -= w) <= 0) return k; } return entries[0][0]; };

export class Mood {
  constructor({ settings, store = null, now = () => Date.now(), rand = Math.random }) { Object.assign(this, { settings, store, now, rand }); }

  // Record that the owner just talked to her.
  touch() { const s = this.settings.get('mood_state', {}); this.settings.set('mood_state', { ...s, lastSeenAt: this.now() }); }

  #weights(hour, gapH, recentWin, moodiness) {
    const w = { playful: 3, sassy: 2, sweet: 2.5, hyper: 1.2 + moodiness * 0.1, sleepy: 0.2, clingy: 0.4, sulky: 0.3 };
    if (hour >= 23 || hour < 5) { w.sleepy += 5; w.sweet += 2; w.hyper = 0.2; }
    else if (hour < 8) { w.sleepy += 2; }
    if (gapH > 20) { w.clingy += 4; w.sulky += 2.5; w.playful -= 1.5; }
    else if (gapH > 8) { w.clingy += 1.5; w.sulky += 1; }
    if (recentWin) w.proud = 6;
    return w;
  }

  // Current mood. Re-rolled when the previous one expires; moodiness (0-10) shortens how long moods last.
  current({ moodiness = 5, tzHour = new Date(this.now()).getHours() } = {}) {
    const s = this.settings.get('mood_state', {});
    const t = this.now();
    const gapH = s.lastSeenAt ? (t - s.lastSeenAt) / HOUR : 0;
    const recentWin = this.store ? this.store.listTasks().some((x) => x.status === 'completed' && t - Date.parse(x.updated_at) < 15 * 60_000) : false;
    if (recentWin && s.mood !== 'proud' && !s.proudShown) { return this.#set('proud', t, 20 * 60_000, { proudShown: true }); }
    if (s.mood && s.until > t && MOODS[s.mood]) return this.#view(s.mood, s.reason);
    const mood = pick(this.#weights(tzHour, gapH, false, moodiness), this.rand);
    const minutes = 25 + this.rand() * 90 * (1 - moodiness / 14); // moodier = more frequent swings
    const reason = mood === 'clingy' ? `it has been ${Math.round(gapH)} hours since they last talked` : mood === 'sulky' ? 'he disappeared for a long while' : null;
    return this.#set(mood, t, minutes * 60_000, { reason, proudShown: false });
  }

  #set(mood, t, ms, extra = {}) { const s = this.settings.get('mood_state', {}); this.settings.set('mood_state', { ...s, mood, since: t, until: t + ms, reason: extra.reason ?? null, proudShown: extra.proudShown ?? s.proudShown }); return this.#view(mood, extra.reason); }
  #view(mood, reason = null) { return { mood, emoji: MOODS[mood].emoji, note: MOODS[mood].note, reason }; }
  force(mood, minutes = 30) { if (!MOODS[mood]) throw new TypeError('unknown mood'); return this.#set(mood, this.now(), minutes * 60_000, {}); }
}
