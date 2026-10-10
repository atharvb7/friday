import { h, md, clear, timeAgo } from '../util.js';

export function render({ api }) {
  const list = h('div', { class: 'list' });
  const host = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search what we’ve learned…', 'aria-label': 'Search research' });
  search.addEventListener('input', () => { clearTimeout(search.t); search.t = setTimeout(load, 300); });
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h2', {}, 'Research')), h('div', { class: 'stack' }, search, list), host);

  async function load() {
    const q = search.value.trim();
    const { projects } = await api(q ? `/v1/research/projects/search?q=${encodeURIComponent(q)}` : '/v1/research/projects');
    clear(list);
    if (!projects.length) list.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🔎'), q ? 'Nothing matches.' : 'No saved research yet. Say “research X” in chat.'));
    for (const p of projects) {
      list.append(h('div', { class: 'card click', onclick: () => open(p.id) },
        h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, p.topic), p.confidence ? h('span', { class: `chip ${p.confidence === 'high' ? 'good' : p.confidence === 'low' ? 'warn' : ''}` }, p.confidence) : null, h('span', { class: 'faint' }, timeAgo(p.created_at))),
        h('div', { class: 'muted' }, (p.summary ?? '').slice(0, 240))));
    }
  }

  async function open(id) {
    const [{ project: p }, rep] = await Promise.all([api(`/v1/research/projects/${id}`), api(`/v1/research/projects/${id}/report`).catch(() => null)]);
    clear(host);
    const close = () => clear(host);
    host.append(h('div', { class: 'drawer stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, p.topic), h('button', { class: 'btn quiet icon', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'row wrap' }, h('span', { class: 'chip' }, `${p.sourceCount} sources`), h('span', { class: 'chip' }, `${p.claims.length} claims`), h('span', { class: 'faint' }, `saved ${new Date(p.created_at).toLocaleDateString()}`)),
      h('div', { class: 'card bubble' }, md(p.summary)),
      h('h3', {}, 'Claims & evidence'),
      h('div', { class: 'list' }, p.claims.map((c) => h('div', { class: 'card' }, h('div', {}, c.contradicted ? h('span', { class: 'chip bad' }, 'contradicted ') : null, ' ', c.claim),
        c.source ? h('div', { class: 'meta muted' }, h('a', { href: c.source.url, target: '_blank', rel: 'noopener noreferrer' }, c.source.title || c.source.url), c.source.published ? ` · ${c.source.published}` : '') : null,
        c.note ? h('div', { class: 'faint' }, c.note) : null))),
      rep ? h('div', {}, h('h3', {}, 'Full report'), h('div', { class: 'card bubble' }, md(rep.markdown))) : null));
  }
  load();
  return { el };
}
