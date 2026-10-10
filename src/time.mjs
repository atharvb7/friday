// Timezone-correct scheduling math using only Intl (no dependencies).
const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) dtfCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }));
  return dtfCache.get(tz);
}
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimezone(tz) { try { dtf(tz); return true; } catch { return false; } }
export function systemTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }

// Wall-clock parts of an instant in a zone. dow: Mon=1..Sun=7.
export function partsInTz(date, tz) {
  const p = Object.fromEntries(dtf(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, dow: DOW[p.weekday] };
}

// Wall-clock time in a zone -> UTC Date (handles DST by iterating on the offset).
export function zonedToUtc({ y, m, d, h = 0, mi = 0 }, tz) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = partsInTz(new Date(guess), tz);
    const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const diff = Date.UTC(y, m - 1, d, h, mi) - asIfUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateRecurrence(rec) {
  if (rec == null) return null;
  const t = rec.type;
  if (t === 'interval') { if (!Number.isInteger(rec.minutes) || rec.minutes < 5 || rec.minutes > 60 * 24 * 30) throw new TypeError('interval minutes must be 5..43200'); return { type: t, minutes: rec.minutes }; }
  if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(t)) throw new TypeError('recurrence type must be interval|daily|weekdays|weekly|monthly');
  if (!TIME_RE.test(rec.time ?? '')) throw new TypeError('recurrence time must be HH:MM');
  if (t === 'weekly' && (!Array.isArray(rec.days) || !rec.days.length || !rec.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7))) throw new TypeError('weekly days must be 1..7 (Mon=1)');
  if (t === 'monthly' && !(Number.isInteger(rec.day) && rec.day >= 1 && rec.day <= 31)) throw new TypeError('monthly day must be 1..31');
  return { type: t, time: rec.time, ...(t === 'weekly' ? { days: [...new Set(rec.days)].sort() } : {}), ...(t === 'monthly' ? { day: rec.day } : {}) };
}

// First occurrence strictly after `after` (Date), in zone `tz`. Returns Date.
export function nextOccurrence(rec, after, tz) {
  if (rec.type === 'interval') return new Date(after.getTime() + rec.minutes * 60_000);
  const [hh, mm] = rec.time.split(':').map(Number);
  const base = partsInTz(after, tz);
  for (let off = 0; off <= 800; off++) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + off));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const dow = ((day.getUTCDay() + 6) % 7) + 1;
    if (rec.type === 'weekdays' && dow > 5) continue;
    if (rec.type === 'weekly' && !rec.days.includes(dow)) continue;
    if (rec.type === 'monthly' && (rec.day > daysInMonth(y, m) || d !== rec.day)) continue;
    const cand = zonedToUtc({ y, m, d, h: hh, mi: mm }, tz);
    if (cand.getTime() > after.getTime()) return cand;
  }
  throw new Error('no_next_occurrence');
}

// Parse a user/model supplied time: ISO with offset/Z is absolute; otherwise local wall-clock in tz.
export function parseWhen(text, tz) {
  const s = String(text ?? '').trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const t = Date.parse(s); if (Number.isNaN(t)) throw new TypeError('invalid time'); return new Date(t); }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) throw new TypeError('time must be ISO 8601, e.g. 2026-10-12T09:30 (local) or with an offset');
  return zonedToUtc({ y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5] }, tz);
}

export function inQuietHours(date, tz, { start = '22:00', end = '08:00' } = {}) {
  const p = partsInTz(date, tz);
  const now = p.h * 60 + p.mi;
  const [sh, sm] = start.split(':').map(Number), [eh, em] = end.split(':').map(Number);
  const a = sh * 60 + sm, b = eh * 60 + em;
  return a === b ? false : a < b ? now >= a && now < b : now >= a || now < b;
}

// Human-readable local time, e.g. "Sat 10 Oct 2026, 16:36 (Asia/Kolkata)".
export function formatLocal(date, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return `${p.replace(',', '')} (${tz})`;
}
