import { h, clear, fmtLocal } from '../util.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function recText(r) {
  if (!r) return 'once';
  if (r.type === 'interval') return `every ${r.minutes} min`;
  if (r.type === 'daily') return `daily at ${r.time}`;
  if (r.type === 'weekdays') return `weekdays at ${r.time}`;
  if (r.type === 'weekly') return `${r.days.map((d) => DAYS[d - 1]).join('/')} at ${r.time}`;
  return `monthly on day ${r.day} at ${r.time}`;
}

export function render({ api, toast }) {
  const list = h('div', { class: 'list' });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h2', {}, 'Reminders & schedules'), h('button', { class: 'btn small', onclick: create }, '+ New')), list);

  async function load() {
    const { jobs } = await api('/v1/jobs');
    clear(list);
    if (!jobs.length) list.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '⏰'), 'Nothing scheduled. Say “remind me tomorrow at 9 to call mom” in chat.'));
    for (const j of jobs) {
      list.append(h('div', { class: 'card item' }, h('div', { class: 'big' }, j.kind === 'task' ? '🤖' : '⏰'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, j.title), h('div', { class: 'meta' }, `next: ${fmtLocal(j.due_at, j.timezone)} · ${recText(j.recurrence)}${j.kind === 'task' ? ' · runs an agent' : ''}`)),
        h('button', { class: 'btn small', onclick: async () => { await api(`/v1/jobs/${j.id}/snooze`, { method: 'POST', body: { minutes: 60 } }); toast('Pushed 1 hour.'); load(); } }, '+1h'),
        h('button', { class: 'btn small bad', onclick: async () => { await api(`/v1/jobs/${j.id}`, { method: 'DELETE' }); load(); } }, 'Cancel')));
    }
  }

  function create() {
    const dlg = h('dialog');
    const kind = h('select', {}, h('option', { value: 'reminder' }, 'Reminder'), h('option', { value: 'task' }, 'Scheduled agent task'));
    const title = h('input', { type: 'text', placeholder: 'What?', maxlength: 200 });
    const body = h('textarea', { rows: 3, placeholder: 'Agent instructions (for scheduled tasks)', hidden: true });
    kind.addEventListener('change', () => { body.hidden = kind.value !== 'task'; });
    const when = h('input', { type: 'datetime-local' });
    const rec = h('select', {}, [['', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly (Mondays)'], ['monthly', 'Monthly'], ['interval', 'Every N minutes']].map(([v, l]) => h('option', { value: v }, l)));
    const time = h('input', { type: 'time', value: '09:00' });
    const mins = h('input', { type: 'number', min: 5, value: 60, hidden: true });
    rec.addEventListener('change', () => { mins.hidden = rec.value !== 'interval'; time.hidden = rec.value === 'interval' || rec.value === ''; when.hidden = Boolean(rec.value); });
    time.hidden = true;
    dlg.append(h('form', { method: 'dialog', class: 'stack' }, h('h2', {}, 'New schedule'), kind, title, body,
      h('div', {}, h('label', {}, 'Repeat'), rec), h('div', {}, h('label', {}, 'When (your timezone)'), when, time, mins),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', value: 'ok' }, 'Create'), h('button', { class: 'btn quiet', value: 'cancel' }, 'Cancel'))));
    document.body.append(dlg); dlg.showModal();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue === 'ok' && title.value.trim()) {
        const recurrence = !rec.value ? null : rec.value === 'interval' ? { type: 'interval', minutes: Number(mins.value) } : rec.value === 'weekly' ? { type: 'weekly', days: [1], time: time.value } : rec.value === 'monthly' ? { type: 'monthly', day: new Date().getDate(), time: time.value } : { type: rec.value, time: time.value };
        try { await api('/v1/jobs', { method: 'POST', body: { kind: kind.value, title: title.value, body: body.value, when: recurrence ? null : when.value, recurrence } }); load(); }
        catch (e) { toast(e.message); }
      }
      dlg.remove();
    });
  }
  const onEvent = () => {};
  load();
  return { el, destroy() { void onEvent; } };
}
