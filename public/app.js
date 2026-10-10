const $ = (selector, root = document) => root.querySelector(selector);
const sessionTokenKey = 'friday.sessionToken';
const state = { token: sessionStorage.getItem(sessionTokenKey) || '', currentChatId: null, sending: false };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${state.token}`, ...(options.headers || {}) },
    cache: 'no-store',
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function showAccess() {
  $('#access-panel').hidden = false;
  $('#app-panel').hidden = true;
  $('#token-input').value = '';
  $('#token-input').focus();
}
function showApp() {
  $('#access-panel').hidden = true;
  $('#app-panel').hidden = false;
}
function rejectToken(message = 'That token was not accepted. Check it and try again.') {
  state.token = '';
  sessionStorage.removeItem(sessionTokenKey);
  showAccess();
  $('#access-error').textContent = message;
  $('#access-error').hidden = false;
  $('#connection-label').textContent = 'Not connected';
}
function renderBrainLine(brain) {
  const el = $('#brain-line');
  if (!el) return;
  el.textContent = (brain === 'friday-brain' || brain === 'nemotron-direct')
    ? '● Full brain online — ask anything.'
    : brain === 'dsh'
      ? '● Agent runtime online — ask anything.'
      : '● Local mode — chat, memory, files and tasks work here; full reasoning connects with a key.';
}
function renderChatList(convos) {
  const list = $('#chat-list');
  list.innerHTML = (convos || []).map(c =>
    `<button class="chat-convo${c.id === state.currentChatId ? ' active' : ''}" type="button" data-chat="${esc(c.id)}" title="${esc(c.title || 'Chat')}">${esc(c.title || 'Chat')}</button>`
  ).join('') || '<p class="muted">No chats yet — say hello below.</p>';
}
function renderMessages(messages) {
  const box = $('#chat-messages');
  if (!(messages || []).length) {
    box.innerHTML = '<div class="empty-chat"><h2>Hey, I’m Friday.</h2><p class="muted">Ask me anything — I remember, find files, track tasks, and get work queued.</p></div>';
    return;
  }
  box.innerHTML = (messages || []).map(m =>
    `<div class="bubble ${m.role === 'user' ? 'user' : 'friday'}">${esc(m.content)}</div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}
async function refreshBrain() {
  try {
    const status = await request('/v1/status');
    renderBrainLine(status.brain);
  } catch {}
}
async function loadChats() {
  try {
    const data = await request('/v1/chats');
    renderChatList(data.conversations || []);
    if (!state.currentChatId) {
      if ((data.conversations || [])[0]) await openChat(data.conversations[0].id);
      else renderMessages([]);
    }
  } catch (error) {
    if (error.status === 401) return rejectToken();
  }
}
async function openChat(id) {
  state.currentChatId = id;
  try {
    const data = await request(`/v1/chat/${encodeURIComponent(id)}`);
    renderMessages(data.messages || []);
    const chats = await request('/v1/chats');
    renderChatList(chats.conversations || []);
  } catch (error) {
    if (error.status === 401) return rejectToken();
  }
}
async function connect(token) {
  state.token = token.trim();
  $('#access-error').hidden = true;
  try {
    const status = await request('/v1/status');
    sessionStorage.setItem(sessionTokenKey, state.token);
    $('#connection-label').textContent = 'Connected to laptop';
    renderBrainLine(status.brain);
    showApp();
    await loadChats();
  } catch (error) {
    if (error.status === 401) return rejectToken();
    state.token = '';
    $('#access-error').textContent = 'Friday could not be reached. Check that the service is running on this laptop.';
    $('#access-error').hidden = false;
  }
}

$('#token-form').addEventListener('submit', async event => {
  event.preventDefault();
  await connect($('#token-input').value);
});
$('#disconnect').addEventListener('click', () => {
  state.token = '';
  state.currentChatId = null;
  sessionStorage.removeItem(sessionTokenKey);
  $('#connection-label').textContent = 'Not connected';
  showAccess();
});
$('#new-chat').addEventListener('click', () => {
  state.currentChatId = null;
  renderMessages([]);
  loadChats();
  $('#chat-input').focus();
});
$('#chat-list').addEventListener('click', event => {
  const btn = event.target.closest('[data-chat]');
  if (btn) openChat(btn.dataset.chat);
});
$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || state.sending) return;
  const err = $('#chat-error');
  err.hidden = true;
  const box = $('#chat-messages');
  if (box.querySelector('.empty-chat')) box.innerHTML = '';
  const userBubble = document.createElement('div');
  userBubble.className = 'bubble user';
  userBubble.textContent = text;
  box.appendChild(userBubble);
  const typing = document.createElement('div');
  typing.className = 'bubble friday typing';
  typing.textContent = 'Friday is thinking…';
  box.appendChild(typing);
  box.scrollTop = box.scrollHeight;
  input.value = '';
  state.sending = true;
  $('#chat-send').disabled = true;
  try {
    const data = await request('/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.currentChatId, message: text }),
    });
    state.currentChatId = data.conversation?.id || state.currentChatId;
    const full = await request(`/v1/chat/${encodeURIComponent(state.currentChatId)}`);
    renderMessages(full.messages || []);
    const chats = await request('/v1/chats');
    renderChatList(chats.conversations || []);
    refreshBrain();
  } catch (error) {
    if (error.status === 401) return rejectToken();
    typing.textContent = 'Could not reach Friday. Check the connection and retry.';
    err.textContent = 'Message not delivered — connection issue.';
    err.hidden = false;
  } finally {
    state.sending = false;
    $('#chat-send').disabled = false;
  }
});

if (state.token) connect(state.token);
else { showAccess(); $('#connection-label').textContent = 'Not connected'; }
