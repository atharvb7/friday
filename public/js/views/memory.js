import { h, clear, timeAgo } from '../util.js';

const KINDS = ['long_term', 'preference', 'project', 'episodic', 'semantic', 'research'];

export function render({ app, api, toast }) {
  const list = h('div', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: 'Search memories (keyword + meaning)…', 'aria-label': 'Search memories' });
  search.addEventListener('input', () => { clearTimeout(search.t); search.t = setTimeout(load, 300); });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h2', {}, 'Memory'), h('button', { class: 'btn small', onclick: () => edit(null) }, '+ Remember')), h('div', { class: 'stack' }, search, list));

  async function load() {
    const q = search.value.trim();
    const { memories } = await api(q ? `/v1/memory/search?q=${encodeURIComponent(q)}` : '/v1/memory');
    clear(list);
    if (!memories.length) list.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🧠'), q ? 'No match.' : 'Nothing remembered yet. Tell me “remember …” in chat.'));
    for (const m of memories) {
      list.append(h('div', { class: 'card item' },
        h('div', { class: 'grow' }, h('div', {}, m.content), h('div', { class: 'meta' }, `${m.kind} · ${m.source} · ${timeAgo(m.created_at)}${m.project ? ` · ${m.project}` : ''}${m.sensitivity === 'sensitive' ? ' · sensitive' : ''}${m.embedded ? ' · indexed' : ''}`)),
        h('button', { class: 'btn quiet icon', title: m.pinned ? 'Unpin' : 'Pin', onclick: async () => { await api(`/v1/memory/${m.id}/pin`, { method: 'POST', body: { pinned: !m.pinned } }); load(); } }, m.pinned ? '★' : '☆'),
        h('button', { class: 'btn quiet icon', title: 'Edit', onclick: () => edit(m) }, '✎'),
        h('button', { class: 'btn quiet icon', title: 'Forget', onclick: async () => { if (confirm('Forget this?')) { await api(`/v1/memory/${m.id}`, { method: 'DELETE' }); load(); } } }, '🗑')));
    }
  }

  function edit(m) {
    const dlg = h('dialog');
    const content = h('textarea', { rows: 4, maxlength: 10000 }); content.value = m?.content ?? '';
    const kind = h('select', {}, KINDS.map((k) => h('option', { value: k, selected: (m?.kind ?? 'long_term') === k }, k)));
    const project = h('input', { type: 'text', placeholder: 'Project (optional)', value: m?.project ?? '' });
    const sens = h('input', { type: 'checkbox', checked: m?.sensitivity === 'sensitive' });
    dlg.append(h('form', { method: 'dialog', class: 'stack' }, h('h2', {}, m ? 'Edit memory' : 'Remember something'), content,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', {}, 'Type'), kind), h('div', { class: 'grow' }, h('label', {}, 'Project'), project)),
      h('label', { class: 'row' }, sens, ' Sensitive (never injected into chats automatically)'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', value: 'ok' }, 'Save'), h('button', { class: 'btn quiet', value: 'cancel' }, 'Cancel'))));
    document.body.append(dlg); dlg.showModal();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue === 'ok' && content.value.trim()) {
        const body = { content: content.value, kind: kind.value, project: project.value.trim() || null, sensitivity: sens.checked ? 'sensitive' : 'normal' };
        try {
          if (m) await api(`/v1/memory/${m.id}`, { method: 'PATCH', body }); else await api('/v1/memory', { method: 'POST', body: { ...body, source: 'ui' } });
          load();
        } catch (e) { toast(e.message); }
      }
      dlg.remove();
    });
  }
  load();
  return { el };
}
