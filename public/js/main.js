import { h, $, clear, icon, toast } from './util.js';
import { api, auth, startEvents, ApiError } from './api.js';
import * as chat from './views/chat.js';
import * as inbox from './views/inbox.js';
import * as tasks from './views/tasks.js';
import * as research from './views/research.js';
import * as memory from './views/memory.js';
import * as reminders from './views/reminders.js';
import * as settings from './views/settings.js';

const VIEWS = { chat, inbox, tasks, research, memory, reminders, settings };
const LABELS = { chat: 'Chat', inbox: 'Inbox', tasks: 'Tasks', research: 'Research', memory: 'Memory', reminders: 'Reminders', settings: 'Settings' };

export const app = {
  me: null, status: null, unread: 0, pendingApprovals: 0, link: 'offline', current: null, view: null,
  chatBusy: false, listeners: new Set(),
};
const root = document.getElementById('root');

// ---- theme -----------------------------------------------------------------
function applyTheme() { try { const t = localStorage.getItem('friday.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ } }
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('friday.theme', next); } catch { /* ignore */ }
}
applyTheme();

// ---- login -----------------------------------------------------------------
function showLogin(message = '') {
  clear(root);
  const input = h('input', { type: 'password', id: 'tok', autocomplete: 'off', placeholder: 'Access token', 'aria-label': 'Access token', required: true });
  const remember = h('input', { type: 'checkbox', id: 'rem' });
  const err = h('p', { class: 'muted', role: 'alert' }, message);
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    auth.set(input.value.trim(), remember.checked);
    try { await boot(); } catch (ex) { auth.clear(); err.textContent = ex.status === 401 ? 'That token was not accepted.' : `Could not reach Friday (${ex.message}).`; }
  } },
    h('div', {}, h('label', { for: 'tok' }, 'Access token'), input),
    h('label', { class: 'row', for: 'rem' }, remember, ' Keep me signed in on this device'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Connect'), err);
  root.append(h('div', { class: 'login' }, h('div', { class: 'card' }, h('div', { class: 'orb idle' }), h('h1', {}, 'Friday'), h('p', { class: 'muted' }, 'Your personal AI. Enter the access token from your Friday server (or the device token from Settings → Devices).'), form)));
  input.focus();
}

// ---- shell -----------------------------------------------------------------
let orb, stateText, linkDot, linkText, stopBtn, navEls = {}, mainEl;

function buildShell() {
  clear(root);
  orb = h('div', { class: 'orb idle', id: 'orb' });
  stateText = h('span', { class: 'muted' }, 'idle');
  linkDot = h('span', { class: 'dot' }); linkText = h('span', {}, 'connecting');
  stopBtn = h('button', { class: 'btn bad small', title: 'Stop all agents and revoke elevated autonomy', onclick: emergency }, '■ Stop');
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'Sections' }, h('div', { class: 'brand' }, h('div', { class: 'orb idle' }), 'Friday'));
  for (const name of Object.keys(VIEWS)) {
    const badge = h('span', { class: 'badge', hidden: true });
    const b = h('button', { class: 'nav', 'data-view': name, onclick: () => go(name), 'aria-label': LABELS[name] }, h('span', { class: 'ico' }, icon(name)), h('span', {}, LABELS[name]), badge);
    navEls[name] = { b, badge };
    nav.append(b);
  }
  mainEl = h('main', { class: 'main', id: 'main' });
  const top = h('header', { class: 'topbar' }, orb, h('strong', {}, 'Friday'), stateText, h('span', { class: 'grow' }),
    h('div', { class: 'status-line hide-mobile' }, linkDot, linkText), stopBtn,
    h('button', { class: 'btn quiet icon', title: 'Toggle theme', 'aria-label': 'Toggle theme', onclick: toggleTheme }, '◐'));
  root.append(h('div', { class: 'shell' }, top, nav, mainEl));
}

function go(name) {
  if (!VIEWS[name]) name = 'chat';
  app.view?.destroy?.();
  app.current = name;
  try { history.replaceState(null, '', `#${name}`); } catch { /* ignore */ }
  for (const [n, e] of Object.entries(navEls)) e.b.classList.toggle('active', n === name);
  clear(mainEl);
  mainEl.classList.toggle('fixed', name === 'chat');
  app.view = VIEWS[name].render({ app, api, toast, go, refresh });
  mainEl.append(app.view.el);
}

