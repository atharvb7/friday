import { h, md, clear, timeAgo } from '../util.js';
import { streamChat, auth } from '../api.js';
import { chunkSpeak } from '/voice.js';
import { emojiPicker, insertAtCursor } from '../emoji.js';
import { startRecording, speakServer } from '../voice-io.js';
import { svgIcon } from '../icons.js';

const FILE_ICON = { docx: '📝', doc: '📝', odt: '📝', rtf: '📝', xlsx: '📊', xls: '📊', csv: '📊', tsv: '📊', pptx: '📽️', ppt: '📽️', pdf: '📕', md: '🗒️', txt: '🗒️', html: '🌐', json: '🧾', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', zip: '🗜️' };
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
async function download(f) {
  const r = await fetch(`/v1/files/${f.id}`, { headers: { Authorization: `Bearer ${auth.token}` }, cache: 'no-store' });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function fileChip(f, onErr) {
  const ext = f.name.split('.').pop().toLowerCase();
  return h('button', { class: 'file-chip', type: 'button', title: `Download ${f.name}`, onclick: () => download(f).catch((e) => onErr?.(e.message)) },
    h('span', { class: 'fi' }, FILE_ICON[ext] ?? '📄'), h('span', { class: 'fn' }, f.name), h('span', { class: 'fs' }, `${fmtSize(f.size)} · ⬇`));
}

const SUGGESTIONS = [['☀️', 'Brief me on today'], ['⏰', 'Remind me in 1 hour to stretch'], ['🔎', 'Research the latest in open-source AI agents'], ['🧠', 'What did I ask you to remember?']];
const GREETS = { morning: ['Morning! ☕', 'Rise and shine ✨', 'Good morning, sleepyhead'], afternoon: ['Hey you 👋', 'Afternoon! What’s up?', 'Back already? 😏'], evening: ['Evening ✨', 'Hey, how was your day?', 'Wind-down time?'], night: ['Still up? 🌙', 'Night owl mode 🦉', 'Can’t sleep either?'] };
const greeting = () => { const hr = new Date().getHours(); const k = hr < 5 ? 'night' : hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : hr < 22 ? 'evening' : 'night'; const l = GREETS[k]; return l[Math.floor(Math.random() * l.length)]; };

// Text chat has no stage directions: hide *actions* (keeps **bold**) even while streaming.
const ACTION_WORD = /^(gasps?|giggles?|sighs?|swoons?|smirks?|winks?|grins?|laughs?|blushes?|pouts?|hugs?|waves?|nods?|shrugs?|clutch\w*|bounc\w*|pok\w*|rolls?|squeals?|cackles?|snorts?|yawns?|whispers?|screams?|faints?|facepalms?|dramatic\w*|flops?|spins?|twirls?|slumps?|stares?|glares?|leans?|sips?|munches|crunches|steals?|waggles?|taps?|tilts?|peeks?|hides?|jumps?|dances?|cries|sobs?|beams?|melts?|nuzzles?|cuddles?|snuggles?|kisses|smooches|sticks?|puffs?|crosses|raises?|covers?|buries|collapses?|fans?|pretends?|ahem)\b/i;
const noActions = (t) => t.replace(/(^|[\s(])\*(?!\*)([^*\n]{2,90}?)\*(?=[\s).,!?…:;]|$)/g, (m, pre, inner) => (ACTION_WORD.test(inner.trim()) || inner.trim().split(/\s+/).length >= 4 ? pre : m));

export function render({ app, api, toast }) {
  const voiceCaps = { stt: false, tts: false }; let speaking = null, recording = null;
  api('/v1/voice/status').then((v) => { voiceCaps.stt = v.stt === 'ready'; voiceCaps.tts = v.tts === 'ready'; }).catch(() => {});
  let convoId = null, busy = false, abort = null, speak = false, listening = false, rec = null, lastInputWasVoice = false;
  const convos = h('aside', { class: 'convos', id: 'convos' });
  const msgs = h('div', { class: 'msgs', id: 'msgs', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 1, placeholder: 'Message Friday…', 'aria-label': 'Message Friday', maxlength: 20000 });
  // One round action button: mic when the box is empty, send when there is something to send.
  const send = h('button', { class: 'act send', type: 'submit', 'aria-label': 'Send', title: 'Send' }, svgIcon('send', 20));
  const mic = h('button', { class: 'act mic', type: 'button', title: 'Talk to Friday', 'aria-label': 'Voice input', onclick: toggleMic }, svgIcon('mic', 20));
  const spk = h('button', { class: 'btn quiet icon', type: 'button', title: 'Read replies aloud', 'aria-label': 'Toggle spoken replies', 'aria-pressed': 'false', onclick: () => { speak = !speak; spk.replaceChildren(svgIcon(speak ? 'volume' : 'mute', 20)); spk.setAttribute('aria-pressed', String(speak)); spk.classList.toggle('on', speak); if (!speak) speechSynthesis?.cancel(); toast(speak ? 'I’ll read my replies out loud 🔊' : 'Quiet mode 🤫'); } }, svgIcon('mute', 20));
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '.docx,.xlsx,.pptx,.pdf,.md,.txt,.csv,.tsv,.html,.json,.xml,.png,.jpg,.jpeg,.gif,.webp,.doc,.xls,.ppt,.odt,.rtf,.zip' });
  const pending = []; // files uploaded and waiting to be sent with the next message
  const tray = h('div', { class: 'attach-tray', hidden: true });
  const attachBtn = h('button', { class: 'btn quiet icon', type: 'button', title: 'Attach files', 'aria-label': 'Attach files', onclick: () => fileInput.click() }, svgIcon('paperclip', 20));
  const paintTray = () => { clear(tray); tray.hidden = !pending.length; form?.classList.toggle('has-text', Boolean(input.value.trim() || pending.length)); for (const f of pending) tray.append(h('span', { class: 'chip' }, `${FILE_ICON[f.name.split('.').pop().toLowerCase()] ?? '📄'} ${f.name}`, h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { pending.splice(pending.indexOf(f), 1); paintTray(); } }, '×'))); };
  async function uploadFiles(list) {
    for (const file of list) {
      if (file.size > 25 * 1024 * 1024) { toast(`${file.name} is over 25 MB`); continue; }
      try {
        const r = await fetch(`/v1/files?name=${encodeURIComponent(file.name)}${convoId ? `&conversation=${convoId}` : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/octet-stream' }, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { toast(`${file.name}: ${j.error || r.status}`); continue; }
        pending.push(j.file); paintTray();
      } catch (e) { toast(`Upload failed: ${e.message}`); }
    }
  }
  fileInput.addEventListener('change', () => { uploadFiles([...fileInput.files]); fileInput.value = ''; });
  const histBtn = h('button', { class: 'btn quiet icon hist-btn', type: 'button', 'aria-label': 'Conversations', title: 'Conversations', onclick: () => convos.classList.toggle('open') }, svgIcon('history', 20));
  const newBtn = h('button', { class: 'btn quiet icon', type: 'button', 'aria-label': 'New chat', title: 'New chat', onclick: () => open(null) }, svgIcon('newchat', 20));
  app.setHeadSlot?.(histBtn);
  app.setHeadRight?.(spk, newBtn);

  const emoji = emojiPicker({ onPick: (e) => insertAtCursor(input, e) });
  const form = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } },
    tray, h('div', { class: 'box' }, h('div', { class: 'field' }, emoji.el, input, attachBtn, fileInput), mic, send));
  const syncAct = () => form.classList.toggle('has-text', Boolean(input.value.trim() || pending.length));
  input.addEventListener('input', syncAct);
  // drag & drop / paste files onto the composer
  form.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); form.classList.add('drop'); } });
  form.addEventListener('dragleave', () => form.classList.remove('drop'));
  form.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); form.classList.remove('drop'); uploadFiles([...e.dataTransfer.files]); } });
  input.addEventListener('paste', (e) => { const fl = [...(e.clipboardData?.files ?? [])]; if (fl.length) { e.preventDefault(); uploadFiles(fl); } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.setProperty('height', 'auto'); input.style.setProperty('height', `${Math.min(input.scrollHeight, 160)}px`); });

  // Stay pinned to the newest message unless the user scrolled up to read; then offer a jump button.
  let pinned = true;
  const jump = h('button', { class: 'btn small jump', type: 'button', hidden: true, onclick: () => { pinned = true; scroll(true); } }, '↓ New messages');
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
  msgs.addEventListener('scroll', () => { pinned = nearBottom(); jump.hidden = pinned; });
  const scroll = (force = false) => { if (force || pinned) { msgs.scrollTop = msgs.scrollHeight; jump.hidden = true; } else jump.hidden = false; };
  new MutationObserver(() => scroll()).observe(msgs, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(() => scroll()).observe(msgs);

  const el = h('div', { class: 'chat' }, convos, h('div', { class: 'chat-pane' }, msgs, jump, form));

  function bubble(role, content, extra = {}) {
    const body = h('div', { class: 'bubble' });
    if (extra.tools?.length) body.append(h('div', { class: 'tools' }, extra.tools.map((t) => h('span', { class: `chip ${t.ok === false ? 'bad' : 'accent'}` }, `🔧 ${t.name}`))));
    if (content) body.append(role === 'assistant' ? md(content) : h('div', {}, content));
    if (extra.files?.length) body.append(h('div', { class: 'files' }, extra.files.map((f) => fileChip(f, toast))));
    return h('div', { class: `msg ${role}` }, h('div', { class: 'av' }, role === 'user' ? 'You' : 'F'), body);
  }
  function hello() {
    clear(msgs);
    msgs.append(h('div', { class: 'hello' }, h('div', { class: 'orb idle big', onclick: (e) => { const o = e.currentTarget; o.classList.remove('boop'); void o.offsetWidth; o.classList.add('boop'); } }), h('h2', {}, greeting()),
      h('p', { class: 'muted' }, 'Ask me anything — I remember, research, run errands on your laptop and keep an eye on things for you.'),
      h('div', { class: 'suggest' }, SUGGESTIONS.map(([e, s]) => h('button', { class: 'suggest-card', type: 'button', onclick: () => { input.value = s; syncAct(); submit(); } }, h('span', { class: 'se' }, e), h('span', {}, s))))));
  }

  async function loadConvos() {
    try {
      const { conversations } = await api('/v1/chats');
      clear(convos);
      convos.append(h('button', { class: 'btn full', type: 'button', onclick: () => open(null) }, '+ New chat'));
      for (const c of conversations) {
        convos.append(h('div', { class: `convo-row${c.id === convoId ? ' active' : ''}` },
          h('button', { class: 'convo', type: 'button', title: c.title, onclick: () => open(c.id) }, c.title),
          h('button', { class: 'convo-del', type: 'button', title: 'Delete chat', 'aria-label': `Delete chat ${c.title}`, onclick: (e) => { e.stopPropagation(); removeConvo(c); } }, '🗑')));
      }
    } catch { /* offline */ }
  }

  async function removeConvo(c) {
    if (!confirm(`Delete “${c.title}”? This removes the whole conversation and can’t be undone. (Memories I saved from it stay in the Memory tab.)`)) return;
    try {
      await api(`/v1/chat/${c.id}`, { method: 'DELETE' });
      if (c.id === convoId) { convoId = null; hello(); }
      toast('Chat deleted.'); loadConvos();
    } catch (e) { toast(`Couldn’t delete: ${e.message}`); }
  }

  async function open(id) {
    convoId = id; convos.classList.remove('open');
    if (!id) { hello(); loadConvos(); return; }
    try {
      const { messages } = await api(`/v1/chat/${id}`);
      clear(msgs); for (const m of messages) msgs.append(bubble(m.role, m.content, { files: m.attachments }));
      pinned = true; scroll(true); loadConvos();
    } catch { toast('Could not open that conversation'); }
  }

  async function submit() {
    const text = input.value.trim();
    const files = pending.splice(0); paintTray(); form.classList.remove('has-text');
    if ((!text && !files.length) || busy) { pending.push(...files); paintTray(); return; }
    busy = true; app.chatBusy = true; app.paint(); send.disabled = true;
    input.value = ''; input.style.setProperty('height', 'auto'); speechSynthesis?.cancel();
    if (!convoId) clear(msgs);
    pinned = true; msgs.append(bubble('user', text, { files }));
    const tools = []; let acc = '';
    const viaVoice = lastInputWasVoice; lastInputWasVoice = false;
    const toolsEl = h('div', { class: 'tools' });
    const live = h('div', { class: 'bubble' }, toolsEl, h('div', { class: 'typing' }, h('i'), h('i'), h('i')));
    const wrap = h('div', { class: 'msg assistant' }, h('div', { class: 'av' }, 'F'), live);
    msgs.append(wrap); scroll();
    abort = new AbortController();
    const paintReply = () => { live.lastChild?.remove(); live.append(md(noActions(acc))); scroll(); };
    try {
      await streamChat({ message: text, conversationId: convoId, channel: viaVoice ? 'voice' : 'chat', attachments: files.map((f) => f.id) }, {
        meta: (d) => { convoId = d.conversationId; },
        delta: (d) => { acc += d.text; paintReply(); },
        thinking: () => {},
        tool: (t) => { tools.push(t); toolsEl.append(h('span', { class: `chip ${t.ok === false ? 'bad' : 'accent'}` }, `🔧 ${t.name}`)); },
        done: (d) => { acc = d.reply; paintReply(); if (d.files?.length) live.append(h('div', { class: 'files' }, d.files.map((f) => fileChip(f, toast)))); if (speak && acc) say(acc); },
        error: () => { acc ||= '(That didn’t go through. Try again?)'; paintReply(); },
      }, abort.signal);
    } catch (e) { acc ||= `Couldn’t reach my brain: ${e.message}`; paintReply(); }
    busy = false; app.chatBusy = false; app.paint(); send.disabled = false; loadConvos(); input.focus();
  }

  async function fetchWav(text) {
    try {
      const r = await fetch('/v1/voice/speak', { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      return r.ok ? await r.blob() : null;
    } catch { return null; }
  }
  function say(text) {
    if (voiceCaps.tts) { speaking?.cancel(); speaking = speakServer(text, fetchWav); return; }
    if (!('speechSynthesis' in window)) return;
    for (const c of chunkSpeak(text.replace(/[`*#>|]/g, ''), 200)) speechSynthesis.speak(new SpeechSynthesisUtterance(c));
  }

  async function serverMic() {
    if (recording) { recording.stop(); return; }
    speaking?.cancel(); speechSynthesis?.cancel();
    try {
      recording = startRecording({ onLevel: (l) => mic.style.setProperty('--lvl', String(Math.min(1, l * 12))) });
      mic.classList.add('primary', 'rec'); input.placeholder = 'Listening… (stops when you pause)';
      const wav = await recording.done; recording = null;
      mic.classList.remove('primary', 'rec'); mic.style.removeProperty('--lvl'); input.placeholder = 'Message Friday…';
      if (!wav) { toast('Didn’t catch anything — try again.'); return; }
      input.placeholder = 'Transcribing…';
      const res = await fetch('/v1/voice/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'audio/wav' }, body: wav });
      input.placeholder = 'Message Friday…';
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(`Voice: ${j.error || res.status}`); return; }
      if (j.text) { input.value = j.text; lastInputWasVoice = true; submit(); } else toast('I couldn’t make out any words.');
    } catch (e) {
      recording = null; mic.classList.remove('primary', 'rec'); input.placeholder = 'Message Friday…';
      toast(e.name === 'NotAllowedError' ? 'Microphone permission is blocked for this site.' : `Mic error: ${e.message}`);
    }
  }

  function toggleMic() {
    if (voiceCaps.stt) return serverMic(); // Whisper on the server (accurate, handles Hinglish/accents)
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Voice input needs a browser with speech recognition, or install Friday’s voice engine.'); return; }
    if (listening) { rec?.stop(); return; }
    speechSynthesis?.cancel();
    rec = new SR(); rec.interimResults = true; rec.lang = navigator.language || 'en-US';
    rec.onstart = () => { listening = true; mic.classList.add('primary'); };
    rec.onresult = (e) => { input.value = [...e.results].map((r) => r[0].transcript).join(' '); };
    rec.onend = () => { listening = false; mic.classList.remove('primary'); if (input.value.trim()) { lastInputWasVoice = true; submit(); } };
    rec.onerror = (e) => { toast(`Mic: ${e.error}`); };
    rec.start();
  }

  // Server-side additions (task results, reminders, approvals) show up live.
  const onEvent = (e) => {
    if (e.type === 'chat.message' && e.data.conversationId === convoId && !busy) open(convoId);
    if (e.type === 'chat.message' || e.type === 'chat.deleted') loadConvos();
    if (e.type === 'chat.deleted' && e.data.conversationId === convoId && !busy) { convoId = null; hello(); }
  };
  app.listeners.add(onEvent);

  hello(); loadConvos();
  return { el, destroy() { speaking?.cancel(); recording?.stop(); emoji.close(); app.listeners.delete(onEvent); abort?.abort(); rec?.stop(); speechSynthesis?.cancel(); } };
}
