import { h, $, clear, icon, toast } from './util.js';
import { api, auth, startEvents, ApiError } from './api.js';
import { svgIcon } from './icons.js';
import * as chat from './views/chat.js';
import * as inbox from './views/inbox.js';
import * as tasks from './views/tasks.js';
import * as research from './views/research.js';
import * as memory from './views/memory.js';
import * as reminders from './views/reminders.js';
import * as settings from './views/settings.js';

const VIEWS = { chat, inbox, tasks, research, memory, reminders, settings };
const LABELS = { chat: 'Chat', inbox: 'Inbox', tasks: 'Tasks', research: 'Research', memory: 'Memory', reminders: 'Reminders', settings: 'Settings' };
const PRIMARY = ['chat', 'inbox', 'tasks']; // phone bottom bar; the rest live under More

export const app = {
  me: null, status: null, unread: 0, pendingApprovals: 0, link: 'offline', current: null, view: null,
  chatBusy: false, listeners: new Set(),
};
const root = document.getElementById('root');

// ---- theme -----------------------------------------------------------------
function applyTheme() { let t = null; try { t = localStorage.getItem('friday.theme'); } catch { /* ignore */ } document.documentElement.dataset.theme = t || 'light'; const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = (t || 'light') === 'light' ? '#fff6f9' : '#1a0f16'; } // baby pink by default
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('friday.theme', next); } catch { /* ignore */ }
  applyTheme();
}
applyTheme();

// ---- login -----------------------------------------------------------------
async function showLogin(message = '', presetToken = '') {
  clear(root);
  let mode = { public: false, totpActive: false };
  try { mode = await (await fetch('/v1/auth/mode', { cache: 'no-store' })).json(); } catch { /* offline: assume private */ }
  const input = h('input', { type: 'password', id: 'tok', autocomplete: 'off', placeholder: 'Access token', 'aria-label': 'Access token', required: true, value: presetToken });
  const code = h('input', { type: 'text', id: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '6-digit code', 'aria-label': 'Authenticator code', required: mode.public });
  const remember = h('input', { type: 'checkbox', id: 'rem', checked: true });
  const err = h('p', { class: 'muted', role: 'alert' }, message);
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      if (mode.public) { // internet: exchange token + authenticator code for a browser session
        const r = await fetch('/v1/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.value.trim(), code: code.value.replace(/\D/g, ''), remember: remember.checked }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { err.textContent = j.message ?? ({ bad_code: 'That code didn’t match — use the current one from your authenticator.', unauthorized: 'That token was not accepted.', too_many_failed_logins: 'Too many failed attempts. Try again in an hour.' }[j.error] ?? `Sign-in failed (${j.error ?? r.status}).`); return; }
        auth.set(j.token, remember.checked);
      } else auth.set(input.value.trim(), remember.checked);
      await boot();
    } catch (ex) { auth.clear(); err.textContent = ex.status === 401 ? 'That token was not accepted.' : `Could not reach Friday (${ex.message}).`; }
  } },
    h('div', {}, h('label', { for: 'tok' }, 'Access token'), input),
    mode.public ? h('div', {}, h('label', { for: 'otp' }, 'Authenticator code'), code) : null,
    h('label', { class: 'row', for: 'rem' }, remember, ' Keep me signed in on this device'),
    h('button', { class: 'btn primary', type: 'submit' }, mode.public ? 'Sign in securely' : 'Connect'), err);
  root.append(h('div', { class: 'login' }, h('div', { class: 'card' }, h('div', { class: 'orb idle' }), h('h1', {}, 'Friday'), h('p', { class: 'muted' }, 'Your personal AI. Enter the access token from your Friday server (or the device token from Settings → Devices).'), form)));
  (presetToken && mode.public ? code : input).focus();
}

// ---- shell -----------------------------------------------------------------
let orb, stateText, linkDot, linkText, stopBtn, navEls = {}, mainEl, moreBtn, sheet, titleEl, headSlot, headRight, stoppedBar;

