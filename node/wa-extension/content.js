// Friday for WhatsApp Web: runs inside his own WhatsApp tab (no screenshots, no mouse/keyboard, works in a background tab).
// It only answers commands from the laptop node (relayed by background.js): read the open chat, open a chat by name,
// send text into the open chat. WhatsApp's DOM changes now and then, so every lookup has fallbacks.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__fridayWa === VERSION) return; // injected twice (manifest + background re-inject): keep one
  window.__fridayWa = VERSION;
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const firstWord = (s) => norm(s).split(' ')[0] ?? '';
  const main = () => document.querySelector('#main');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait for the page to reach a state by watching DOM changes, not by chained timers: Chrome throttles timers in a
  // background tab (down to once a minute after 5 min hidden), but mutation callbacks still run right away.
  const waitFor = (test, timeoutMs = 4000) => new Promise((resolve) => {
    const now = test(); if (now) return resolve(now);
    const obs = new MutationObserver(() => { const v = test(); if (v) { obs.disconnect(); clearTimeout(t); resolve(v); } });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    const t = setTimeout(() => { obs.disconnect(); resolve(test()); }, timeoutMs); // one timer, never a chain
  });

  function chatName() {
    const h = main()?.querySelector('header');
    if (!h) return null;
    const t = h.querySelector('span[title]')?.getAttribute('title') || h.querySelector('span[dir="auto"]')?.textContent;
    return t ? t.trim() : null;
  }

  // Message rows: [role=row] in the conversation (fallbacks: elements with data-id, .message-in/.message-out). Who sent it
  // is decided by LAYOUT (our bubbles sit on the right half of the conversation), with class/id hints as tie-breakers,
  // so a renamed class cannot flip sides. Text: the .copyable-text block with data-pre-plain-text, quotes skipped.
  function rows() {
    const m = main(); if (!m) return [];
    let r = [...m.querySelectorAll('[role="row"]')];
    if (!r.length) r = [...m.querySelectorAll('[data-id]')];
    if (!r.length) r = [...m.querySelectorAll('.message-in, .message-out')];
    return r;
  }
  function side(row, mid) {
    const id = row.getAttribute('data-id') ?? row.querySelector('[data-id]')?.getAttribute('data-id') ?? '';
    if (/^true_/.test(id)) return 'me';
    if (/^false_/.test(id)) return 'them';
    if (row.querySelector('.message-out') || row.matches('.message-out')) return 'me';
    if (row.querySelector('.message-in') || row.matches('.message-in')) return 'them';
    if (row.querySelector('[data-icon^="msg-check"], [data-icon^="msg-dblcheck"], [data-icon="msg-time"]')) return 'me'; // ticks: only ours
    const b = (row.querySelector('.copyable-text') ?? row).getBoundingClientRect();
    return b.width && (b.left + b.right) / 2 > mid ? 'me' : 'them';
  }
  function textOf(row) {
    const block = [...row.querySelectorAll('.copyable-text[data-pre-plain-text]')].pop() ?? [...row.querySelectorAll('.copyable-text')].pop();
    let text = '';
    if (block) {
      const spans = [...block.querySelectorAll('span.selectable-text, span[dir="ltr"], span[dir="auto"]')].filter((x) => !x.closest('[aria-label*="uoted" i], [data-testid*="quoted" i], [role="button"]'));
      text = (spans.length ? spans.reduce((a, b) => (b.innerText.length > a.innerText.length ? b : a)) : block).innerText ?? '';
    }
    if (!text.trim()) text = row.querySelector('img[src^="blob:"]') ? '[photo]' : row.querySelector('[data-icon*="audio" i], [data-icon*="ptt" i]') ? '[voice note]' : '';
    return { text: text.trim(), pre: block?.getAttribute('data-pre-plain-text') ?? '' };
  }
  function messages(limit = 20) {
    const m = main(); if (!m) return [];
    const pane = m.getBoundingClientRect(); const mid = (pane.left + pane.right) / 2;
    const out = [];
    for (const row of rows().slice(-limit * 2)) {
      const { text, pre } = textOf(row);
      if (!text) continue; // date separators, "unread messages", system notes
      const id = row.getAttribute('data-id') ?? row.querySelector('[data-id]')?.getAttribute('data-id') ?? `h_${hash(pre + text)}`;
      out.push({ id, from: side(row, mid), text: text.slice(0, 2000) });
    }
    return out.slice(-limit);
  }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  // What the page looks like, for debugging selectors without guessing (no message text).
  function probe() {
    const m = main();
    const count = (sel) => (m ? m.querySelectorAll(sel).length : 0);
    const r = rows();
    return { main: Boolean(m), rows: r.length, roleRow: count('[role="row"]'), dataId: count('[data-id]'), msgIn: count('.message-in'), msgOut: count('.message-out'),
      copyable: count('.copyable-text'), prePlain: count('[data-pre-plain-text]'), selectable: count('span.selectable-text'),
      sampleIds: [...(m?.querySelectorAll('[data-id]') ?? [])].slice(-3).map((e) => (e.getAttribute('data-id') ?? '').slice(0, 12)),
      lastRowClasses: r.at(-1)?.className?.toString?.().slice(0, 120) ?? null, footerBox: Boolean(m?.querySelector('footer [contenteditable="true"]')) };
  }

  // Open a chat from the chat list by its title (fuzzy: first word must match; the exact title wins).
  async function openChat(name) {
    if (chatName() && firstWord(chatName()) === firstWord(name)) return { chat: chatName() };
    const titles = [...document.querySelectorAll('#pane-side span[title]')];
    const exact = titles.find((s) => norm(s.getAttribute('title')) === norm(name));
    const hit = exact ?? titles.find((s) => norm(s.getAttribute('title')).startsWith(norm(name))) ?? titles.find((s) => firstWord(s.getAttribute('title')) === firstWord(name));
    if (!hit) return { error: `no chat named "${name}" in the WhatsApp chat list (scroll it into the list or search it once)` };
    const row = hit.closest('[role="listitem"], [role="row"], [tabindex="-1"]') ?? hit;
    for (const type of ['mousedown', 'mouseup', 'click']) row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    const opened = await waitFor(() => chatName() && firstWord(chatName()) === firstWord(name) && chatName(), 4000);
    return opened ? { chat: opened } : { error: `clicked "${hit.getAttribute('title')}" but the chat did not open` };
  }

  async function send({ chat, text }) {
    if (chat) { const o = await openChat(chat); if (o.error) return o; }
    const box = main()?.querySelector('footer [contenteditable="true"]');
    if (!box) return { error: 'message box not found' };
    box.focus();
    document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
    for (const [i, line] of String(text).split('\n').entries()) { // shift+Enter-style newlines keep one message
      if (i) document.execCommand('insertLineBreak', false, null);
      document.execCommand('insertText', false, line);
    }
    const btn = await waitFor(() => main()?.querySelector('footer button[aria-label="Send" i], footer [data-icon="send"], footer [data-icon="wds-ic-send-filled"]'), 1500);
    if (btn) (btn.closest('button') ?? btn).click();
    else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    // confirm: the box is empty again and our newest message is the text we sent
    const ok = await waitFor(() => { const last = messages(3).filter((m) => m.from === 'me').pop(); return !box.innerText.trim() && last && norm(last.text).startsWith(norm(text).slice(0, 20)) && last; }, 5000);
    return ok ? { sent: true, id: ok.id, chat: chatName() } : { error: 'typed but could not confirm it was sent', chat: chatName() };
  }

  const handlers = {
    status: async () => ({ ok: true, version: VERSION, chat: chatName(), loggedIn: Boolean(document.querySelector('#pane-side')) }),
    probe: async () => probe(),
    read: async ({ chat, limit }) => {
      if (chat && !(chatName() && firstWord(chatName()) === firstWord(chat))) { const o = await openChat(chat); if (o.error) return o; }
      return { chat: chatName(), messages: messages(Math.min(Number(limit) || 20, 40)) };
    },
    open: async ({ chat }) => openChat(chat),
    send,
  };

  // A port to background.js keeps the extension's service worker alive while this tab is open.
  let port = null; let dead = false;
  const connect = () => {
    if (dead) return;
    try { port = chrome.runtime.connect({ name: 'friday-wa' }); } catch { dead = true; return; } // extension reloaded: a newer copy takes over
    port.onMessage.addListener(async (msg) => {
      let result;
      try { result = await (handlers[msg.op] ?? (async () => ({ error: `unknown op ${msg.op}` })))(msg.args ?? {}); }
      catch (e) { result = { error: String(e?.message ?? e).slice(0, 200) }; }
      try { port.postMessage({ id: msg.id, result }); } catch { /* port reconnects below */ }
    });
    port.onDisconnect.addListener(() => setTimeout(connect, 1000));
  };
  connect();
  setInterval(() => { try { port?.postMessage({ ping: Date.now() }); } catch { /* reconnecting */ } }, 20_000);
})();
