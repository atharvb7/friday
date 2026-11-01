// Away days: while the owner is away (a trip, exams, a day off) Friday holds back what would ask for his
// attention or speak in his name on a schedule: the morning briefing, reminders-to-act nudges, prospecting runs
// and outreach sending/follow-ups. Reminders he set still fire, alerts about Friday itself still come, and
// everything resumes on its own when the away window ends. Stored in settings 'away' as { from, until, note }.
const DAY = 86_400_000;

export function awayWindow(settings, now = Date.now()) {
  const a = settings?.get('away', null);
  if (!a?.until) return null;
  const t = typeof now === 'number' ? now : now.getTime();
  if (Date.parse(a.until) <= t) return null;
  if (a.from && Date.parse(a.from) > t) return null;
  return a;
}
export const isAway = (settings, now) => Boolean(awayWindow(settings, now));

export function awayTools(settings, { now = () => Date.now(), timezone = () => 'UTC', parseWhen }) {
  const at = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return new Date(now() + Number(s) * DAY).toISOString();
    try { return parseWhen(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59` : s, timezone()).toISOString(); } // a plain date = to the end of that day
    catch { throw new TypeError(`${name}: a date like 2026-11-10, a datetime, or a number of days`); }
  };
  return [
    {
      name: 'away_set', risk: 'safe',
      description: "He'll be away (trip, exams, a day off): until then hold the morning briefing, to-do/approval nudges, prospecting runs and outreach sending. Reminders he set still fire. until: date (2026-11-10 = to the end of that day), datetime, or number of days; from: when it starts (default now).",
      parameters: { type: 'object', properties: { until: { type: 'string' }, from: { type: 'string' }, note: { type: 'string' } }, required: ['until'], additionalProperties: false },
      run: (a) => {
        try {
          const until = at(a.until, 'until'); const from = at(a.from, 'from');
          if (Date.parse(until) <= now()) return { error: 'until must be in the future' };
          if (Date.parse(until) - now() > 60 * DAY) return { error: 'at most 60 days' };
          const v = { from, until, note: String(a.note ?? '').slice(0, 200) || null, set_at: new Date(now()).toISOString() };
          settings.set('away', v); return { away: v };
        } catch (e) { return { error: e.message }; }
      },
    },
    {
      name: 'away_clear', risk: 'safe',
      description: "He's back (or the trip was cancelled): resume briefings, nudges, prospecting and outreach now.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: () => { const was = settings.get('away', null); settings.set('away', null); return { cleared: Boolean(was), was }; },
    },
  ];
}
