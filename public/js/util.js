// DOM helpers + a small, SAFE markdown renderer (builds DOM nodes; never innerHTML).
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function fmtLocal(iso, tz) {
  try { return new Date(iso).toLocaleString(undefined, { timeZone: tz || undefined, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

export function toast(msg, ms = 3200) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---- markdown-lite -> DOM -------------------------------------------------
const SAFE_URL = /^https?:\/\//i;
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>)\]]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) frag.append(h('code', {}, t.slice(1, -1)));
    else if (m[2]) frag.append(h('strong', {}, t.slice(2, -2)));
    else if (m[3]) frag.append(h('em', {}, t.slice(1, -1)));
    else if (m[4]) { const mm = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(t); frag.append(h('a', { href: mm[2], target: '_blank', rel: 'noopener noreferrer' }, mm[1])); }
    else if (m[5]) { const url = t.replace(/[.,;:!?]+$/, ''); frag.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url)); if (url.length < t.length) frag.append(t.slice(url.length)); }
    last = m.index + t.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

export function md(src) {
  const root = document.createElement('div');
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; root.append(h('pre', {}, h('code', {}, buf.join('\n')))); continue;
    }
    const hd = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hd) { root.append(h(`h${hd[1].length}`, {}, inline(hd[2]))); i++; continue; }
    if (/^>\s?/.test(line)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, '')); root.append(h('blockquote', {}, inline(buf.join(' ')))); continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const ul = h(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) ul.append(h('li', {}, inline(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))));
      root.append(ul); continue;
    }
    // GFM tables, with or without the outer pipes ("a | b" + "---|---").
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const table = h('table'); const head = cells(line); i += 2;
      table.append(h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c))))));
      const tb = h('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) tb.append(h('tr', {}, cells(lines[i++]).map((c) => h('td', {}, inline(c)))));
      table.append(tb); root.append(h('div', { class: 'table-wrap' }, table)); continue;
    }
    // Column-aligned plain text (command output like df/ls/ps): keep the alignment in a monospace block.
    const aligned = (l) => /\S {2,}\S/.test(l ?? '') && !/^\s*([-*•]|\d+[.)])\s+/.test(l);
    if (aligned(line) && aligned(lines[i + 1])) {
      const buf = [];
      while (i < lines.length && lines[i].trim() && (aligned(lines[i]) || buf.length && /^\S+(\s+\S+){0,2}$/.test(lines[i]) && aligned(lines[i + 1]))) buf.push(lines[i++]);
      root.append(h('pre', {}, h('code', {}, buf.join('\n')))); continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>\s?|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])) buf.push(lines[i++]);
    const p = h('p');
    buf.forEach((l, idx) => { if (idx) p.append(h('br')); p.append(inline(l)); });
    root.append(p);
  }
  return root;
}

export function icon(name) {
  return ({ chat: '💬', inbox: '🔔', tasks: '⚙️', research: '🔎', memory: '🧠', reminders: '⏰', settings: '🎛️' })[name] ?? '•';
}
