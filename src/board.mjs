// "Your turn": one list, built on the server, of everything waiting on the owner (approvals, a paused task's
// question, suggestions to decide or check, a background job that keeps failing, an action whose result is
// unknown, a to-do that is overdue). Each card is one clear thing with a class: decide | answer | check | do.
// Every client draws the same list. Push policy: 'all' (every notification reaches the phone, the old way) or
// 'needs_you' (completions such as "Done: ..." stay in the inbox; reminders, alerts and anything asking for the
// owner still push).
export const PUSH_POLICIES = ['all', 'needs_you'];

export function pushPolicy(settings) { const p = settings?.get('push_policy', null); return PUSH_POLICIES.includes(p) ? p : 'all'; }

// Whether a notification goes to the phone under the policy. Only completions are held back.
export function shouldPush(policy, n) {
  if (policy !== 'needs_you') return true;
  return n.level !== 'success';
}

export function buildBoard(ctx, { now = Date.now() } = {}) {
  const cards = [];
  const add = (c) => cards.push({ actions: [], ...c, seq: cards.length });
  const day = 86_400_000;
  try {
    for (const a of ctx.approvals.list('pending')) add({ kind: 'approval', class: 'decide', id: a.id, title: a.summary, detail: `${a.category} · ${a.risk}${a.repeat ? ' · repeat of one that already ran' : ''}`, created_at: a.created_at, actions: ['approve', 'deny'], urgent: a.risk === 'critical' });
  } catch { /* optional */ }
  try {
    for (const q of ctx.questions?.pending() ?? []) add({ kind: 'question', class: 'answer', id: q.id, title: q.question, detail: q.field ? `saved as your ${q.field}` : 'a background task is paused until you answer', created_at: q.created_at, actions: ['answer'] });
  } catch { /* optional */ }
  try {
    for (const r of ctx.recs?.list({ status: 'open', limit: 20 }) ?? []) add({ kind: 'rec', class: 'decide', id: r.id, title: r.title, detail: `Because: ${r.because}${r.cost ? ` · costs ${r.cost}` : ''}`, created_at: r.created_at, actions: ['accept', 'decline'] });
    for (const r of ctx.recs?.dueForReview({ max: 5 }) ?? []) add({ kind: 'rec_review', class: 'check', id: r.id, title: `Did it work? ${r.title}`, detail: `Expected: ${r.expect}`, created_at: r.review_on, actions: ['worked', 'mixed', 'failed'] });
  } catch { /* optional */ }
  try {
    const since = new Date(now - day).toISOString();
    for (const a of ctx.store.db.prepare("SELECT id, summary, decided_at FROM approvals WHERE status='approved' AND result LIKE '%\"interrupted\"%' AND decided_at >= ? ORDER BY decided_at DESC LIMIT 5").all(since)) {
      add({ kind: 'unknown_result', class: 'check', id: a.id, title: `Check whether this happened: ${a.summary}`, detail: 'Friday restarted while doing it after your approval', created_at: a.decided_at });
    }
  } catch { /* optional */ }
  try {
    for (const l of ctx.loops?.list() ?? []) if (['down', 'stuck'].includes(l.status)) add({ kind: 'loop', class: 'check', id: l.name, title: `Background job ${l.status === 'stuck' ? 'is stuck' : 'keeps failing'}: ${l.name}`, detail: l.last_error ?? `since ${l.failing_since ?? l.last_run}`, created_at: l.failing_since ?? l.last_run ?? new Date(now).toISOString() });
  } catch { /* optional */ }
  try {
    // The most recently due few; the rest as one line, so a backlog does not bury the decisions.
    const overdue = (ctx.commitments?.list({ status: 'open', limit: 100 }) ?? []).filter((c) => c.due_at && Date.parse(c.due_at) < now).sort((x, y) => y.due_at.localeCompare(x.due_at));
    for (const c of overdue.slice(0, 5)) add({ kind: 'todo', class: 'do', id: c.id, title: c.title, detail: `was due ${c.due_at.slice(0, 10)}`, created_at: c.due_at, actions: ['done', 'drop'] });
    if (overdue.length > 5) add({ kind: 'todo_more', class: 'do', id: 'overdue', title: `${overdue.length - 5} more overdue to-dos`, detail: 'ask Friday to go through them with you, or mark them done or dropped', created_at: overdue[5].due_at });
  } catch { /* optional */ }
  const rank = { decide: 0, answer: 1, do: 2, check: 3 };
  // To-dos keep the order chosen above (latest due first, then the "more" line); others oldest first.
  cards.sort((a, b) => (b.urgent === true) - (a.urgent === true) || rank[a.class] - rank[b.class] || (a.class === 'do' ? a.seq - b.seq : String(a.created_at).localeCompare(String(b.created_at))));
  return { count: cards.length, cards: cards.map(({ seq, ...c }) => c) };
}
