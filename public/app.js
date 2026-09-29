const $ = (selector, root = document) => root.querySelector(selector);
const sessionTokenKey = 'friday.sessionToken';
const state = { token: sessionStorage.getItem(sessionTokenKey) || '', timer: null, loading: false, taskIds: new Set() };
const statuses = ['queued', 'planning', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'];
const labels = { localModel: 'Local model', dsh: 'DeepSeek Harness', computerUse: 'Computer use', remoteAccess: 'Remote access' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GiB`;
}
function setConnection(kind, text) {
  const el = $('#connection');
  el.className = `connection ${kind}`;
  $('#connection-label').textContent = text;
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
  clearInterval(state.timer);
  showAccess();
  $('#access-error').textContent = message;
  $('#access-error').hidden = false;
  setConnection('offline', 'Authentication failed');
}
function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 3400);
}
function renderStatus(status) {
  const resources = status.resources || {};
  const mode = resources.mode || 'unknown';
  const val = $('#memory-mode');
  val.textContent = mode.toUpperCase();
  val.className = `status-value ${esc(mode)}`;
  const avail = Number(resources.availableBytes);
  const total = Number(resources.totalBytes);
  $('#available-memory').textContent = `${fmtBytes(avail)} available`;
  $('#total-memory').textContent = `${fmtBytes(total)} total`;
  const fraction = total > 0 && Number.isFinite(avail) ? Math.max(0, Math.min(1, (total - avail) / total)) : 0;
  const bar = $('#memory-bar');
  bar.style.width = `${fraction * 100}%`;
  bar.className = fraction > .9 ? 'critical' : fraction > .78 ? 'warn' : '';
  const notes = {
    normal: 'Memory headroom is healthy. New worker admission is permitted.',
    constrained: 'Memory is tightening. Keep background work light.',
    paused: 'New workers are paused to protect the laptop.',
    emergency: 'Emergency pressure: Friday should stop optional work.',
  };
  $('#memory-note').textContent = notes[mode] || 'Memory status is not available.';
  const flags = status.capabilities || {};
  $('#capabilities').innerHTML = Object.entries(labels).map(([key, label]) => {
    const enabled = flags[key] === true;
    return `<div class="capability ${enabled ? 'available' : ''}"><i aria-hidden="true"></i><span>${esc(label)}: ${enabled ? 'Available' : 'Not connected'}</span></div>`;
  }).join('');
  $('#build-phase').textContent = String(status.phase || 'foundation').toUpperCase();
}
function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function renderTasks(tasks) {
  const list = $('#task-list');
  $('#task-count').textContent = String(tasks.length);
  $('#empty-state').hidden = tasks.length > 0;
  list.setAttribute('aria-busy', 'false');
  state.taskIds = new Set(tasks.map(task => task.id));
  list.innerHTML = tasks.map(task => {
    const canCancel = ['queued', 'planning', 'running', 'waiting', 'blocked'].includes(task.status);
    return `<article class="task-item" data-task-id="${esc(task.id)}">
      <div class="task-main"><div><div class="task-title">${esc(task.title)}</div><div class="task-meta">${esc(relativeDate(task.created_at))}</div></div><span class="badge ${esc(task.status)}">${esc(task.status)}</span></div>
      <p class="task-detail">${esc(task.instruction)}</p>
      <div class="task-actions"><button class="button quiet details-button" type="button" aria-expanded="false">Activity</button>${canCancel ? '<button class="button quiet cancel-button" type="button">Cancel task</button>' : ''}</div>
      <ol class="events" hidden aria-label="Task activity"></ol>
    </article>`;
  }).join('');
}
async function refresh() {
  if (!state.token || state.loading) return;
  state.loading = true;
  try {
    const [status, taskData] = await Promise.all([request('/v1/status'), request('/v1/tasks')]);
    renderStatus(status);
    renderTasks(taskData.tasks || []);
    showApp();
    setConnection('online', 'Connected to laptop');
  } catch (error) {
    if (error.status === 401) return rejectToken();
    setConnection('offline', 'Laptop unavailable');
    if ($('#app-panel').hidden) {
      $('#access-error').textContent = 'Friday could not be reached. Make sure it is running on this laptop, then try again.';
      $('#access-error').hidden = false;
    }
  } finally {
    state.loading = false;
  }
}
async function connect(token) {
  state.token = token.trim();
  $('#access-error').hidden = true;
  try {
    await request('/v1/status');
    sessionStorage.setItem(sessionTokenKey, state.token);
    showApp();
    await refresh();
    clearInterval(state.timer);
    state.timer = setInterval(refresh, 12000);
  } catch (error) {
    if (error.status === 401) return rejectToken();
    state.token = '';
    $('#access-error').textContent = 'Friday could not be reached. Check that the service is running on this laptop.';
    $('#access-error').hidden = false;
    setConnection('offline', 'Laptop unavailable');
  }
}

$('#token-form').addEventListener('submit', async event => {
  event.preventDefault();
  await connect($('#token-input').value);
});
$('#disconnect').addEventListener('click', () => {
  state.token = '';
  sessionStorage.removeItem(sessionTokenKey);
  clearInterval(state.timer);
  $('#access-error').hidden = true;
  setConnection('', 'Not connected');
  showAccess();
});
$('#refresh').addEventListener('click', refresh);
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#create-task');
  const errorNode = $('#task-error');
  const successNode = $('#task-success');
  errorNode.hidden = successNode.hidden = true;
  button.disabled = true;
  try {
    const data = await request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ title: $('#task-title').value, instruction: $('#task-instruction').value }),
    });
    form.reset();
    successNode.textContent = `Saved as ${data.task?.status || 'queued'}. Execution is not enabled yet.`;
    successNode.hidden = false;
    await refresh();
  } catch (error) {
    if (error.status === 401) return rejectToken();
    errorNode.textContent = error.message === 'invalid_task' ? 'Add a title and instructions within the allowed length.' : 'The task could not be saved. Check the connection and retry.';
    errorNode.hidden = false;
  } finally { button.disabled = false; }
});
$('#task-list').addEventListener('click', async event => {
  const item = event.target.closest('.task-item');
  if (!item) return;
  const id = item.dataset.taskId;
  if (event.target.closest('.cancel-button')) {
    const button = event.target.closest('.cancel-button');
    button.disabled = true;
    try {
      await request(`/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      notify('Task cancelled.');
      await refresh();
    } catch (error) {
      if (error.status === 401) return rejectToken();
      notify(error.status === 409 ? 'This task can no longer be cancelled.' : 'Could not cancel the task.');
      button.disabled = false;
      await refresh();
    }
  }
  if (event.target.closest('.details-button')) {
    const button = event.target.closest('.details-button');
    const eventsList = $('.events', item);
    const opening = eventsList.hidden;
    eventsList.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (!opening) return;
    button.disabled = true;
    try {
      const data = await request(`/v1/tasks/${encodeURIComponent(id)}/events`);
      eventsList.innerHTML = (data.events || []).map(entry => `<li><strong>${esc(entry.kind)}</strong> · ${esc(relativeDate(entry.created_at))}</li>`).join('') || '<li>No activity recorded.</li>';
    } catch (error) {
      if (error.status === 401) return rejectToken();
      eventsList.innerHTML = '<li>Activity could not be loaded.</li>';
    } finally { button.disabled = false; }
  }
});

if (state.token) connect(state.token);
else { showAccess(); setConnection('', 'Not connected'); }
