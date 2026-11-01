import { h, clear, timeAgo } from '../util.js';
import { auth } from '../api.js';
import { qrSvg } from '../qr.js';

const TRAITS = ['humor', 'sarcasm', 'warmth', 'flirt', 'moodiness', 'childishness', 'protectiveness', 'energy', 'chaos', 'profanity', 'formality', 'verbosity'];
const LEVELS = ['ask', 'trusted', 'autonomous', 'high'];
const LEVEL_HELP = { ask: 'asks before anything', trusted: 'routine actions run', autonomous: 'consequential actions run', high: 'critical actions run (time-boxed)' };
const CATS = { research: 'Research & web', coding: 'Coding', browser: 'Browser', computer: 'Computer control', messaging: 'Messaging others', spending: 'Spending money', deletion: 'Deleting data', system: 'System & security' };

export function render({ app, api, toast, go }) {
  const owner = app.me?.kind === 'owner';
  const el = h('div', { class: 'page stack' }, h('div', { class: 'page-head' }, h('h2', {}, 'Settings')));
  const section = (title, ...kids) => { const c = h('section', { class: 'card stack' }, h('h3', {}, title), ...kids); el.append(c); return c; };
  const totpHeader = async () => (app.needsCode?.() && app.totpActive ? prompt('Authenticator code (6 digits)') || null : undefined);

  async function build() {
    const [pers, tz, auto, pro, health, models] = await Promise.all([api('/v1/personality'), api('/v1/settings/timezone'), api('/v1/autonomy'), api('/v1/proactive'), api('/v1/health'), api('/v1/models')]);
    while (el.children.length > 1) el.lastChild.remove();

    // Profile & personality
    const name = h('input', { type: 'text', value: pers.userName ?? '', placeholder: 'What should I call you?' });
    const tzi = h('input', { type: 'text', value: tz.timezone, placeholder: 'Asia/Kolkata' });
    const vals = { ...pers.personality };
    const sliders = TRAITS.map((t) => { const out = h('span', { class: 'mono' }, String(vals[t])); const r = h('input', { type: 'range', min: 0, max: 10, value: vals[t], 'aria-label': t }); r.addEventListener('input', () => { vals[t] = Number(r.value); out.textContent = r.value; }); return h('div', { class: 'slider-row' }, h('span', {}, t), r, out); });
    section('You & personality', h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('label', {}, 'Name'), name), h('div', { class: 'grow' }, h('label', {}, 'Timezone'), tzi)),
      h('p', { class: 'muted' }, `Right now I’m feeling ${pers.mood.emoji} ${pers.mood.mood}. Personality changes how I talk — never what I’m allowed to do.`), ...sliders,
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('/v1/personality', { method: 'POST', body: { personality: vals, userName: name.value } }); if (tzi.value !== tz.timezone) await api('/v1/settings/timezone', { method: 'POST', body: { timezone: tzi.value.trim() } }); toast('Saved.'); } catch (e) { toast(e.message); }
      } }, 'Save'));

    const prof = (await api('/v1/profile')).profile;
    const pin = Object.fromEntries(['name', 'phone', 'email', 'address'].map((f) => [f, h('input', { type: 'text', value: prof[f] ?? '', placeholder: f === 'phone' ? '+91…' : `Your ${f}` })]));
    section('My details', h('p', { class: 'muted' }, 'Used to fill forms for you (bookings, sign-ups). I never show these to the AI model — only type them in. If one is empty I’ll ask you the first time.'),
      ...Object.entries(pin).map(([f, i]) => h('div', {}, h('label', {}, f[0].toUpperCase() + f.slice(1)), i)),
      h('button', { class: 'btn primary', onclick: async () => {
        try { for (const [f, i] of Object.entries(pin)) if (i.value.trim() && i.value.trim() !== (prof[f] ?? '')) await api('/v1/profile', { method: 'POST', body: { field: f, value: i.value.trim() } }); toast('Saved.'); } catch (e) { toast(e.message); }
      } }, 'Save details'));

    // Agents: Hermes, learned playbooks, watches
    const [hs, ls, ws] = await Promise.all([api('/v1/hermes'), api('/v1/learned'), api('/v1/watches')]);
    const learnBox = h('input', { type: 'checkbox', checked: ls.enabled });
    learnBox.addEventListener('change', async () => { await api('/v1/learned/settings', { method: 'POST', body: { enabled: learnBox.checked } }); toast(learnBox.checked ? 'I’ll learn from tasks that work.' : 'Learning paused.'); });
    const pbList = h('div', { class: 'stack' }, ls.playbooks.length ? ls.playbooks.map((p) => h('details', { class: 'card' },
      h('summary', {}, h('strong', {}, p.name), ' — ', h('span', { class: 'muted' }, p.description), p.hosts.length ? h('span', { class: 'chip' }, p.hosts.join(', ')) : null),
      h('pre', { class: 'mono bubble' }, p.body.slice(0, 3000)),
      h('button', { class: 'btn bad', onclick: async () => { if (!confirm(`Forget playbook “${p.name}”?`)) return; await api(`/v1/learned/${p.name}`, { method: 'DELETE' }); toast('Forgotten.'); build(); } }, 'Forget'))) : h('p', { class: 'muted' }, 'Nothing learned yet — I write a playbook after a laptop or Hermes task succeeds.'));
    const wList = h('div', { class: 'stack' }, ws.watches.length ? ws.watches.map((w) => h('div', { class: 'row wrap' },
      h('span', { class: 'grow' }, `👀 ${w.title} `, h('span', { class: 'chip' }, `${w.kind} · every ${w.every_min}m`), w.last_note ? h('span', { class: 'faint small' }, ` ${w.last_note}`) : null),
      h('button', { class: 'btn', onclick: async () => { await api(`/v1/watches/${w.id}`, { method: 'DELETE' }); toast('Stopped watching.'); build(); } }, 'Stop'))) : h('p', { class: 'muted' }, 'Not watching anything. Ask me e.g. “keep an eye on WhatsApp for Salex Now and confirm the booking when it comes”.'));
    const apps = await api('/v1/apps').catch(() => ({ configured: false, apps: [] }));
    const gs = await api('/v1/google').catch(() => ({ configured: false }));
    const gRow = (g, label, hint) => h('div', { class: 'row wrap' },
      h('strong', { class: 'grow' }, `${label} `, h('span', { class: `chip ${g.connected ? 'good' : 'warn'}` }, g.connected ? `connected${g.email ? ` · ${g.email}` : ''}` : g.configured ? 'not connected' : 'Google credentials not set on the server'), h('span', { class: 'faint small' }, ` ${hint}`)),
      g.configured && !g.connected ? h('button', { class: 'btn primary', onclick: async () => { try { const r = await api('/v1/google/connect', { method: 'POST', body: { account: g.account } }); window.open(r.url, '_blank', 'noopener'); toast('Sign in with Google in the new tab (pick the right account), then come back.'); } catch (e) { toast(e.message); } } }, 'Connect') : null,
      g.connected ? h('button', { class: 'btn', onclick: async () => { if (!confirm(`Disconnect ${label} from Friday?`)) return; await api('/v1/google/disconnect', { method: 'POST', body: { account: g.account } }); toast(`${label} disconnected.`); build(); } }, 'Disconnect') : null);
    const [gMain, gOut] = gs.accounts ?? [{ ...gs, account: 'main' }, { configured: gs.configured, account: 'outreach' }];
    const gmailRow = h('div', { class: 'stack' }, gRow(gMain, 'Gmail (personal)', 'your inbox'), gRow(gOut, 'Gmail (outreach)', 'sends cold emails, watched for replies'));
    section('Connected apps', gmailRow, !apps.configured ? h('p', { class: 'muted' }, 'Composio is not set up on the server yet (COMPOSIO_API_KEY).') : apps.error ? h('p', { class: 'muted' }, apps.error) :
      h('div', { class: 'stack' }, ...apps.apps.map((a) => h('div', { class: 'row wrap' },
        h('strong', { class: 'grow' }, a.label, ' ', h('span', { class: `chip ${a.connected ? 'good' : 'warn'}` }, a.connected ? 'connected' : a.pending ? 'waiting for login' : 'not connected')),
        a.connected ? null : h('button', { class: 'btn primary', onclick: async () => { try { const l = await api(`/v1/apps/${a.slug}/connect`, { method: 'POST' }); window.open(l.url, '_blank', 'noopener'); toast('Finish the login in the new tab, then come back.'); } catch (e) { toast(e.message); } } }, 'Connect'),
        a.note ? h('p', { class: 'faint small', style: 'flex-basis:100%' }, a.note) : null))));
    section('Agents & learning',
      h('p', {}, 'Hermes Agent: ', h('span', { class: `chip ${hs.hermes.ready ? 'good' : 'warn'}` }, hs.hermes.ready ? 'connected' : hs.hermes.configured ? `not reachable (${hs.hermes.reason})` : 'not set up')),
      h('label', { class: 'row' }, learnBox, ' Learn playbooks from successful tasks (makes repeat jobs faster)'),
      h('h4', {}, 'Learned playbooks'), pbList, h('h4', {}, 'Watching'), wList);

    const am = await api('/v1/settings/automemory');
    const amBox = h('input', { type: 'checkbox', checked: am.enabled });
    amBox.addEventListener('change', async () => { await api('/v1/settings/automemory', { method: 'POST', body: { enabled: amBox.checked } }); toast(amBox.checked ? 'I’ll decide what to remember.' : 'I’ll only remember what you tell me to.'); });
    section('Memory', h('label', { class: 'row' }, amBox, ' Let Friday decide what to remember (silently, from our chats)'), h('p', { class: 'muted' }, 'Auto-saved items appear in the Memory tab marked “auto:chat”; edit or delete anything there. Passwords and keys are never saved.'));

    // Voice (Whisper listens, Kokoro speaks)
    const vs = await api('/v1/voice/status');
    const PRESETS = [['af_heart:50,af_nicole:50', 'Soft & gentle — Heart + Nicole (default)'], ['af_heart:65,af_nicole:35', 'Soft & playful — Heart + Nicole'], ['af_heart', 'Warm & bright — Heart'], ['af_nicole', 'Soft, hushed — Nicole'], ['af_heart:50,af_sky:50', 'Light & airy — Heart + Sky'], ['af_bella', 'Expressive — Bella'], ['af_sarah', 'Calm — Sarah'], ['bf_emma', 'British, calm — Emma'], ['bf_isabella', 'British, soft — Isabella']];
    const voiceSel = h('select', {}, PRESETS.map(([v, l]) => h('option', { value: v, selected: vs.settings.voice === v }, l)));
    const speed = h('input', { type: 'range', min: 0.8, max: 1.15, step: 0.01, value: vs.settings.speed, 'aria-label': 'Speaking speed' });
    const canExpress = vs.expressive === 'ready';
    const expressive = h('input', { type: 'checkbox', checked: canExpress && vs.settings.engine === 'expressive', disabled: !canExpress });
    const pitch = h('input', { type: 'range', min: 0.9, max: 1.3, step: 0.01, value: vs.settings.pitch ?? 1.12, 'aria-label': 'Cuteness (pitch)' });
    const ready = vs.tts === 'ready' && vs.stt === 'ready';
    const preview = async () => {
      toast('Generating…');
      try {
        const r = await fetch('/v1/voice/speak', { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: expressive.checked ? 'Hey you. [chuckle] It’s me, Friday. [whispering] Did you miss me… or are you just pretending to be busy? [sigh]' : 'Hey you. It’s me, Friday. Did you miss me, or are you just pretending to be busy?', voice: voiceSel.value, speed: Number(speed.value), engine: expressive.checked ? 'expressive' : 'kokoro', pitch: Number(pitch.value) }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        const a = new Audio(URL.createObjectURL(await r.blob())); a.play();
      } catch (e) { toast(`Preview failed: ${e.message}`); }
    };
    section('Voice', h('div', { class: 'row wrap' }, h('span', { class: `chip ${vs.stt === 'ready' ? 'good' : 'warn'}` }, `Listening: ${vs.stt === 'ready' ? `Whisper ${vs.sttModel ?? ''}` : 'browser fallback'}`), h('span', { class: `chip ${vs.tts === 'ready' ? 'good' : 'warn'}` }, `Voice: ${vs.tts !== 'ready' ? 'browser fallback' : canExpress && vs.settings.engine === 'expressive' ? 'expressive (Chatterbox)' : 'Kokoro'}`)),
      ready ? null : h('p', { class: 'muted' }, 'Install the voice engine for accurate listening and a natural voice: run  node bin/friday.mjs voice setup  (one-time ~600 MB download), then restart Friday.'),
      h('div', {}, h('label', {}, 'Her voice'), voiceSel), h('div', {}, h('label', {}, 'Speaking speed'), speed),
      h('label', { class: 'row' }, expressive, canExpress ? ' Expressive voice — she laughs, sighs, whispers and changes tone (a second or two slower to start)' : ' Expressive voice — not installed on this server'),
      h('div', {}, h('label', {}, 'Cuteness (pitch, expressive voice)'), pitch),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: preview, disabled: vs.tts !== 'ready' }, '▶ Preview'), h('button', { class: 'btn primary', onclick: async () => { try { await api('/v1/voice/settings', { method: 'POST', body: { voice: voiceSel.value, speed: Number(speed.value), engine: expressive.checked ? 'expressive' : 'kokoro', pitch: Number(pitch.value) } }); toast('Voice saved.'); } catch (e) { toast(e.message); } } }, 'Save')));

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

    // Standing rules (created by asking Friday: "when a task fails, tell me")
    const { rules } = await api('/v1/rules');
    section('Standing rules', rules.length ? h('div', { class: 'list' }, rules.map((r) => h('div', { class: 'row wrap' },
      h('span', { class: `chip ${r.enabled ? 'good' : ''}` }, r.enabled ? 'on' : 'off'), h('strong', { class: 'grow' }, r.name), h('span', { class: 'muted' }, `${r.event} → ${r.action.kind} · fired ${r.fire_count}×`),
      h('button', { class: 'btn small', onclick: async () => { await api(`/v1/rules/${r.id}/enabled`, { method: 'POST', body: { enabled: !r.enabled } }); build(); } }, r.enabled ? 'Disable' : 'Enable'),
      h('button', { class: 'btn small bad', onclick: async () => { await api(`/v1/rules/${r.id}`, { method: 'DELETE' }); build(); } }, 'Delete'))))
      : h('p', { class: 'muted' }, 'None yet. Try telling me: “whenever a research task finishes, notify me”. (Creating rules needs your approval.)'));

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
      const sc = h('select', {}, [['read,chat,tasks,approve', 'Phone (chat, tasks, approvals)'], ['guest', 'Guest (chat only — Friday won’t share anything private)'], ['read,node', 'Laptop node'], ['read', 'Read-only (e.g. desk companion)'], ['read,chat,tasks', 'Phone without approvals']].map(([v, l]) => h('option', { value: v }, l)));
      const ls = await api('/v1/auth/login-settings').catch(() => null);
      if (ls) {
        const em = h('input', { type: 'email', value: ls.email ?? '', placeholder: 'your@email.com', autocomplete: 'username' });
        const pw = h('input', { type: 'password', placeholder: ls.password ? 'New password (leave empty to keep)' : 'At least 10 characters', autocomplete: 'new-password' });
        const ge = h('input', { type: 'email', value: ls.googleEmail ?? '', placeholder: 'Google account allowed to sign in' });
        const skip = h('input', { type: 'checkbox', checked: ls.googleSkipTotp });
        section('Sign-in methods (fridayy.site)',
          h('p', { class: 'muted' }, 'How you sign in on your public address. Email + password always also asks for your authenticator code.'),
          h('label', {}, 'Email'), em, h('label', {}, 'Password'), pw,
          h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: async () => {
            try { if (!pw.value) { toast('Type a new password first.'); return; } await api('/v1/auth/password', { method: 'POST', body: { email: em.value, password: pw.value } }); pw.value = ''; toast('Password saved 🔐'); build(); } catch (e) { toast(e.message); } } }, ls.password ? 'Change password' : 'Set password'),
            ls.password ? h('button', { class: 'btn', onclick: async () => { if (confirm('Turn off email + password sign-in?')) { await api('/v1/auth/password', { method: 'DELETE' }); build(); } } }, 'Turn off') : null,
            h('span', { class: `chip ${ls.password ? 'good' : ''}` }, ls.password ? 'password set' : 'no password yet')),
          h('h4', {}, 'Sign in with Google'),
          ls.google ? null : h('p', { class: 'muted small' }, 'Not set up on the server yet (needs FRIDAY_SITE_URL and the Google redirect address).'),
          h('label', {}, 'Allowed Google account'), ge,
          h('label', { class: 'row' }, skip, ' Trust Google’s own 2-step verification (skip Friday’s 6-digit code after Google sign-in)'),
          h('button', { class: 'btn', onclick: async () => { try { await api('/v1/auth/google-login', { method: 'POST', body: { email: ge.value, skipTotp: skip.checked } }); toast('Saved.'); build(); } catch (e) { toast(e.message); } } }, 'Save Google settings'));
      }
      const { users } = await api('/v1/users').catch(() => ({ users: [] }));
      const chip = { approved: 'good', pending: 'warn', rejected: 'bad', disabled: 'bad' };
      section('People',
        h('p', { class: 'muted' }, 'Other people who asked for an account on fridayy.site. New requests also arrive in your Inbox as approvals. Approved people get their own chats only — none of your laptop, mail, Instagram, memories or settings.'),
        users.length ? h('div', { class: 'list' }, users.map((u) => h('div', { class: 'row wrap' },
          h('div', { class: 'grow' }, h('strong', {}, u.name), h('div', { class: 'meta muted' }, `${u.email} · via ${u.provider}${u.last_login_at ? ` · last seen ${timeAgo(u.last_login_at)}` : ''}`)),
          h('span', { class: `chip ${chip[u.status] ?? ''}` }, u.status),
          u.status !== 'approved' ? h('button', { class: 'btn small good', onclick: async () => { await api(`/v1/users/${u.id}/status`, { method: 'POST', body: { status: 'approved' } }); toast(`${u.name} can use Friday now.`); build(); } }, 'Approve') : null,
          u.status === 'approved' ? h('button', { class: 'btn small bad', onclick: async () => { if (confirm(`Disable ${u.name}? They are signed out everywhere.`)) { await api(`/v1/users/${u.id}/status`, { method: 'POST', body: { status: 'disabled' } }); build(); } } }, 'Disable') : null))) : h('p', { class: 'muted' }, 'Nobody else has asked for an account yet.'));
      const { sessions } = await api('/v1/sessions').catch(() => ({ sessions: [] }));
      const sessList = h('div', { class: 'list' }, sessions.map((x) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', {}, `🌐 ${x.name ?? x.principal_kind} · ${String(x.user_agent ?? 'browser').replace(/^Mozilla\/5\.0 \(([^)]*)\).*$/, '$1').slice(0, 60)}`), h('div', { class: 'meta muted' }, `${x.ip ?? '?'} · ${x.last_seen_at ? `seen ${timeAgo(x.last_seen_at)}` : 'not used yet'} · until ${x.expires_at.slice(0, 10)}`)),
        h('button', { class: 'btn small bad', onclick: async () => { if (confirm('Sign this browser out?')) { await api(`/v1/sessions/${x.id}`, { method: 'DELETE' }); build(); } } }, 'Sign out'))));
      const reveal = h('div');
      section('Devices & security', devList.children.length ? devList : h('p', { class: 'muted' }, 'No devices yet.'),
        h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, dn), sc, h('button', { class: 'btn primary', onclick: async () => {
          if (!dn.value.trim()) return;
          try { const r = await api('/v1/devices', { method: 'POST', body: { name: dn.value, scopes: sc.value.split(',') } });
            // Pairing QR: the token travels in the URL fragment (#…), which browsers never send to any server.
            const link = `${location.origin}/#pair=${encodeURIComponent(r.device.token)}`;
            const svg = new DOMParser().parseFromString(qrSvg(link, { scale: 4 }), 'image/svg+xml').documentElement;
            svg.setAttribute('class', 'qr'); svg.setAttribute('aria-label', `QR code to sign in ${r.device.name}`);
            clear(reveal).append(h('div', { class: 'banner stack' },
              h('strong', {}, `Scan with ${r.device.name}'s camera to sign it in`), h('div', { class: 'qr-wrap' }, svg),
              h('p', { class: 'faint small' }, 'The phone must be on your Tailscale network. Shown once — close this when done.'),
              h('details', {}, h('summary', {}, 'Or copy the token'), h('pre', { class: 'mono' }, r.device.token)),
              h('button', { class: 'btn small', onclick: () => clear(reveal) }, 'Done'))); } catch (e) { toast(e.message); } } }, 'Add device')), reveal,
        h('h4', {}, 'Signed in over the internet'), sessions.length ? sessList : h('p', { class: 'muted' }, 'No browsers signed in through your domain.'),
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
      const svg = new DOMParser().parseFromString(qrSvg(r.uri, { scale: 5 }), 'image/svg+xml').documentElement;
      svg.setAttribute('class', 'qr'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code for your authenticator app');
      const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456', 'aria-label': '6-digit code' });
      const err = h('p', { class: 'bad small', hidden: true });
      const grouped = r.secret.replace(/(.{4})/g, '$1 ').trim();
      const dlg = h('dialog', { class: 'card totp-dialog' },
        h('h3', {}, 'Set up your authenticator'),
        h('ol', { class: 'muted' }, h('li', {}, 'Open Google Authenticator, Microsoft Authenticator, Authy or 2FAS on your phone.'), h('li', {}, 'Tap + → Scan a QR code, and scan this:')),
        h('div', { class: 'qr-wrap' }, svg),
        h('details', {}, h('summary', {}, 'Can’t scan? Enter the key manually'), h('p', {}, 'Account: Friday · Key: ', h('code', { class: 'mono' }, grouped)), h('p', { class: 'faint small' }, 'Time-based, 6 digits, every 30 seconds.'),
          h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard?.writeText(r.secret).then(() => toast('Key copied.')) }, 'Copy key')),
        h('label', {}, '3. Enter the 6-digit code it shows'), code, err,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: confirmCode }, 'Activate'), h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')));
      async function confirmCode() {
        const c = code.value.replace(/\D/g, '');
        if (c.length !== 6) { err.textContent = 'Enter the 6 digits from the app.'; err.hidden = false; return; }
        try {
          const res = await api('/v1/auth/totp/confirm', { method: 'POST', body: { code: c } });
          if (!res.active) throw new Error('wrong code');
          dlg.close(); app.totpActive = true; toast('Authenticator active ✓'); build();
        } catch { err.textContent = 'That code didn’t match — check the phone’s time is automatic and try the current code.'; err.hidden = false; code.select(); }
      }
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmCode(); });
      dlg.addEventListener('close', () => dlg.remove());
      document.body.append(dlg); dlg.showModal(); code.focus();
    } catch (e) { toast(e.message); }
  }
  function refreshApp() { api('/v1/status').then((s) => { app.status = s; app.paint(); }).catch(() => {}); }

  build().catch((e) => el.append(h('div', { class: 'banner' }, `Could not load settings: ${e.message}`)));
  return { el };
}
