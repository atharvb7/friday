// Browser control on the laptop via Playwright + the system Chrome, using a
// DEDICATED Friday profile (log into WhatsApp etc. once, manually; sessions persist).
// The model never sees cookies or passwords. Elements are addressed by short refs
// produced by snapshot(), so clicks are DOM-based, not guessed pixel coordinates.
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { hostIsPrivate, isPrivateAddress } from './netpolicy.mjs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';

const SNAPSHOT_FN = () => {
  document.querySelectorAll('[data-friday-ref]').forEach((e) => e.removeAttribute('data-friday-ref'));
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[role=menuitem],[role=checkbox],[role=tab],[role=option],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const out = [];
  let n = 0;
  // Generic labels ("Select", "Book", "View") are ambiguous when a page repeats them per card: add the card's title.
  const GENERIC = /^(select|book|add|view|choose|details|more|buy|open|go|continue|edit|remove|see all|learn more|read more|next|reserve|pick|apply|book now|select slot)$/i;
  const context = (e) => {
    let a = e.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const lines = (a.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const title = lines.find((x) => x.length > 2 && !GENERIC.test(x) && !/^[₹$€£]?\s?\d[\d.,]*\s?(min|mins|hr|hrs)?$/i.test(x));
      if (lines.length >= 2 && title) return title.slice(0, 40);
    }
    return '';
  };
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < innerHeight * 3; };
  for (const e of document.querySelectorAll(sel)) {
    const isFile = e.tagName === 'INPUT' && e.type === 'file';
    if (!isFile && !vis(e)) continue;
    if (++n > 120) break;
    const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 90);
    e.setAttribute('data-friday-ref', String(n));
    const label = name; // disambiguated below, once we know which labels repeat
    out.push({ ref: n, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || undefined, type: e.type || undefined, name: label, value: ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) && e.type !== 'password' ? String(e.value ?? '').slice(0, 80) : undefined, href: e.href ? String(e.href).slice(0, 120) : undefined, disabled: e.disabled || e.getAttribute('aria-disabled') === 'true' || undefined, hidden: isFile && !vis(e) ? true : undefined, checked: e.checked || undefined });
  }
  // Modern UIs make calendar days, time slots and cards from plain divs with click handlers (invisible to the selector
  // above). Treat visible elements with cursor:pointer as clickable, skipping ones nested in something already listed.
  if (n < 120) {
    const taken = new Set([...document.querySelectorAll('[data-friday-ref]')]);
    let scanned = 0;
    for (const e of document.body ? document.body.querySelectorAll('div,span,li,td,label,img,svg,p') : []) {
      if (++scanned > 6000 || n >= 120) break;
      if (taken.has(e) || e.closest('[data-friday-ref]') || !vis(e)) continue;
      if (getComputedStyle(e).cursor !== 'pointer') continue;
      const kids = [...e.querySelectorAll('*')].some((k) => getComputedStyle(k).cursor === 'pointer' && !k.closest('[data-friday-ref]') && k !== e);
      if (kids && e.children.length > 3) continue; // a big container whose children are the real targets
      const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('alt') || e.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 90);
      n += 1; e.setAttribute('data-friday-ref', String(n)); taken.add(e);
      out.push({ ref: n, tag: e.tagName.toLowerCase(), role: 'clickable', name });
    }
  }
  const counts = {};
  for (const o of out) if (GENERIC.test(o.name)) counts[o.name.toLowerCase()] = (counts[o.name.toLowerCase()] ?? 0) + 1;
  for (const o of out) {
    if (!GENERIC.test(o.name) || counts[o.name.toLowerCase()] < 2) continue; // only labels that REPEAT need a title
    const el = document.querySelector(`[data-friday-ref="${o.ref}"]`);
    const c = el ? context(el) : '';
    if (c) o.name = `${o.name} — ${c}`;
  }
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 12).map((h) => ({ level: h.tagName.toLowerCase(), text: h.innerText.trim().replace(/\s+/g, ' ').slice(0, 120) }));
  return { url: location.href, title: document.title, headings, elements: out, text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500) };
};

