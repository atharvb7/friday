// Remembers which "caring check-ins" Friday made recently so she doesn't nag
// (water/food/sleep/breaks) every message, like a real person wouldn't.
const TOPICS = {
  water: { re: /\b(water|hydrat\w*|chug)\b/i, cooldownMin: 90 },
  food: { re: /\b(hungry|eat(en)?|lunch|dinner|breakfast|snack|meal)\b/i, cooldownMin: 150 },
  sleep: { re: /\b(sleep|bedtime|go to bed|nap|rest up)\b/i, cooldownMin: 240 },
  break: { re: /\b(take a break|stretch|posture|screen break|step away)\b/i, cooldownMin: 120 },
};

export class Habits {
  constructor({ settings, now = () => Date.now() }) { Object.assign(this, { settings, now }); }

  // Call with each assistant reply to the owner.
  record(replyText) {
    const s = this.settings.get('habits', {});
    let changed = false;
    for (const [k, t] of Object.entries(TOPICS)) if (t.re.test(replyText)) { s[k] = this.now(); changed = true; }
    if (changed) this.settings.set('habits', s);
  }

  // Prompt text for topics still cooling down ('' if none).
  cooldownNote() {
    const s = this.settings.get('habits', {});
    const lines = [];
    for (const [k, t] of Object.entries(TOPICS)) {
      const ago = s[k] ? Math.round((this.now() - s[k]) / 60_000) : null;
      if (ago !== null && ago < t.cooldownMin) lines.push(`${k}: you already brought it up ${ago} min ago — do not mention it again for about ${t.cooldownMin - ago} more minutes (unless he raises it)`);
    }
    return lines.length ? `RECENT CHECK-INS (don't nag):\n- ${lines.join('\n- ')}` : '';
  }
}