async function refresh() {
  try {
    const [s, n, a] = await Promise.all([api('/v1/status'), api('/v1/notifications?unread=1'), api('/v1/approvals')]);
    app.status = s; app.unread = n.unread; app.pendingApprovals = a.approvals.length;
  } catch (e) { if (e instanceof ApiError && e.status === 401) return signOut('Signed out.'); }
  paint();
}

function paint() {
  const s = app.status;
  const state = app.link !== 'online' ? 'offline' : s?.emergencyStopped ? 'stopped' : app.chatBusy ? 'thinking' : (s?.worker?.running || s?.worker?.runningCount) ? 'working' : 'idle';
  orb.className = `orb ${state}`;
  stateText.textContent = `${{ offline: 'offline', stopped: 'stopped', thinking: 'thinking…', working: `working${s?.worker?.runningCount > 1 ? ` (${s.worker.runningCount})` : ''}`, idle: 'idle' }[state]}${s?.mood?.emoji ? ` · ${s.mood.emoji} ${s.mood.mood}` : ''}`;
  linkDot.className = `dot ${app.link === 'online' ? 'on' : 'bad'}`; linkText.textContent = app.link === 'online' ? `${s?.brain === 'friday-brain' ? 'brain online' : 'local mode'}${s?.nodes?.length ? ' · laptop' : ''}` : 'reconnecting…';
  const badge = app.unread + app.pendingApprovals;
  navEls.inbox.badge.hidden = !badge; navEls.inbox.badge.textContent = badge;
  document.title = badge ? `(${badge}) Friday` : 'Friday';
  stopBtn.hidden = !s || (app.me && !app.me.scopes.includes('read'));
}

async function emergency() {
  if (app.status?.emergencyStopped) {
    if (!confirm('Resume Friday? Agents and the worker will start again.')) return;
    const totp = app.me?.kind === 'device' && app.totpActive ? prompt('6-digit authenticator code') : undefined;
    try { await api('/v1/emergency-clear', { method: 'POST', totp }); toast('Resumed.'); } catch (e) { toast(`Could not resume: ${e.message}`); }
  } else {
    if (!confirm('Stop everything? All running agents are cancelled and elevated autonomy is revoked.')) return;
    try { await api('/v1/emergency-stop', { method: 'POST' }); toast('Stopped.'); } catch (e) { toast(`Stop failed: ${e.message}`); }
  }
  refresh();
}

function onEvent(evt) {
  const t = evt.type;
  if (t.startsWith('task.') || t.startsWith('system.') || t === 'notification.created' || t.startsWith('approval.') || t === 'device.connected' || t === 'device.disconnected' || t === 'worker.claimed') {
    clearTimeout(onEvent.timer); onEvent.timer = setTimeout(refresh, 250);
  }
  if (t === 'notification.created' && evt.data?.title) toast(`${evt.data.title}`);
  for (const fn of app.listeners) { try { fn(evt); } catch { /* view errors must not break the feed */ } }
}

function signOut(msg) { app.stopEvents?.(); auth.clear(); app.view?.destroy?.(); showLogin(msg); }
app.signOut = () => signOut('Signed out.');
app.paint = paint;

async function boot() {
  const who = await api('/v1/auth/whoami');
  app.me = who.principal; app.totpActive = who.totpActive;
  buildShell();
  app.stopEvents?.();
  app.stopEvents = startEvents(onEvent, (st) => { app.link = st; if (st === 'unauthorized') signOut('Session expired.'); else { paint(); if (st === 'online') refresh(); } });
  await refresh();
  go((location.hash || '#chat').slice(1));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

if (auth.token) boot().catch((e) => { if (e?.status === 401) auth.clear(); showLogin(e?.status === 401 ? '' : `Something went wrong loading Friday (${e?.message ?? e}). Your token was kept — reload to retry.`); console.error(e); }); else showLogin();
addEventListener('hashchange', () => { if (app.me) go(location.hash.slice(1)); });