export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return net.isIP(h) ? isPrivateAddress(h) : false; // names are resolved + checked per request (see guard())
}

export function checkUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error('invalid_url'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('only_http_urls');
  if (isPrivateHost(url.hostname)) throw new Error('private_address_blocked');
  return url.toString();
}

const SECRET_NAME = /(token|secret|credential|passw(or)?d|\.sqlite|\.env|id_rsa|id_ed25519|\.pem|\.key|\.kdbx|wallet|seed|\.pfx|\.p12|cookies)/i;
const markerExists = (p, name) => { if (!existsSync(p)) return false; return name === 'config.json' ? existsSync(join(dirname(p), 'friday.sqlite')) : true; };

// Only files under allowed dirs, never dotfiles/dot-directories, real paths only.
export function checkFile(path, allowedDirs) {
  const real = realpathSync(resolve(path));
  if (!statSync(real).isFile()) throw new Error('not_a_file');
  const ok = allowedDirs.map((d) => { try { return realpathSync(d); } catch { return null; } }).filter(Boolean).find((d) => real === d || real.startsWith(`${d}/`));
  if (!ok) throw new Error('path_not_allowed');
  if (real.slice(ok.length).split('/').some((seg) => seg.startsWith('.'))) throw new Error('hidden_path_blocked');
  // Never hand Friday's own secrets (or credential-looking files) to a web page, even inside an allowed dir.
  if (SECRET_NAME.test(real.split('/').pop())) throw new Error('sensitive_file_blocked');
  let dir = dirname(real);
  for (let i = 0; i < 4 && dir !== ok && dir.length > ok.length; i++, dir = dirname(dir)) {
    for (const marker of ['access-token', 'friday.sqlite', '.env', 'config.json']) if (markerExists(join(dir, marker), marker)) throw new Error('inside_friday_data_blocked');
  }
  if (lstatSync(resolve(path)).isSymbolicLink()) { /* realpath already resolved; target is inside allowed dirs */ }
  return real;
}

// Apps that are slow to load and should stay open in their own tab (never navigated away from).
const STICKY_HOSTS = new Set(['web.whatsapp.com']);
// Resolves once the DOM has been quiet for quietMs (and, if minInteractive, the page has that many interactive
// elements), or after maxMs. Replaces fixed sleeps: fast pages return in ~quietMs, slow apps get the full budget.
const SETTLE_FN = ({ quietMs, maxMs, minInteractive }) => new Promise((resolve) => {
  const start = Date.now(); let last = Date.now();
  const obs = new MutationObserver(() => { last = Date.now(); });
  obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const count = () => document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=listitem],[role=row],[tabindex]').length;
  const tick = () => {
    const now = Date.now();
    if (now - start >= maxMs || (now - last >= quietMs && (!minInteractive || count() >= minInteractive))) { obs.disconnect(); resolve(now - start); return; }
    setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
});

