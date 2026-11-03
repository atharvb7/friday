#!/usr/bin/env node
// Friday's SERVER browser: a headless Chromium in its own container (compose service `browser`) so research and
// web tasks work while his laptop is off. It joins the node hub like the laptop node does (SSE command stream +
// HTTP results) but offers ONLY browser and research actions: no shell, no files, no desktop, no WhatsApp.
// Network: internal docker network only; every request goes out through Friday's egress proxy (no LAN/tailnet/metadata).
//   env FRIDAY_SERVER_URL (http://friday:4317), FRIDAY_BROWSER_SECRET, FRIDAY_BROWSER_PROXY (http://proxy:3128),
//       FRIDAY_BROWSER_HOME (persistent profiles), CHROMIUM (/usr/bin/chromium)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserController } from './browser.mjs';
import { ResearchBrowser } from './research-browser.mjs';
import { setSelfHosts } from './selfguard.mjs';

const server = String(process.env.FRIDAY_SERVER_URL ?? 'http://friday:4317').replace(/\/+$/, '');
const token = process.env.FRIDAY_BROWSER_SECRET ?? '';
const proxy = process.env.FRIDAY_BROWSER_PROXY || null;
const home = process.env.FRIDAY_BROWSER_HOME ?? '/home/node/browser';
const executablePath = process.env.CHROMIUM ?? '/usr/bin/chromium';
const log = (...a) => console.log(new Date().toISOString(), ...a);
if (token.length < 32) { log('FRIDAY_BROWSER_SECRET missing or short: the server browser stays off'); setInterval(() => {}, 1 << 30); }
else {
  mkdirSync(home, { recursive: true });
  const { chromium } = await import('playwright-core');
  setSelfHosts([new URL(server).hostname, 'friday', 'localhost']);
  // Two profiles: one for multi-step web tasks (keeps cookies between steps), one for research (searches + reading).
  const browser = new BrowserController({ chromium, profileDir: join(home, 'tasks-profile'), executablePath, headless: true, proxy, sandbox: false });
  const research = new ResearchBrowser({ chromium, profileDir: join(home, 'research-profile'), executablePath, proxy, sandbox: false });
  // The task browser holds ~150-300 MB while open: close it after 10 idle minutes (the research one closes itself).
  let lastTask = 0;
  setInterval(() => { if (browser.ctx && Date.now() - lastTask > 10 * 60_000) browser.close().catch(() => {}); }, 60_000).unref();
  const b = (fn) => (a) => { lastTask = Date.now(); return fn(a ?? {}); };
  const handlers = {
    browser_open: b((a) => browser.open(a)), browser_snapshot: b((a) => browser.snapshot(a)), browser_click: b((a) => browser.click(a)), browser_type: b((a) => browser.type(a)),
    browser_press: b((a) => browser.press(a)), browser_scroll: b((a) => browser.scroll(a)), browser_back: b(() => browser.back()), browser_wait: b((a) => browser.wait(a)),
    browser_click_text: b((a) => browser.click_text(a)), browser_screenshot: b((a) => browser.screenshot(a)),
    research_search: (a) => research.search(a ?? {}), research_read: (a) => research.read(a ?? {}),
  };
  const caps = Object.keys(handlers);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = (path, body) => fetch(server + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000) });
  async function execute(c) {
    const fn = handlers[c.action];
    let out;
    try { if (!fn) throw new Error('unknown_action'); out = { id: c.id, ok: true, result: await fn(c.args ?? {}) }; }
    catch (e) { out = { id: c.id, ok: false, error: String(e.message ?? e).slice(0, 300) }; }
    log(c.action, out.ok ? 'ok' : `error: ${out.error}`);
    try { await post('/v1/node/result', out); } catch (e) { log('result post failed', e.message); }
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await browser.close(); await research.close(); process.exit(0); });
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(`${server}/v1/node/stream`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`stream http ${res.status}`);
      await post('/v1/node/hello', { caps, platform: 'server/headless' });
      log('connected; capabilities:', caps.join(','));
      backoff = 1000;
      let buf = ''; const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!frame.startsWith('event: command')) continue;
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          try { void execute(JSON.parse(data.slice(6))); } catch { /* malformed frame */ }
        }
      }
      log('stream ended');
    } catch (e) { log('disconnected:', e.message); }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}
