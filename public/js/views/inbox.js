import { h, md, clear, timeAgo } from '../util.js';

export function render({ app, api, toast, refresh }) {
  let tab = 'approvals';
  const body = h('div', { class: 'list' });
  const tabs = h('div', { class: 'tabs' });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h2', {}, 'Inbox'), h('button', { class: 'btn small', onclick: markAll }, 'Mark all read')), tabs, body);

  async function totpFor() {
    if (app.me?.kind === 'device' && app.totpActive) { const c = prompt('Authenticator code (6 digits)'); return c ? c.trim() : null; }
    return undefined;
  }
  async function decide(a, approve) {
    const totp = await totpFor(); if (totp === null) return;
    try { await api(`/v1/approvals/${a.id}/decide`, { method: 'POST', body: { approve }, totp }); toast(approve ? 'Approved — doing it now.' : 'Denied.'); }
    catch (e) { toast(e.message === 'totp_required' ? 'A valid authenticator code is required.' : `Failed: ${e.message}`); }
    load(); refresh();
  }
  async function markAll() { await api('/v1/notifications/read-all', { method: 'POST' }); load(); refresh(); }

  async function load() {
    const [a, n] = await Promise.all([api('/v1/approvals'), api('/v1/notifications')]);
    clear(tabs);
    for (const [k, label, count] of [['approvals', 'Approvals', a.approvals.length], ['notifications', 'Notifications', n.unread]]) {
      tabs.append(h('button', { class: `tab${tab === k ? ' active' : ''}`, onclick: () => { tab = k; load(); } }, label, count ? ` (${count})` : ''));
    }
    clear(body);
    if (tab === 'approvals') {
      if (!a.approvals.length) body.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '✅'), 'Nothing waiting on you.'));
      for (const x of a.approvals) {
        body.append(h('div', { class: 'card stack' },
          h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, x.summary), h('span', { class: `chip ${x.risk === 'critical' ? 'bad' : 'warn'}` }, x.risk), h('span', { class: 'chip' }, x.category), h('span', { class: 'faint' }, timeAgo(x.created_at))),
          h('pre', { class: 'mono bubble' }, JSON.stringify(x.payload, null, 2).slice(0, 900)),
          h('div', { class: 'row' }, h('button', { class: 'btn good', onclick: () => decide(x, true) }, 'Approve'), h('button', { class: 'btn bad', onclick: () => decide(x, false) }, 'Deny'),
            h('span', { class: 'faint small' }, 'Approving runs exactly what is shown above.'))));
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
  const onEvent = (e) => { if (e.type === 'notification.created' || e.type.startsWith('approval.')) load(); };
  app.listeners.add(onEvent); load();
  return { el, destroy() { app.listeners.delete(onEvent); } };
}
