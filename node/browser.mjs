// Browser control on the laptop via Playwright + the system Chrome, using a
// DEDICATED Friday profile (log into WhatsApp etc. once, manually; sessions persist).
// The model never sees cookies or passwords. Elements are addressed by short refs
// produced by snapshot(), so clicks are DOM-based, not guessed pixel coordinates.
import { lstatSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

const SNAPSHOT_FN = () => {
  document.querySelectorAll('[data-friday-ref]').forEach((e) => e.removeAttribute('data-friday-ref'));
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[role=menuitem],[role=checkbox],[role=tab],[role=option],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const out = [];
  let n = 0;
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < innerHeight * 3; };
  for (const e of document.querySelectorAll(sel)) {
    const isFile = e.tagName === 'INPUT' && e.type === 'file';
    if (!isFile && !vis(e)) continue;
    if (++n > 120) break;
    const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 90);
    e.setAttribute('data-friday-ref', String(n));
    out.push({ ref: n, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || undefined, type: e.type || undefined, name, value: ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) && e.type !== 'password' ? String(e.value ?? '').slice(0, 80) : undefined, href: e.href ? String(e.href).slice(0, 120) : undefined, disabled: e.disabled || e.getAttribute('aria-disabled') === 'true' || undefined, hidden: isFile && !vis(e) ? true : undefined, checked: e.checked || undefined });
  }
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 12).map((h) => ({ level: h.tagName.toLowerCase(), text: h.innerText.trim().replace(/\s+/g, ' ').slice(0, 120) }));
  return { url: location.href, title: document.title, headings, elements: out, text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3500) };
};

export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) { const [a, b] = h.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  if (net.isIPv6(h)) return h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd');
  return false;
}

export function checkUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error('invalid_url'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('only_http_urls');
  if (isPrivateHost(url.hostname)) throw new Error('private_address_blocked');
  return url.toString();
}

// Only files under allowed dirs, never dotfiles/dot-directories, real paths only.
export function checkFile(path, allowedDirs) {
  const real = realpathSync(resolve(path));
  if (!statSync(real).isFile()) throw new Error('not_a_file');
  const ok = allowedDirs.map((d) => { try { return realpathSync(d); } catch { return null; } }).filter(Boolean).find((d) => real === d || real.startsWith(`${d}/`));
  if (!ok) throw new Error('path_not_allowed');
  if (real.slice(ok.length).split('/').some((seg) => seg.startsWith('.'))) throw new Error('hidden_path_blocked');
  if (lstatSync(resolve(path)).isSymbolicLink()) { /* realpath already resolved; target is inside allowed dirs */ }
  return real;
}

export class BrowserController {
  constructor({ chromium, profileDir, executablePath = '/usr/bin/google-chrome', headless = false, allowedDirs = [] }) {
    Object.assign(this, { chromium, profileDir, executablePath, headless, allowedDirs });
    this.ctx = null; this.page = null;
  }

  async ensure() {
    if (this.ctx && this.page && !this.page.isClosed()) return this.page;
    if (!this.ctx) {
      this.ctx = await this.chromium.launchPersistentContext(this.profileDir, { executablePath: this.executablePath, headless: this.headless, viewport: { width: 1280, height: 800 }, args: ['--no-first-run', '--no-default-browser-check'] });
      this.ctx.on('close', () => { this.ctx = null; this.page = null; });
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
  async click({ ref }) {
    const page = await this.ensure();
    await this.#loc(page, ref).click({ timeout: 10_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { url: page.url(), title: await page.title() };
  }
  async type({ ref, text, clear = true, submit = false }) {
    const page = await this.ensure();
    const l = this.#loc(page, ref);
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
  async wait({ ms = 1000, text = null }) {
    const page = await this.ensure();
    if (text) await page.getByText(String(text)).first().waitFor({ timeout: Math.min(Number(ms) || 10_000, 30_000) });
    else await page.waitForTimeout(Math.min(Number(ms) || 1000, 15_000));
    return { waited: true };
  }
  async screenshot({ scale = 0.6 } = {}) {
    const page = await this.ensure();
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' });
    return { mime: 'image/jpeg', base64: buf.toString('base64'), url: page.url(), scale };
  }
  async close() { await this.ctx?.close().catch(() => {}); this.ctx = null; this.page = null; }
}
