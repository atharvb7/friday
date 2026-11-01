import { h, md, clear, timeAgo } from '../util.js';

export function render({ app, api, toast, refresh }) {
  let tab = 'approvals';
  const body = h('div', { class: 'list' });
  const tabs = h('div', { class: 'tabs' });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h2', {}, 'Inbox'), h('button', { class: 'btn small', onclick: markAll }, 'Mark all read')), tabs, body);

  async function totpFor() {
    if (app.needsCode?.() && app.totpActive) { const c = prompt('Authenticator code (6 digits)'); return c ? c.trim() : null; }
    return undefined;
  }
  async function decide(a, approve) {
    const totp = await totpFor(); if (totp === null) return;
    try { await api(`/v1/approvals/${a.id}/decide`, { method: 'POST', body: { approve }, totp }); toast(approve ? 'Approved — doing it now.' : 'Denied.'); }
    catch (e) { toast(e.message === 'totp_required' ? 'A valid authenticator code is required.' : `Failed: ${e.message}`); }
    load(); refresh();
  }
  const rawPayload = (x) => h('pre', { class: 'mono bubble payload-raw' }, JSON.stringify(x.payload, null, 2).slice(0, 40000));
  // Outreach batches read like the emails they are: who, subject, the formatted body.
  const emailPreview = (emails) => h('div', { class: 'stack payload-emails' }, ...emails.map((e, i) => h('div', { class: 'bubble stack' },
    h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, `${i + 1}. ${e.company ?? e.to ?? e.lead_id ?? ''}`), e.to ? h('span', { class: 'faint small' }, e.to) : null, h('span', { class: 'chip' }, e.follow_up ? 'follow-up' : 'first email')),
    e.subject ? h('div', {}, h('span', { class: 'faint small' }, 'Subject: '), h('strong', {}, e.subject)) : null,
    h('div', {}, md(String(e.body ?? '').slice(0, 6000))))));
  async function markAll() { await api('/v1/notifications/read-all', { method: 'POST' }); load(); refresh(); }

  async function load() {
    const [a, n, qs] = await Promise.all([api('/v1/approvals'), api('/v1/notifications'), api('/v1/questions')]);
    clear(tabs);
    for (const [k, label, count] of [['approvals', 'Approvals', a.approvals.length], ['questions', 'Questions', qs.questions.length], ['notifications', 'Notifications', n.unread]]) {
      tabs.append(h('button', { class: `tab${tab === k ? ' active' : ''}`, onclick: () => { tab = k; load(); } }, label, count ? ` (${count})` : ''));
    }
    clear(body);
    if (tab === 'approvals') {
      if (!a.approvals.length) body.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '✅'), 'Nothing waiting on you.'));
      for (const x of a.approvals) {
        body.append(h('div', { class: 'card stack' },
          h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, x.summary), h('span', { class: `chip ${x.risk === 'critical' ? 'bad' : 'warn'}` }, x.risk), h('span', { class: 'chip' }, x.category), h('span', { class: 'faint' }, timeAgo(x.created_at))),
          ...(Array.isArray(x.payload?.emails) ? [emailPreview(x.payload.emails), h('details', {}, h('summary', { class: 'faint small' }, 'Exact payload'), rawPayload(x))] : [rawPayload(x)]),
          h('div', { class: 'row' }, h('button', { class: 'btn good', onclick: () => decide(x, true) }, 'Approve'), h('button', { class: 'btn bad', onclick: () => decide(x, false) }, 'Deny'),
            h('span', { class: 'faint small' }, 'Approving runs exactly what is shown above.'))));
      }
    } else if (tab === 'questions') {
      if (!qs.questions.length) body.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '💬'), 'No task is waiting on an answer.'));
      for (const q of qs.questions) {
        const inp = h('input', { type: 'text', placeholder: q.field ? `Your ${q.field} (saved for next time)` : 'Your answer', 'aria-label': 'Answer' });
        const send = async () => { try { await api(`/v1/questions/${q.id}/answer`, { method: 'POST', body: { answer: inp.value } }); toast('Sent — carrying on.'); load(); } catch (e) { toast(e.message); } };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
        body.append(h('div', { class: 'card stack' }, h('strong', {}, q.question), h('div', { class: 'row' }, inp, h('button', { class: 'btn primary', onclick: send }, 'Send')), h('span', { class: 'faint' }, timeAgo(q.created_at))));
      }
    } else {
      if (!n.notifications.length) body.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🔔'), 'No notifications yet.'));
      for (const x of n.notifications) {
        const lvl = { success: 'good', error: 'bad', warning: 'warn' }[x.level] ?? '';
        body.append(h('div', { class: 'card click', onclick: async () => { if (!x.read_at) { await api(`/v1/notifications/${x.id}/read`, { method: 'POST' }); load(); refresh(); } } },
          h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, (x.read_at ? '' : '● ') + x.title), h('span', { class: `chip ${lvl}` }, x.level), h('span', { class: 'faint' }, timeAgo(x.created_at))),
          x.body ? h('div', { class: 'muted bubble' }, md(x.body.slice(0, 1200))) : null));
      }
    }
  }
  const onEvent = (e) => { if (e.type === 'notification.created' || e.type.startsWith('approval.') || e.type.startsWith('question.')) load(); };
  app.listeners.add(onEvent); load();
  return { el, destroy() { app.listeners.delete(onEvent); } };
}