function isLight() { return (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'light'; }

function openSheet() {
  const item = (icon, label, onclick, cls = '') => h('button', { class: `sheet-item ${cls}`, onclick: () => { closeSheet(); onclick(); } }, svgIcon(icon), h('span', {}, label));
  clear(sheet.panel).append(
    h('div', { class: 'sheet-grab' }),
    h('div', { class: 'sheet-grid' }, ...Object.keys(VIEWS).filter((v) => !PRIMARY.includes(v)).map((v) => item(v, LABELS[v], () => go(v), app.current === v ? 'on' : ''))),
    h('div', { class: 'sheet-list' },
      item(isLight() ? 'moon' : 'sun', isLight() ? 'Dark mode' : 'Light mode', toggleTheme),
      item('power', app.status?.emergencyStopped ? 'Resume Friday' : 'Emergency stop', emergency, 'danger'),
      item('logout', 'Sign out', () => { if (confirm('Sign out of Friday on this device?')) app.signOut(); })));
  sheet.hidden = false; requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeSheet() { sheet.classList.remove('open'); setTimeout(() => { sheet.hidden = true; }, 220); }

function buildShell() {
  clear(root);
  orb = h('div', { class: 'orb idle', id: 'orb' });
  stateText = h('span', { class: 'state' }, 'idle');
  linkDot = h('span', { class: 'dot' }); linkText = h('span', {}, 'connecting');
  stopBtn = h('button', { class: 'btn quiet icon stop-btn', title: 'Emergency stop: cancel all agents and revoke elevated autonomy', 'aria-label': 'Emergency stop', onclick: emergency }, svgIcon('power', 18), h('span', { class: 'hide-mobile' }, 'Stop'));
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'Sections' }, h('div', { class: 'brand' }, h('div', { class: 'orb idle' }), 'Friday'));
  for (const name of Object.keys(VIEWS)) {
    const badge = h('span', { class: 'badge', hidden: true });
    const b = h('button', { class: `nav${PRIMARY.includes(name) ? ' primary' : ''}`, 'data-view': name, onclick: () => go(name), 'aria-label': LABELS[name] }, h('span', { class: 'ico' }, svgIcon(name), badge), h('span', { class: 'lbl' }, LABELS[name]));
    navEls[name] = { b, badge };
    nav.append(b);
  }
  moreBtn = h('button', { class: 'nav more', onclick: openSheet, 'aria-label': 'More' }, h('span', { class: 'ico' }, svgIcon('more')), h('span', { class: 'lbl' }, 'More'));
  nav.append(moreBtn);
  sheet = h('div', { class: 'sheet', hidden: true, onclick: (e) => { if (e.target === sheet) closeSheet(); } });
  sheet.panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-label': 'More' }); sheet.append(sheet.panel);
  mainEl = h('main', { class: 'main', id: 'main' });
  titleEl = h('strong', { class: 'title' }, 'Friday');
  headSlot = h('div', { class: 'head-slot' }); // views put contextual buttons here (e.g. chat history)
  headRight = h('div', { class: 'head-slot right' });
  stoppedBar = h('div', { class: 'stopped-bar', hidden: true }, 'Friday is stopped — agents are paused. ', h('button', { class: 'btn small', onclick: emergency }, 'Resume'));
  const top = h('header', { class: 'topbar' }, headSlot, orb, h('div', { class: 'who' }, titleEl, stateText), h('span', { class: 'grow' }),
    h('div', { class: 'status-line hide-mobile' }, linkDot, linkText), headRight, stopBtn,
    h('button', { class: 'btn quiet icon hide-mobile', title: 'Toggle theme', 'aria-label': 'Toggle theme', onclick: () => { toggleTheme(); } }, svgIcon('moon', 18)));
  root.append(h('div', { class: 'shell' }, top, nav, h('div', { class: 'main-wrap' }, stoppedBar, mainEl), sheet));
}
app.setHeadSlot = (...els) => { clear(headSlot); headSlot.append(...els); };
app.setHeadRight = (...els) => { clear(headRight); headRight.append(...els); };

function go(name) {
  if (!VIEWS[name]) name = 'chat';
  app.view?.destroy?.();
  app.current = name;
  try { history.replaceState(null, '', `#${name}`); } catch { /* ignore */ }
  for (const [n, e] of Object.entries(navEls)) e.b.classList.toggle('active', n === name);
  moreBtn?.classList.toggle('active', !PRIMARY.includes(name));
  clear(headSlot); clear(headRight); clear(mainEl);
  mainEl.classList.remove('enter'); void mainEl.offsetWidth; mainEl.classList.add('enter'); // soft page transition
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
  stateText.textContent = `${s?.mood?.emoji && state === 'idle' ? `${s.mood.emoji} ${s.mood.mood}` : { offline: 'offline', stopped: 'stopped', thinking: 'thinking…', working: `working${s?.worker?.runningCount > 1 ? ` (${s.worker.runningCount})` : ''}`, idle: 'online' }[state]}`;
  stoppedBar.hidden = !s?.emergencyStopped;
  linkDot.className = `dot ${app.link === 'online' ? 'on' : 'bad'}`; linkText.textContent = app.link === 'online' ? `${s?.brain === 'friday-brain' ? 'brain online' : 'local mode'}${s?.nodes?.length ? ' · laptop' : ''}` : 'reconnecting…';
  const badge = app.unread + app.pendingApprovals;
  navEls.inbox.badge.hidden = !badge; navEls.inbox.badge.textContent = badge > 9 ? '9+' : badge;
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

// Pairing link from a QR code (Settings → Devices): take the token from the fragment, then wipe it from the address bar/history.
let pairToken = '';
{ const m = /^#pair=([^&]+)/.exec(location.hash); if (m) { try { pairToken = decodeURIComponent(m[1]); auth.set(pairToken, true); } catch { /* ignore */ } history.replaceState(null, '', location.pathname + location.search); } }
if (auth.token) boot().catch((e) => { const t = auth.token; if (e?.status === 401) auth.clear(); showLogin(e?.status === 401 ? (pairToken ? 'Enter your authenticator code to finish signing in.' : '') : `Something went wrong loading Friday (${e?.message ?? e}). Your token was kept — reload to retry.`, e?.status === 401 && pairToken ? t : ''); console.error(e); }); else showLogin();
addEventListener('hashchange', () => { if (app.me) go(location.hash.slice(1)); });
