// Friday for WhatsApp Web: runs inside his own WhatsApp tab (no screenshots, no mouse/keyboard, works in a background tab).
// It only answers commands from the laptop node (relayed by background.js): read the open chat, open a chat by name,
// send text into the open chat. WhatsApp's DOM changes now and then, so every lookup has fallbacks.
(() => {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const firstWord = (s) => norm(s).split(' ')[0] ?? '';
  const main = () => document.querySelector('#main');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function chatName() {
    const h = main()?.querySelector('header');
    if (!h) return null;
    const t = h.querySelector('span[title]')?.getAttribute('title') || h.querySelector('span[dir="auto"]')?.textContent;
    return t ? t.trim() : null;
  }

  // Every message row carries data-id "true_..." (sent by us) or "false_..." (received). The text sits in the
  // .copyable-text block; a quoted reply has its own nested quote, which is skipped.
  function messages(limit = 20) {
    const m = main(); if (!m) return [];
    const rows = [...m.querySelectorAll('[data-id]')].filter((el) => /^(true|false)_/.test(el.getAttribute('data-id') ?? ''));
    const out = [];
    for (const el of rows.slice(-limit)) {
      const id = el.getAttribute('data-id');
      const block = [...el.querySelectorAll('.copyable-text[data-pre-plain-text]')].pop() ?? el.querySelector('.copyable-text');
      let text = '';
      if (block) {
        const spans = [...block.querySelectorAll('span.selectable-text')].filter((s) => !s.closest('[aria-label*="uoted" i], [data-testid*="quoted" i]'));
        text = (spans.pop() ?? block).innerText ?? '';
      }
      if (!text) text = el.querySelector('img[src^="blob:"]') ? '[photo]' : el.querySelector('[data-icon*="audio" i], [data-icon*="ptt" i]') ? '[voice note]' : el.querySelector('img') ? '[sticker]' : '';
      if (!text.trim()) continue;
      out.push({ id, from: id.startsWith('true_') ? 'me' : 'them', text: text.trim().slice(0, 2000) });
    }
    return out;
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
    for (let i = 0; i < 20; i++) { await sleep(150); if (chatName() && firstWord(chatName()) === firstWord(name)) return { chat: chatName() }; }
    return { error: `clicked "${hit.getAttribute('title')}" but the chat did not open` };
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
    await sleep(120);
    const btn = main()?.querySelector('footer button[aria-label="Send" i], footer [data-icon="send"], footer [data-icon="wds-ic-send-filled"]');
    if (btn) (btn.closest('button') ?? btn).click();
    else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    for (let i = 0; i < 20; i++) { // confirm: the box is empty again and our newest message is the text we sent
      await sleep(150);
      const last = messages(3).filter((m) => m.from === 'me').pop();
      if (!box.innerText.trim() && last && norm(last.text).startsWith(norm(text).slice(0, 20))) return { sent: true, id: last.id, chat: chatName() };
    }
    return { error: 'typed but could not confirm it was sent', chat: chatName() };
  }

  const handlers = {
    status: async () => ({ ok: true, chat: chatName(), loggedIn: Boolean(document.querySelector('#pane-side')) }),
    read: async ({ chat, limit }) => {
      if (chat && !(chatName() && firstWord(chatName()) === firstWord(chat))) { const o = await openChat(chat); if (o.error) return o; }
      return { chat: chatName(), messages: messages(Math.min(Number(limit) || 20, 40)) };
    },
    open: async ({ chat }) => openChat(chat),
    send,
  };

  // A port to background.js keeps the extension's service worker alive while this tab is open.
  let port = null;
  const connect = () => {
    port = chrome.runtime.connect({ name: 'friday-wa' });
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
