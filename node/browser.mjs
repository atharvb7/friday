// Browser control on the laptop via Playwright + the system Chrome, using a
// DEDICATED Friday profile (log into WhatsApp etc. once, manually; sessions persist).
// The model never sees cookies or passwords. Elements are addressed by short refs
// produced by snapshot(), so clicks are DOM-based, not guessed pixel coordinates.
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
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
  return { url: location.href, title: document.title, headings, elements: out, text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3500) };
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

export class BrowserController {
  constructor({ chromium, profileDir, executablePath = '/usr/bin/google-chrome', headless = false, allowedDirs = [], allowPrivate = false }) {
    Object.assign(this, { chromium, profileDir, executablePath, headless, allowedDirs, allowPrivate }); // allowPrivate is for tests only
    this.ctx = null; this.page = null;
  }

  async ensure() {
    if (this.ctx && this.page && !this.page.isClosed()) return this.page;
    if (!this.ctx) {
      this.ctx = await this.chromium.launchPersistentContext(this.profileDir, { executablePath: this.executablePath, headless: this.headless, viewport: { width: 1280, height: 800 }, args: ['--no-first-run', '--no-default-browser-check'] });
      this.ctx.on('close', () => { this.ctx = null; this.page = null; });
      // Every request (incl. redirects and sub-resources) is checked: private/loopback/LAN targets and non-web schemes are blocked.
      if (!this.allowPrivate) await this.ctx.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
        if (!['http:', 'https:'].includes(u.protocol) || await hostIsPrivate(u.hostname)) return route.abort('blockedbyclient');
        return route.continue();
      });
    }
    this.page = this.ctx.pages()[0] ?? await this.ctx.newPage();
    return this.page;
  }

  async open({ url }) {
    const page = await this.ensure();
    await page.goto(checkUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return { url: page.url(), title: await page.title() };
  }
  async snapshot() { return (await this.ensure()).evaluate(SNAPSHOT_FN); }
  #loc(page, ref) { if (!Number.isInteger(ref) || ref < 1) throw new Error('invalid_ref'); return page.locator(`[data-friday-ref="${ref}"]`).first(); }
  async #present(l) { try { await l.waitFor({ state: 'attached', timeout: 2000 }); } catch { throw new Error('stale_ref: that element is no longer on the page — call browser_snapshot again and use the new refs'); } }
  async click({ ref }) {
    const page = await this.ensure();
    const l = this.#loc(page, ref); await this.#present(l);
    await l.click({ timeout: 8_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { url: page.url(), title: await page.title() };
  }
  async type({ ref, text, clear = true, submit = false }) {
    const page = await this.ensure();
    const l = this.#loc(page, ref); await this.#present(l);
    if (clear) await l.fill(String(text), { timeout: 10_000 }); else await l.pressSequentially(String(text), { timeout: 10_000 });
    if (submit) await l.press('Enter');
    return { typed: String(text).length, submitted: Boolean(submit) };
  }
  async press({ key }) { const page = await this.ensure(); if (!/^[A-Za-z0-9+]{1,30}$/.test(String(key))) throw new Error('invalid_key'); await page.keyboard.press(String(key)); return { pressed: key }; }
  async upload({ ref, path }) {
    const page = await this.ensure();
    const real = checkFile(path, this.allowedDirs);
    await this.#loc(page, ref).setInputFiles(real, { timeout: 10_000 });
    return { uploaded: real.split('/').pop() };
  }
  async scroll({ dy = 600 }) { const page = await this.ensure(); await page.mouse.wheel(0, Math.max(-5000, Math.min(5000, Number(dy)))); return { scrolled: dy }; }
  async back() { const page = await this.ensure(); await page.goBack({ timeout: 10_000 }).catch(() => {}); return { url: page.url() }; }
  // Waits are short on purpose: the agent should LOOK (snapshot) instead of waiting for text it guessed.
  async wait({ ms = 1000, text = null }) {
    const page = await this.ensure();
    if (text) { try { await page.getByText(String(text)).first().waitFor({ timeout: Math.min(Number(ms) || 5000, 6000) }); } catch { throw new Error(`text_not_found: "${String(text).slice(0, 60)}" did not appear — call browser_snapshot to see what is actually on the page`); } }
    else await page.waitForTimeout(Math.min(Number(ms) || 1000, 5000));
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
  async screenshot({ scale = 0.6 } = {}) {
    const page = await this.ensure();
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' });
    return { mime: 'image/jpeg', base64: buf.toString('base64'), url: page.url(), scale };
  }
  async close() { await this.ctx?.close().catch(() => {}); this.ctx = null; this.page = null; }
}
