import { h, md, clear, timeAgo } from '../util.js';
import { streamChat } from '../api.js';
import { chunkSpeak } from '/voice.js';

const SUGGESTIONS = ['What did I ask you to remember?', 'Remind me in 1 hour to stretch', 'Research the latest in open-source AI agents', 'Brief me on today'];

export function render({ app, api, toast }) {
  let convoId = null, busy = false, abort = null, speak = false, listening = false, rec = null;
  const convos = h('aside', { class: 'convos', id: 'convos' });
  const msgs = h('div', { class: 'msgs', id: 'msgs', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 1, placeholder: 'Message Friday…', 'aria-label': 'Message Friday', maxlength: 20000 });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
  const mic = h('button', { class: 'btn icon', type: 'button', title: 'Push to talk', 'aria-label': 'Voice input', onclick: toggleMic }, '🎙');
  const spk = h('button', { class: 'btn icon quiet', type: 'button', title: 'Read replies aloud', 'aria-label': 'Toggle spoken replies', onclick: () => { speak = !speak; spk.textContent = speak ? '🔊' : '🔇'; if (!speak) speechSynthesis?.cancel(); } }, '🔇');
  const histBtn = h('button', { class: 'btn quiet icon', type: 'button', 'aria-label': 'Conversations', onclick: () => convos.classList.toggle('open') }, '☰');

  const form = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div', { class: 'box' }, histBtn, input, spk, mic, send));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.setProperty('height', 'auto'); input.style.setProperty('height', `${Math.min(input.scrollHeight, 160)}px`); });

  const el = h('div', { class: 'chat' }, convos, h('div', { class: 'chat-pane' }, msgs, jump, form));

  function bubble(role, content, extra = {}) {
    const body = h('div', { class: 'bubble' });
    if (extra.tools?.length) body.append(h('div', { class: 'tools' }, extra.tools.map((t) => h('span', { class: `chip ${t.ok === false ? 'bad' : 'accent'}` }, `🔧 ${t.name}`))));
    if (content) body.append(role === 'assistant' ? md(content) : h('div', {}, content));
    return h('div', { class: `msg ${role}` }, h('div', { class: 'av' }, role === 'user' ? 'You' : 'F'), body);
  }
  // Stay pinned to the newest message unless the user scrolled up to read; then offer a jump button.
  let pinned = true;
  const jump = h('button', { class: 'btn small jump', type: 'button', hidden: true, onclick: () => { pinned = true; scroll(true); } }, '↓ New messages');
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
  msgs.addEventListener('scroll', () => { pinned = nearBottom(); jump.hidden = pinned; });
  const scroll = (force = false) => { if (force || pinned) { msgs.scrollTop = msgs.scrollHeight; jump.hidden = true; } else jump.hidden = false; };
  new MutationObserver(() => scroll()).observe(msgs, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(() => scroll()).observe(msgs);

  function hello() {
    clear(msgs);
    msgs.append(h('div', { class: 'hello' }, h('div', { class: 'orb idle' }), h('h2', {}, 'Hey, I’m Friday.'),
      h('p', { class: 'muted' }, 'I remember, research, run background work, and operate your laptop. Ask me anything.'),
      h('div', { class: 'suggest' }, SUGGESTIONS.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => { input.value = s; submit(); } }, s)))));
  }

  async function loadConvos() {
    try {
      const { conversations } = await api('/v1/chats');
      clear(convos);
      convos.append(h('button', { class: 'btn full', type: 'button', onclick: () => open(null) }, '+ New chat'));
      for (const c of conversations) convos.append(h('button', { class: `convo${c.id === convoId ? ' active' : ''}`, type: 'button', title: c.title, onclick: () => open(c.id) }, c.title));
    } catch { /* offline */ }
  }

  async function open(id) {
    convoId = id; convos.classList.remove('open');
    if (!id) { hello(); loadConvos(); return; }
    try {
      const { messages } = await api(`/v1/chat/${id}`);
      clear(msgs); for (const m of messages) msgs.append(bubble(m.role, m.content));
      pinned = true; scroll(true); loadConvos();
    } catch { toast('Could not open that conversation'); }
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; app.chatBusy = true; app.paint(); send.disabled = true;
    input.value = ''; input.style.setProperty('height', 'auto'); speechSynthesis?.cancel();
    if (!convoId) clear(msgs);
    pinned = true; msgs.append(bubble('user', text));
    const tools = []; let acc = '';
    const toolsEl = h('div', { class: 'tools' });
    const live = h('div', { class: 'bubble' }, toolsEl, h('div', { class: 'typing' }, h('i'), h('i'), h('i')));
    const wrap = h('div', { class: 'msg assistant' }, h('div', { class: 'av' }, 'F'), live);
    msgs.append(wrap); scroll();
    abort = new AbortController();
    const paintReply = () => { live.lastChild?.remove(); live.append(md(acc)); scroll(); };
    try {
      await streamChat({ message: text, conversationId: convoId }, {
        meta: (d) => { convoId = d.conversationId; },
        delta: (d) => { acc += d.text; paintReply(); },
        thinking: () => {},
        tool: (t) => { tools.push(t); toolsEl.append(h('span', { class: `chip ${t.ok === false ? 'bad' : 'accent'}` }, `🔧 ${t.name}`)); },
        done: (d) => { acc = d.reply; paintReply(); if (speak && acc) say(acc); },
        error: () => { acc ||= '(That didn’t go through. Try again?)'; paintReply(); },
      }, abort.signal);
    } catch (e) { acc ||= `Couldn’t reach my brain: ${e.message}`; paintReply(); }
    busy = false; app.chatBusy = false; app.paint(); send.disabled = false; loadConvos(); input.focus();
  }

  function say(text) {
    if (!('speechSynthesis' in window)) return;
    for (const c of chunkSpeak(text.replace(/[`*#>|]/g, ''), 200)) speechSynthesis.speak(new SpeechSynthesisUtterance(c));
  }

  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Voice input needs a browser with speech recognition (Chrome/Edge/Safari).'); return; }
    if (listening) { rec?.stop(); return; }
    speechSynthesis?.cancel();
    rec = new SR(); rec.interimResults = true; rec.lang = navigator.language || 'en-US';
    rec.onstart = () => { listening = true; mic.classList.add('primary'); };
    rec.onresult = (e) => { input.value = [...e.results].map((r) => r[0].transcript).join(' '); };
    rec.onend = () => { listening = false; mic.classList.remove('primary'); if (input.value.trim()) submit(); };
    rec.onerror = (e) => { toast(`Mic: ${e.error}`); };
    rec.start();
  }

  // Server-side additions (task results, reminders, approvals) show up live.
  const onEvent = (e) => {
    if (e.type === 'chat.message' && e.data.conversationId === convoId && !busy) open(convoId);
    if (e.type === 'chat.message') loadConvos();
  };
  app.listeners.add(onEvent);

  hello(); loadConvos();
  return { el, destroy() { app.listeners.delete(onEvent); abort?.abort(); rec?.stop(); speechSynthesis?.cancel(); } };
}