export class BrowserController {
  constructor({ chromium, profileDir, executablePath = '/usr/bin/google-chrome', headless = false, allowedDirs = [], allowPrivate = false, downloadRoot = null }) {
    Object.assign(this, { chromium, profileDir, executablePath, headless, allowedDirs, allowPrivate }); // allowPrivate is for tests only
    this.ctx = null; this.page = null;
    // Files the agent downloads (e.g. generated images/videos) land in <Downloads>/friday-media/<folder>/.
    this.downloadRoot = downloadRoot ?? (allowedDirs.find((d) => /\/Downloads$/.test(d)) ? join(allowedDirs.find((d) => /\/Downloads$/.test(d)), 'friday-media') : null);
    this.downloadFolder = 'inbox'; this.downloads = [];
  }
  #watchDownloads(page) {
    page.on('download', async (d) => {
      if (!this.downloadRoot) return d.cancel().catch(() => {});
      const dir = join(this.downloadRoot, this.downloadFolder); mkdirSync(dir, { recursive: true });
      const base = String(d.suggestedFilename() || 'download').replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'download';
      let target = join(dir, base); for (let i = 2; existsSync(target); i++) target = join(dir, base.replace(/(\.[^.]*)?$/, `-${i}$1`));
      const rec = { name: target.split('/').pop(), path: target, status: 'downloading', started: new Date().toISOString() };
      this.downloads.push(rec); if (this.downloads.length > 50) this.downloads.shift();
      try { await d.saveAs(target); rec.status = 'done'; rec.size = statSync(target).size; } catch (e) { rec.status = `failed: ${String(e.message).slice(0, 80)}`; }
    });
  }

  async ensure() {
    if (this.ctx && this.page && !this.page.isClosed()) return this.page;
    if (!this.ctx) {
      // Launch like a normal Chrome: keep Chrome's sandbox on and drop the "controlled by automation" flags —
      // Google refuses sign-in ("This browser or app may not be secure") in browsers that advertise automation.
      this.ctx = await this.chromium.launchPersistentContext(this.profileDir, { executablePath: this.executablePath, headless: this.headless, viewport: { width: 1280, height: 800 },
        chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'], args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'] });
      this.ctx.on('close', () => { this.ctx = null; this.page = null; });
      // A site opening a popup / new tab (target=_blank, "continue in app"): follow it, like a person would.
      this.ctx.on('page', (p) => { this.page = p; this.#watchDownloads(p); p.on('close', () => { if (this.page === p) this.page = this.ctx?.pages().at(-1) ?? null; }); });
      // Every request (incl. redirects and sub-resources) is checked: private/loopback/LAN targets and non-web schemes are blocked.
      if (!this.allowPrivate) await this.ctx.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
        if (!['http:', 'https:'].includes(u.protocol) || await hostIsPrivate(u.hostname)) return route.abort('blockedbyclient');
        return route.continue();
      });
    }
    this.page = this.ctx.pages()[0] ?? await this.ctx.newPage();
    for (const p of this.ctx.pages()) if (!p._fridayDl) { p._fridayDl = true; this.#watchDownloads(p); }
    return this.page;
  }

  async settle(page, { quietMs = 300, maxMs = 1500, minInteractive = 0 } = {}) {
    try { return await page.evaluate(SETTLE_FN, { quietMs, maxMs, minInteractive }); } catch { return 0; } // navigation mid-wait: fine
  }
  async open({ url }) {
    let page = await this.ensure();
    const target = new URL(checkUrl(url));
    // Reuse an already-open tab of the same site (WhatsApp stays loaded instead of re-syncing for 20s every time).
    const existing = this.ctx.pages().find((p) => { try { return new URL(p.url()).host === target.host; } catch { return false; } });
    const sticky = STICKY_HOSTS.has(target.host);
    if (existing && (sticky || existing === page)) {
      page = this.page = existing; await page.bringToFront().catch(() => {});
      const cur = new URL(page.url());
      if (!(sticky && target.pathname === '/') && cur.href !== target.href) await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      let curHost = ''; try { curHost = new URL(page.url()).host; } catch {}
      if (STICKY_HOSTS.has(curHost) || sticky) { page = this.page = await this.ctx.newPage(); } // never navigate a sticky app away; give a sticky app its own tab
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    if (this.ctx.pages().length > 5) for (const p of this.ctx.pages().slice(0, -5)) { let h = ''; try { h = new URL(p.url()).host; } catch {} if (p !== page && !STICKY_HOSTS.has(h)) await p.close().catch(() => {}); }
    await this.settle(page, sticky ? { quietMs: 600, maxMs: 25_000, minInteractive: 15 } : { quietMs: 300, maxMs: 3000 });
    return { url: page.url(), title: await page.title() };
  }
  // settleMs lets SPA transitions finish before reading the page (used for the automatic post-action snapshot).
  async snapshot({ settleMs = 0 } = {}) {
    const page = await this.ensure(); if (settleMs) await this.settle(page, { quietMs: 250, maxMs: Math.min(Number(settleMs) || 0, 3000) });
    const snap = await page.evaluate(SNAPSHOT_FN);
    this.sigs = new Map(snap.elements.map((e) => [e.ref, { tag: e.tag, role: e.role, name: String(e.name ?? '').split(' — ')[0].trim(), full: e.name }]));
    return snap;
  }
  // Refs are attributes written at snapshot time; SPAs re-render and drop them. If the ref is gone but the element it
  // named still exists on the page (same tag + same visible text), act on that one instead of failing.
  async #resolve(page, ref) {
    if (!Number.isInteger(ref) || ref < 1) throw new Error('invalid_ref');
    const direct = page.locator(`[data-friday-ref="${ref}"]`).first();
    if (await direct.count()) return direct;
    const sig = this.sigs?.get(ref);
    if (sig?.name && sig.name.length >= 2) {
      const base = sig.tag === 'clickable' || sig.role === 'clickable' ? page.locator('div,span,li,td,label,p,button,a') : page.locator(sig.tag);
      const cands = base.filter({ hasText: sig.name });
      const n = await cands.count();
      for (let i = 0; i < Math.min(n, 12); i++) { // prefer the innermost visible match whose text equals the remembered name
        const c = cands.nth(i);
        if (await c.isVisible().catch(() => false) && (await c.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').startsWith(sig.name)) { this.healed = (this.healed ?? 0) + 1; return c; }
      }
    }
    throw new Error('stale_ref: that element is no longer on the page — use a ref from the latest page listing');
  }
  #loc(page, ref) { return this.#resolve(page, ref); }
  async click({ ref }) {
    const page = await this.ensure();
    const l = await this.#loc(page, ref);
    await l.click({ timeout: 8_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { url: page.url(), title: await page.title() };
  }
  async type({ ref, text, clear = true, submit = false }) {
    const page = await this.ensure();
    const l = await this.#loc(page, ref);
    if (clear) await l.fill(String(text), { timeout: 10_000 }); else await l.pressSequentially(String(text), { timeout: 10_000 });
    if (submit) await l.press('Enter');
    return { typed: String(text).length, submitted: Boolean(submit) };
  }
  async press({ key }) { const page = await this.ensure(); if (!/^[A-Za-z0-9+]{1,30}$/.test(String(key))) throw new Error('invalid_key'); await page.keyboard.press(String(key)); return { pressed: key }; }
  async upload({ ref, path }) {
    const page = await this.ensure();
    const real = checkFile(path, this.allowedDirs);
    await (await this.#loc(page, ref)).setInputFiles(real, { timeout: 10_000 });
    return { uploaded: real.split('/').pop() };
  }
  async scroll({ dy = 600 }) { const page = await this.ensure(); await page.mouse.wheel(0, Math.max(-5000, Math.min(5000, Number(dy)))); return { scrolled: dy }; }
  async back() { const page = await this.ensure(); await page.goBack({ timeout: 10_000 }).catch(() => {}); return { url: page.url() }; }
  // Waits are short on purpose: the agent should LOOK (snapshot) instead of waiting for text it guessed.
  async wait({ ms = 1000, text = null }) {
    const page = await this.ensure();
    if (text) { try { await page.getByText(String(text)).first().waitFor({ timeout: Math.min(Number(ms) || 5000, 6000) }); } catch { throw new Error(`text_not_found: "${String(text).slice(0, 60)}" did not appear — call browser_snapshot to see what is actually on the page`); } }
    else return { waited: true, ms: await this.settle(page, { quietMs: 500, maxMs: Math.min(Number(ms) || 1000, 15_000), minInteractive: 5 }) }; // returns as soon as the page is loaded and still
    return { waited: true };
  }
  async click_text({ text, exact = false }) {
    const page = await this.ensure();
    const l = page.getByText(String(text), { exact: Boolean(exact) }).first();
    try { await l.waitFor({ state: 'visible', timeout: 4000 }); } catch { throw new Error(`text_not_found: no visible element with text "${String(text).slice(0, 60)}"`); }
    await l.click({ timeout: 6000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
    return { clicked: String(text).slice(0, 60), url: page.url() };
  }
  // Deterministic Instagram DM: profile -> Message -> verify the open thread is the 1:1 chat with exactly this user
  // (never a group they are in) -> type -> send -> confirm the text shows up. No model in the loop, no guessing.
  async ig_dm_send({ username, text }) {
    const u = String(username ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u)) throw new Error('invalid_username');
    const msg = String(text ?? '').trim();
    if (!msg || msg.length > 1000) throw new Error('invalid_text');
    await this.open({ url: `https://www.instagram.com/${u}/` });
    const page = this.page;
    if (/accounts\/login/.test(page.url())) throw new Error('instagram_login_required');
    const btn = page.getByRole('button', { name: /^message$/i }).or(page.getByRole('link', { name: /^message$/i })).first();
    try { await btn.waitFor({ state: 'visible', timeout: 12_000 }); } catch { throw new Error('no_message_button: cannot open a DM from this profile'); }
    await btn.click({ timeout: 8000 });
    // Instagram opens either the full thread (/direct/t/…) or a small chat window over the profile. Either way we use
    // the visible composer and verify that the chat around it belongs to exactly this one user.
    const box = page.locator('div[role="textbox"][contenteditable="true"]').filter({ visible: true }).last();
    try { await box.waitFor({ state: 'visible', timeout: 15_000 }); } catch { throw new Error('dm_composer_did_not_open'); }
    // Who is in this chat? Profile links in the composer's column (above it): a 1:1 chat shows only that person;
    // a group shows several members; the inbox list beside it is in another column and is ignored.
    const owner = await box.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [...new Set([...document.querySelectorAll('a[href]')].filter((a) => /^\/[A-Za-z0-9._]+\/?$/.test(a.getAttribute('href')))
        .map((a) => ({ u: a.getAttribute('href').replace(/\//g, '').toLowerCase(), b: a.getBoundingClientRect() }))
        .filter(({ b }) => b.width > 0 && b.right > r.left - 40 && b.left < r.right + 40 && b.bottom <= r.bottom + 5 && b.top > r.top - 900)
        .map((x) => x.u))];
    });
    if (owner.length !== 1 || owner[0] !== u) throw new Error(`thread_not_verified: the open chat belongs to ${owner.join(', ') || 'nobody identifiable'}, not @${u}`);
    await box.click();
    const lines = msg.split('\n');
    for (let i = 0; i < lines.length; i++) { if (i) await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText(lines[i]); }
    await page.keyboard.press('Enter');
    const probe = lines[0].slice(0, 40);
    try { await page.getByText(probe, { exact: false }).last().waitFor({ state: 'visible', timeout: 10_000 }); } catch { throw new Error('send_not_confirmed: the message did not appear in the chat'); }
    return { sent: true, to: u, thread: page.url() };
  }
  // Choose the sub-folder of Downloads/friday-media for the next downloads (one folder per project).
  async download_folder({ name }) {
    const n = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!n) throw new Error('invalid_folder_name');
    if (!this.downloadRoot) throw new Error('downloads_not_allowed');
    this.downloadFolder = n; mkdirSync(join(this.downloadRoot, n), { recursive: true });
    return { folder: join(this.downloadRoot, n) };
  }
  // Recent downloads (waits up to waitMs for in-progress ones, e.g. a video that is still saving).
  async downloads_list({ waitMs = 0 } = {}) {
    const until = Date.now() + Math.min(Number(waitMs) || 0, 120_000);
    while (this.downloads.some((d) => d.status === 'downloading') && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    return { folder: this.downloadRoot ? join(this.downloadRoot, this.downloadFolder) : null, downloads: this.downloads.slice(-20).map(({ name, path, status, size }) => ({ name, path, status, size })) };
  }
  async screenshot({ scale = 0.6 } = {}) {
    const page = await this.ensure();
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' });
    return { mime: 'image/jpeg', base64: buf.toString('base64'), url: page.url(), scale };
  }
  async close() { await this.ctx?.close().catch(() => {}); this.ctx = null; this.page = null; }
}
