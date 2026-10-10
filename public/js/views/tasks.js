import { h, md, clear, timeAgo } from '../util.js';

const KIND = { agent: '🤖', research: '🔎', coding: '💻', computer: '🖥️' };
const STATUS = { completed: 'good', failed: 'bad', blocked: 'warn', running: 'accent', queued: '', cancelled: '', waiting: 'warn', planning: 'accent' };

export function render({ app, api, toast }) {
  const list = h('div', { class: 'list' });
  const drawerHost = h('div');
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h2', {}, 'Tasks'), h('button', { class: 'btn small', onclick: newTask }, '+ New')), list, drawerHost);

  async function load() {
    const { tasks } = await api('/v1/tasks');
    clear(list);
    if (!tasks.length) list.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '⚙️'), 'No tasks yet. Ask Friday to research, code or browse — it shows up here.'));
    for (const t of tasks) {
      list.append(h('div', { class: 'card click item', onclick: () => detail(t.id) }, h('div', { class: 'big' }, KIND[t.kind] ?? '🤖'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title), h('div', { class: 'meta' }, `${t.kind} · ${timeAgo(t.updated_at)}`)),
        h('span', { class: `chip ${STATUS[t.status] ?? ''}` }, t.status)));
    }
  }

  async function newTask() {
    const dlg = h('dialog');
    const title = h('input', { type: 'text', placeholder: 'Title', maxlength: 200 });
    const ins = h('textarea', { rows: 5, placeholder: 'What should the background agent do? (be specific)' });
    dlg.append(h('form', { method: 'dialog', class: 'stack' }, h('h2', {}, 'New background task'), title, ins,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', value: 'ok' }, 'Queue it'), h('button', { class: 'btn quiet', value: 'cancel' }, 'Cancel'))));
    document.body.append(dlg); dlg.showModal();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue === 'ok' && title.value.trim() && ins.value.trim()) {
        try { await api('/v1/tasks', { method: 'POST', body: { title: title.value, instruction: ins.value } }); toast('Queued.'); load(); } catch (e) { toast(e.message); }
      }
      dlg.remove();
    });
  }

  async function detail(id) {
    const [{ task }, { events }] = await Promise.all([api(`/v1/tasks/${id}`), api(`/v1/tasks/${id}/events`)]);
    clear(drawerHost);
    const close = () => clear(drawerHost);
    const steps = events.filter((e) => e.kind.startsWith('trace.') || e.kind.startsWith('task.'));
    const tl = h('div', { class: 'timeline' }, steps.slice(-80).map((e) => {
      const k = e.kind.replace('trace.', '');
      const cls = k === 'tool_call' ? 'tool' : k === 'tool_result' ? (e.detail.status === 'completed' || e.detail.status === 'ok' ? 'ok' : 'err') : k.includes('failed') ? 'err' : '';
      const txt = k === 'tool_call' ? `${e.detail.tool} ${(e.detail.input || '').slice(0, 110)}` : k === 'tool_result' ? `${e.detail.status}: ${(e.detail.result || '').replace(/\s+/g, ' ').slice(0, 110)}` : k === 'step' ? `step ${e.detail.step} · ${e.detail.tokens} tokens` : k === 'text' ? e.detail.text : k.startsWith('task.') || k === 'created' ? k : JSON.stringify(e.detail).slice(0, 110);
      return h('div', { class: `ev ${cls}` }, h('span', { class: 'faint' }, new Date(e.created_at).toLocaleTimeString() + '  '), k.startsWith('tool') ? h('span', { class: 'mono' }, txt) : txt);
    }));
    const canCancel = ['queued', 'running', 'waiting', 'planning'].includes(task.status);
    const canRetry = ['failed', 'blocked'].includes(task.status);
    drawerHost.append(h('div', { class: 'drawer stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, task.title), h('button', { class: 'btn quiet icon', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'row wrap' }, h('span', { class: `chip ${STATUS[task.status] ?? ''}` }, task.status), h('span', { class: 'chip' }, task.kind), h('span', { class: 'faint' }, `created ${timeAgo(task.created_at)}`)),
      h('div', { class: 'row' }, canCancel ? h('button', { class: 'btn bad small', onclick: async () => { await api(`/v1/tasks/${id}/cancel`, { method: 'POST' }); close(); load(); } }, 'Cancel') : null,
        canRetry ? h('button', { class: 'btn small', onclick: async () => { await api(`/v1/tasks/${id}/retry`, { method: 'POST' }); toast('Re-queued.'); close(); load(); } }, 'Retry (re-runs the whole task)') : null),
      task.error ? h('div', { class: 'banner' }, task.error) : null,
      task.result ? h('div', {}, h('h3', {}, 'Result'), h('div', { class: 'card bubble' }, md(task.result))) : null,
      h('div', {}, h('h3', {}, 'What exactly happened'), tl),
      h('details', {}, h('summary', { class: 'muted' }, 'Instruction'), h('pre', { class: 'mono bubble' }, task.instruction))));
  }

  const onEvent = (e) => { if (e.type.startsWith('task.')) load(); };
  app.listeners.add(onEvent); load();
  return { el, destroy() { app.listeners.delete(onEvent); } };
}
