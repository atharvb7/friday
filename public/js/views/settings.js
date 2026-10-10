import { h, clear, timeAgo } from '../util.js';

const TRAITS = ['humor', 'sarcasm', 'warmth', 'formality', 'energy', 'chaos', 'profanity', 'verbosity', 'seriousness'];
const LEVELS = ['ask', 'trusted', 'autonomous', 'high'];
const LEVEL_HELP = { ask: 'asks before anything', trusted: 'routine actions run', autonomous: 'consequential actions run', high: 'critical actions run (time-boxed)' };
const CATS = { research: 'Research & web', coding: 'Coding', browser: 'Browser', computer: 'Computer control', messaging: 'Messaging others', spending: 'Spending money', deletion: 'Deleting data', system: 'System & security' };

export function render({ app, api, toast, go }) {
  const owner = app.me?.kind === 'owner';
  const el = h('div', { class: 'page stack' }, h('div', { class: 'page-head' }, h('h2', {}, 'Settings')));
  const section = (title, ...kids) => { const c = h('section', { class: 'card stack' }, h('h3', {}, title), ...kids); el.append(c); return c; };
  const totpHeader = async () => (app.me?.kind === 'device' && app.totpActive ? prompt('Authenticator code (6 digits)') || null : undefined);

  async function build() {
    const [pers, tz, auto, pro, health, models] = await Promise.all([api('/v1/personality'), api('/v1/settings/timezone'), api('/v1/autonomy'), api('/v1/proactive'), api('/v1/health'), api('/v1/models')]);
    while (el.children.length > 1) el.lastChild.remove();

    // Profile & personality
    const name = h('input', { type: 'text', value: pers.userName ?? '', placeholder: 'What should I call you?' });
    const tzi = h('input', { type: 'text', value: tz.timezone, placeholder: 'Asia/Kolkata' });
    const vals = { ...pers.personality };
    const sliders = TRAITS.map((t) => { const out = h('span', { class: 'mono' }, String(vals[t])); const r = h('input', { type: 'range', min: 0, max: 10, value: vals[t], 'aria-label': t }); r.addEventListener('input', () => { vals[t] = Number(r.value); out.textContent = r.value; }); return h('div', { class: 'slider-row' }, h('span', {}, t), r, out); });
    section('You & personality', h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('label', {}, 'Name'), name), h('div', { class: 'grow' }, h('label', {}, 'Timezone'), tzi)),
      h('p', { class: 'muted' }, 'Personality changes how I talk — never what I’m allowed to do.'), ...sliders,
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('/v1/personality', { method: 'POST', body: { personality: vals, userName: name.value } }); if (tzi.value !== tz.timezone) await api('/v1/settings/timezone', { method: 'POST', body: { timezone: tzi.value.trim() } }); toast('Saved.'); } catch (e) { toast(e.message); }
      } }, 'Save'));

    // Autonomy
    const rows = Object.entries(CATS).map(([c, label]) => {
      const cur = auto.autonomy[c];
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': label }, LEVELS.map((l) => h('button', { class: `${cur.level === l ? 'on' : ''} ${l === 'high' ? 'high' : ''}`, title: LEVEL_HELP[l], onclick: async () => {
        let hours; if (l === 'high') { hours = Number(prompt('High autonomy for how many hours? (max 12). It auto-reverts and “Stop” cancels it instantly.', '2')); if (!hours) return; }
        const totp = await totpHeader(); if (totp === null) return;
        try { await api('/v1/autonomy', { method: 'POST', body: { category: c, level: l, hours }, totp }); build(); refreshApp(); } catch (e) { toast(e.message === 'totp_required' ? 'Authenticator code required' : e.message); }
      } }, l)));
      return h('div', { class: 'row wrap' }, h('span', { class: 'grow' }, label, cur.until ? h('span', { class: 'chip bad' }, ` until ${new Date(cur.until).toLocaleTimeString()}`) : null), seg);
    });
    section('Autonomy', h('p', { class: 'muted' }, 'How much I may do on my own, per area. Critical actions (money, destructive, security) only run under a time-boxed “high”. Everything else I’d ask about shows up in your Inbox.'), ...rows);

    // Proactive
    const on = h('input', { type: 'checkbox', checked: pro.proactive.enabled });
    const qs = h('input', { type: 'time', value: pro.proactive.quietHours.start }); const qe = h('input', { type: 'time', value: pro.proactive.quietHours.end });
    const bon = h('input', { type: 'checkbox', checked: pro.proactive.briefing.enabled }); const bt = h('input', { type: 'time', value: pro.proactive.briefing.time });
    const cap = h('input', { type: 'number', min: 0, max: 50, value: pro.proactive.maxPerDay });
    section('Proactive Friday', h('label', { class: 'row' }, on, ' Let me speak up when something needs attention'),
      h('div', { class: 'row wrap' }, h('div', {}, h('label', {}, 'Quiet from'), qs), h('div', {}, h('label', {}, 'until'), qe), h('div', {}, h('label', {}, 'Max per day'), cap)),
      h('label', { class: 'row' }, bon, ' Morning briefing at ', bt),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { await api('/v1/proactive', { method: 'POST', body: { enabled: on.checked, maxPerDay: Number(cap.value), quietHours: { start: qs.value, end: qe.value }, briefing: { enabled: bon.checked, time: bt.value } } }); toast('Saved.'); } catch (e) { toast(e.message); } } }, 'Save'),
        h('button', { class: 'btn', onclick: async () => { toast('Composing…'); const r = await api('/v1/briefing/now', { method: 'POST' }); alert(r.briefing); } }, 'Preview briefing')));

    // Phone notifications (Web Push)
    const pushKey = await api('/v1/push/key');
    const pushState = h('span', { class: 'muted' }, `${pushKey.subscriptions} device(s) subscribed`);
    section('Notifications on this device', h('p', { class: 'muted' }, 'Get a push when a task finishes, a reminder fires, or I need your approval — even with the app closed. Needs HTTPS (e.g. via Tailscale) or localhost.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => enablePush(pushKey.publicKey, pushState) }, 'Enable notifications'), pushState));

    // Devices & security (owner only)
    if (owner) {
      const { devices } = await api('/v1/devices');
      const devList = h('div', { class: 'list' }, devices.filter((d) => !d.revoked_at).map((d) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', {}, d.name), h('div', { class: 'meta muted' }, `${d.scopes.join(', ')} · ${d.last_seen_at ? `seen ${timeAgo(d.last_seen_at)}` : 'never used'}`)),
        h('button', { class: 'btn small bad', onclick: async () => { if (confirm(`Revoke ${d.name}?`)) { await api(`/v1/devices/${d.id}`, { method: 'DELETE' }); build(); } } }, 'Revoke'))));
      const dn = h('input', { type: 'text', placeholder: 'Device name (e.g. phone, laptop-node)' });
      const sc = h('select', {}, [['read,chat,tasks,approve', 'Phone (chat, tasks, approvals)'], ['read,node', 'Laptop node'], ['read', 'Read-only (e.g. desk companion)'], ['read,chat,tasks', 'Phone without approvals']].map(([v, l]) => h('option', { value: v }, l)));
      const reveal = h('div');
      section('Devices & security', devList.children.length ? devList : h('p', { class: 'muted' }, 'No devices yet.'),
        h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, dn), sc, h('button', { class: 'btn primary', onclick: async () => {
          if (!dn.value.trim()) return;
          try { const r = await api('/v1/devices', { method: 'POST', body: { name: dn.value, scopes: sc.value.split(',') } });
            clear(reveal).append(h('div', { class: 'banner' }, 'Copy this token now — it is shown once:', h('pre', { class: 'mono' }, r.device.token))); } catch (e) { toast(e.message); } } }, 'Add device')), reveal,
        h('div', { class: 'row' }, app.totpActive ? h('span', { class: 'chip good' }, '✓ Authenticator active — phone approvals require a code') : h('button', { class: 'btn', onclick: enrollTotp }, 'Set up authenticator (recommended before using the phone)')));
    }

    // Capabilities & health
    const chip = (s) => ({ ok: 'good', degraded: 'warn', down: 'bad', off: '' })[s] ?? '';
    section(`System health — ${health.overall}`, h('div', { class: 'list' }, health.checks.map((c) => h('div', { class: 'row' }, h('span', { class: `chip ${chip(c.status)}` }, c.status), h('strong', {}, c.name.replace(/_/g, ' ')), h('span', { class: 'muted grow' }, c.detail)))));
    section('Models (last 24h)', models.stats24h.length ? h('div', { class: 'list' }, models.stats24h.map((s) => h('div', { class: 'row wrap' }, h('span', { class: 'chip accent' }, s.role), h('span', { class: 'mono grow' }, s.model.split('/').pop()), h('span', { class: 'muted' }, `${s.ok_calls}/${s.calls} ok · ${s.avg_ms}ms · ${(s.prompt_tokens + s.completion_tokens).toLocaleString()} tok`)))) : h('p', { class: 'muted' }, 'No model calls yet.'));
    const [sk, mcp] = await Promise.all([api('/v1/skills'), owner ? api('/v1/mcp') : Promise.resolve({ config: { servers: {} } })]);
    section('Skills & tools', h('div', { class: 'row wrap' }, sk.skills.map((s) => h('span', { class: 'chip', title: s.description }, s.name))), h('div', { class: 'muted' }, `MCP servers: ${Object.keys(mcp.config.servers).join(', ') || 'defaults from your keys (SerpApi, GitHub)'}`));
  }

  async function enablePush(publicKey, label) {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support push (iPhone: add Friday to the Home Screen first).');
      const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permission not granted.');
      const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = await (await reg.pushManager.getSubscription() ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await api('/v1/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      label.textContent = 'Enabled on this device ✓'; toast('Notifications enabled.');
    } catch (e) { toast(e.message); }
  }

  async function enrollTotp() {
    try {
      const r = await api('/v1/auth/totp/enroll', { method: 'POST' });
      const code = prompt(`Add this to your authenticator app, then enter a code.\n\nSecret: ${r.secret}\n\n(or open: ${r.uri})`);
      if (code) { await api('/v1/auth/totp/confirm', { method: 'POST', body: { code: code.trim() } }); app.totpActive = true; toast('Authenticator active.'); build(); }
    } catch (e) { toast(e.message); }
  }
  function refreshApp() { api('/v1/status').then((s) => { app.status = s; app.paint(); }).catch(() => {}); }

  build().catch((e) => el.append(h('div', { class: 'banner' }, `Could not load settings: ${e.message}`)));
  return { el };
}
