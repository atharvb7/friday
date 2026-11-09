import { h, md, clear, timeAgo } from '../util.js';

export function render({ app, api, toast, refresh }) {
  let tab = 'turn';
  const body = h('div', { class: 'list' });
  const tabs = h('div', { class: 'tabs' });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h2', {}, 'Inbox'), h('button', { class: 'btn small', onclick: markAll }, 'Mark all read')), tabs, body);

  async function totpFor() {
    if (app.needsCode?.() && app.totpActive) { const c = prompt('Authenticator code (6 digits)'); return c ? c.trim() : null; }
    return undefined;
  }
  async function decide(a, approve, note = '') {
    const totp = await totpFor(); if (totp === null) return;
    try { await api(`/v1/approvals/${a.id}/decide`, { method: 'POST', body: { approve, ...(note.trim() ? { note: note.trim() } : {}) }, totp }); toast(approve ? 'Approved — doing it now.' : 'Denied.'); }
    catch (e) { toast(e.message === 'totp_required' ? 'A valid authenticator code is required.' : `Failed: ${e.message}`); }
    load(); refresh();
  }
  const rawPayload = (x) => h('pre', { class: 'mono bubble payload-raw' }, JSON.stringify(x.payload, null, 2).slice(0, 40000));
  // Outreach batches read like the emails they are: who, subject, the formatted body.
  const emailPreview = (emails) => h('div', { class: 'stack payload-emails' }, ...emails.map((e, i) => h('div', { class: 'bubble stack' },
    h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, `${i + 1}. ${e.company ?? e.to ?? e.lead_id ?? ''}`), e.to ? h('span', { class: 'faint small' }, e.to) : null, h('span', { class: 'chip' }, e.follow_up ? 'follow-up' : 'first email')),
    e.subject ? h('div', {}, h('span', { class: 'faint small' }, 'Subject: '), h('strong', {}, e.subject)) : null,
    h('div', {}, md(String(e.body ?? '').slice(0, 6000))))));
  // Open-source contributions read like the pull request / issue they will become, with the test proof and the exact diff.
  const gh = (u) => (/^https:\/\/github\.com\//.test(String(u ?? '')) ? u : null);
  const ACTION = { open_pull_request: 'New pull request', update_pull_request: 'Push to open pull request', open_issue: 'New issue' };
  const contribPreview = (c) => h('div', { class: 'stack payload-contrib' },
    h('div', { class: 'row wrap' }, h('span', { class: 'chip accent' }, ACTION[c.action] ?? c.action), h('strong', { class: 'grow' }, c.repo),
      c.additions !== undefined ? h('span', { class: 'faint small' }, `+${c.additions} −${c.deletions} in ${c.files?.length ?? 0} file(s)`) : null),
    c.issue ? h('div', { class: 'small' }, h('span', { class: 'faint' }, 'Issue: '), h('a', { href: gh(c.issue.url), target: '_blank', rel: 'noopener noreferrer' }, `#${c.issue.number} ${c.issue.title}`)) : null,
    c.pr ? h('div', { class: 'small' }, h('span', { class: 'faint' }, 'Pull request: '), h('a', { href: gh(c.pr), target: '_blank', rel: 'noopener noreferrer' }, c.pr)) : null,
    c.title ? h('div', {}, h('span', { class: 'faint small' }, 'Title: '), h('strong', {}, c.title)) : null,
    c.commit_message ? h('div', {}, h('span', { class: 'faint small' }, 'Commit: '), h('strong', {}, c.commit_message)) : null,
    c.body ? h('div', { class: 'bubble' }, md(String(c.body).slice(0, 8000))) : null,
    c.reply ? h('div', { class: 'bubble' }, h('div', { class: 'faint small' }, 'Comment on the PR:'), md(String(c.reply).slice(0, 3000))) : null,
    c.proof?.length ? h('div', { class: 'stack small' }, h('span', { class: 'faint' }, 'Independent test run (clean clone):'),
      ...c.proof.map((p) => h('div', { class: 'row' }, h('span', { class: `chip ${(p.step === 'test_before' ? p.exit !== 0 : p.exit === 0) ? 'good' : 'bad'}` }, p.step === 'test_before' ? (p.exit !== 0 ? 'fails before ✓' : 'passes before ✗') : (p.exit === 0 ? 'pass' : `exit ${p.exit}`)), h('code', { class: 'mono' }, p.cmd)))) : null,
    c.review?.score ? h('div', { class: 'faint small' }, `Maintainer-style review: ${c.review.score}/10${c.review.notes?.length ? ` · ${c.review.notes.join(' · ')}` : ''}`) : null,
    c.diff ? h('details', { open: true }, h('summary', { class: 'faint small' }, 'Exact diff that will be committed'), h('pre', { class: 'mono bubble payload-raw' }, String(c.diff).slice(0, 60000))) : null);
  async function markAll() { await api('/v1/notifications/read-all', { method: 'POST' }); load(); refresh(); }

  async function load() {
    const [a, n, qs, board] = await Promise.all([api('/v1/approvals'), api('/v1/notifications'), api('/v1/questions'), api('/v1/board').catch(() => ({ count: 0, cards: [] }))]);
    clear(tabs);
    for (const [k, label, count] of [['turn', 'Your turn', board.count], ['approvals', 'Approvals', a.approvals.length], ['questions', 'Questions', qs.questions.length], ['notifications', 'Notifications', n.unread]]) {
      tabs.append(h('button', { class: `tab${tab === k ? ' active' : ''}`, onclick: () => { tab = k; load(); } }, label, count ? ` (${count})` : ''));
    }
    clear(body);
    if (tab === 'turn') {
      if (!board.cards.length) body.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🌤️'), 'Nothing needs you right now.'));
      const post = async (path, b, done) => { try { await api(path, { method: 'POST', body: b }); toast(done); load(); refresh(); } catch (e) { toast(e.message); } };
      const label = { decide: 'Decide', answer: 'Answer', do: 'To do', check: 'Check' };
      for (const c of board.cards) {
        const btns = [];
        if (c.kind === 'approval') { const ap = a.approvals.find((x) => x.id === c.id); if (ap) btns.push(h('button', { class: 'btn small', onclick: () => { tab = 'approvals'; load(); } }, 'Review & decide')); }
        if (c.kind === 'rec') btns.push(h('button', { class: 'btn small good', onclick: () => post(`/v1/recs/${c.id}/decide`, { status: 'accepted' }, 'Accepted.') }, 'Accept'), h('button', { class: 'btn small', onclick: () => post(`/v1/recs/${c.id}/decide`, { status: 'declined' }, 'Declined.') }, 'Decline'));
        if (c.kind === 'rec_review') for (const o of c.actions) btns.push(h('button', { class: 'btn small', onclick: () => { const note = prompt(`What happened? (${o})`); if (note) post(`/v1/recs/${c.id}/score`, { outcome: o, note }, 'Scored.'); } }, o));
        if (c.kind === 'question') btns.push(h('button', { class: 'btn small', onclick: () => { tab = 'questions'; load(); } }, 'Answer'));
        if (c.kind === 'todo') btns.push(h('button', { class: 'btn small good', onclick: () => post(`/v1/todos/${c.id}`, { status: 'done' }, 'Done ✓') }, 'Done'), h('button', { class: 'btn small', onclick: () => post(`/v1/todos/${c.id}`, { status: 'dropped' }, 'Dropped') }, 'Drop'));
        body.append(h('div', { class: 'card stack' },
          h('div', { class: 'row wrap' }, h('span', { class: `chip ${c.class === 'decide' ? 'warn' : c.class === 'check' ? '' : 'accent'}` }, label[c.class] ?? c.class), h('strong', { class: 'grow' }, c.title), c.urgent ? h('span', { class: 'chip bad' }, 'critical') : null),
          c.detail ? h('div', { class: 'muted' }, c.detail) : null, btns.length ? h('div', { class: 'row wrap' }, ...btns) : null));
      }
    } else if (tab === 'approvals') {
      if (!a.approvals.length) body.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '✅'), 'Nothing waiting on you.'));
      for (const x of a.approvals) {
        const note = h('input', { type: 'text', maxlength: '500', placeholder: 'Note for Friday (optional, e.g. why you deny)', 'aria-label': 'Note for Friday' });
        body.append(h('div', { class: 'card stack' },
          h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, x.summary), h('span', { class: `chip ${x.risk === 'critical' ? 'bad' : 'warn'}` }, x.risk), h('span', { class: 'chip' }, x.category), h('span', { class: 'faint' }, timeAgo(x.created_at))),
          x.repeat ? h('div', { class: 'chip warn' }, `Repeat: same as the one you approved ${timeAgo(x.repeat.approved_at)}, which already ran`) : null,
          ...(Array.isArray(x.payload?.emails) ? [emailPreview(x.payload.emails), h('details', {}, h('summary', { class: 'faint small' }, 'Exact payload'), rawPayload(x))]
            : x.payload?.contribution ? [contribPreview(x.payload.contribution)] : [rawPayload(x)]),
          note,
          h('div', { class: 'row' }, h('button', { class: 'btn good', onclick: () => decide(x, true, note.value) }, 'Approve'), h('button', { class: 'btn bad', onclick: () => decide(x, false, note.value) }, 'Deny'),
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
