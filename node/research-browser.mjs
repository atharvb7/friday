// Research browser for the laptop node: a HIDDEN Chrome (own profile, never on his screen) that searches Google and
// reads pages for Friday's research engine. Why the laptop: from his home connection Google answers like it does for
// a person (0.5-1.5 s, real results incl. LinkedIn/X/Reddit pages), free, while the server is blocked or served junk
// by search engines and has only a small SerpApi quota. Pages that need JavaScript (X, LinkedIn, Reddit) render here.
// If he signs in to LinkedIn/X in this profile once (research_login), logged-in pages are readable too.
//   search({ query, num, recent, site })  -> { results:[{title,url,snippet,site,date}], answer, related, blocked? }
//   read({ url, maxChars })               -> { url, title, text, published, site }
import { hostIsPrivate } from './netpolicy.mjs';
import { isSelfHost } from './selfguard.mjs';
import { checkUrl } from './browser.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IDLE_CLOSE_MS = 5 * 60_000;
const MIN_GAP_MS = 900;     // between Google queries: a person-like pace keeps captchas away
const MAX_PAGES = 4;        // parallel reads
const RECENT = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ResearchBrowser {
  constructor({ chromium, profileDir, executablePath, headless = true, allowPrivate = false }) {
    Object.assign(this, { chromium, profileDir, executablePath, headless, allowPrivate });
    this.ctx = null; this.starting = null; this.lastQuery = 0; this.open = 0; this.idle = null; this.blockedUntil = 0;
  }

  async #context() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.open) this.close(); }, IDLE_CLOSE_MS); this.idle.unref?.();
    if (this.ctx) return this.ctx;
    this.starting ??= (async () => {
      const ctx = await this.chromium.launchPersistentContext(this.profileDir, { executablePath: this.executablePath, headless: this.headless, userAgent: UA, locale: 'en-US',
        viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: ['--enable-automation'], args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'] });
      ctx.on('close', () => { this.ctx = null; });
      // Same rule as his browser: no private/LAN/loopback targets, nothing back to Friday herself; skip heavy media.
      if (!this.allowPrivate) await ctx.route('**/*', async (route) => {
        const req = route.request(); const u = new URL(req.url());
        if (['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
        if (!['http:', 'https:'].includes(u.protocol) || isSelfHost(u.hostname) || await hostIsPrivate(u.hostname)) return route.abort('blockedbyclient');
        if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort('blockedbyclient');
        return route.continue();
      });
      for (const p of ctx.pages()) await p.close().catch(() => {});
      this.ctx = ctx; return ctx;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #page(fn) {
    while (this.open >= MAX_PAGES) await sleep(100);
    this.open++;
    const ctx = await this.#context(); const page = await ctx.newPage();
    try { return await fn(page, ctx); } finally { this.open--; await page.close().catch(() => {}); }
  }

  // DuckDuckGo first: in a real browser on his connection it honours site: exactly (LinkedIn people, X posts, Reddit
  // threads) and links are direct. Google is the fallback: its result links are /goto redirects that it slows to a
  // 5-22 s "refresh" page when resolved quickly, so only the first few are resolved. Bing served junk (3 Nov tests).
  async search({ query, num = 10, recent = null, site = null, engine = 'auto' } = {}) {
    const q0 = String(query ?? '').trim();
    if (!q0 || q0.length > 400) throw new Error('query must be 1-400 chars');
    const q = site && !/\bsite:/.test(q0) ? `${q0} site:${String(site).replace(/[^\w.\-/]/g, '')}` : q0;
    const n = Math.min(Math.max(Number(num) || 10, 1), 20);
    const wait = this.lastQuery + MIN_GAP_MS - Date.now(); this.lastQuery = Date.now() + Math.max(0, wait);
    if (wait > 0) await sleep(wait);
    let out = null;
    if (engine !== 'google') { try { out = await this.#ddg(q, n, recent); } catch (e) { out = { results: [], error: String(e.message).slice(0, 120) }; } }
    if ((!out || !out.results.length) && engine !== 'ddg' && Date.now() >= this.blockedUntil) {
      try { const g = await this.#google(q, n, recent); if (g.results.length || !out) out = g; } catch (e) { out ??= { results: [], error: String(e.message).slice(0, 120) }; }
    }
    return { query: q, ...out };
  }

  #ddg(q, n, recent) {
    const params = new URLSearchParams({ q, ia: 'web', kl: 'wt-wt' });
    if (recent && { day: 1, week: 1, month: 1, year: 1 }[recent]) params.set('df', recent[0]);
    return this.#page(async (page) => {
      await page.goto(`https://duckduckgo.com/?${params}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForSelector('[data-testid="result-title-a"], .no-results, [data-testid="no-results"]', { timeout: 9000 }).catch(() => {});
      if (n > 10) { await page.click('#more-results').catch(() => {}); await sleep(900); }
      const results = await page.evaluate((max) => [...document.querySelectorAll('article[data-testid="result"]')].slice(0, max).map((a) => {
        const t = a.querySelector('[data-testid="result-title-a"]');
        const lines = a.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
        const title = (t?.innerText ?? '').trim();
        const body = lines.slice(lines.findIndex((l) => l === title) + 1).join(' ');
        const date = /^([A-Z][a-z]{2} \d{1,2}, \d{4}|\d+ (minutes?|hours?|days?|weeks?|months?) ago)/.exec(body)?.[1] ?? null;
        return { title, url: t?.href ?? '', site: lines[0] ?? '', snippet: (date ? body.slice(date.length) : body).replace(/^[\s—-]+/, '').slice(0, 400), date };
      }), n);
      const blocked = !results.length && await page.evaluate(() => /unusual|captcha|anomaly|bot/i.test(document.body.innerText.slice(0, 1500))).catch(() => false);
      return { engine: 'duckduckgo', results: results.filter((r) => { try { checkUrl(r.url); return !/duckduckgo\.com/.test(r.url); } catch { return false; } }), ...(blocked ? { blocked: true } : {}) };
    });
  }

  #google(q, n, recent) {
    const params = new URLSearchParams({ q, hl: 'en', num: String(n) });
    if (RECENT[recent]) params.set('tbs', RECENT[recent]);
    return this.#page(async (page, ctx) => {
      await page.goto(`https://www.google.com/search?${params}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      const raw = await page.evaluate(() => {
        const txt = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim();
        if (/unusual traffic|not a robot|recaptcha/i.test(document.body.innerText.slice(0, 3000)) || location.pathname.startsWith('/sorry')) return { blocked: true };
        const out = []; const seen = new Set();
        for (const h of document.querySelectorAll('a h3')) {
          const a = h.closest('a'); if (!a || seen.has(a.href)) continue; seen.add(a.href);
          let blk = a; for (let i = 0; i < 8 && blk.parentElement; i++) { blk = blk.parentElement; if (txt(blk).length > 160) break; }
          const title = txt(h); const site = txt(blk.querySelector('span.VuuXrf'));
          const cite = txt(blk.querySelector('cite'));
          const snippet = txt(blk).replace(title, '').replace(site, '').replace(cite, '').replace(/Read more$/, '').trim();
          out.push({ title, href: a.href, site, cite, snippet: snippet.slice(0, 400) });
          if (out.length >= 20) break;
        }
        return { results: out };
      });
      if (raw.blocked) { this.blockedUntil = Date.now() + 20 * 60_000; return { engine: 'google', results: [], blocked: true }; }
      const results = [];
      for (const r of raw.results) { // sequential: the first redirects answer at once, then Google stalls them
        let url = r.href;
        if (/^https:\/\/www\.google\.[^/]+\/(goto|url)\?/.test(url)) {
          try { const res = await ctx.request.get(url, { maxRedirects: 0, timeout: 6000 }); url = res.headers().location ?? null; } catch { url = null; }
          if (!url) break;
        }
        try { results.push({ title: r.title, url: checkUrl(url), snippet: r.snippet, site: r.site, date: null }); } catch { /* skip */ }
      }
      return { engine: 'google', results };
    });
  }

  async read({ url, maxChars = 15_000 } = {}) {
    const target = checkUrl(String(url ?? ''));
    return this.#page(async (page) => {
      const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      // JS apps (X, LinkedIn, Reddit) fill in after load: wait briefly for real text.
      for (let i = 0; i < 12; i++) { const n = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0); if (n > 1500) break; await sleep(250); }
      const r = await page.evaluate((max) => {
        const meta = (sel) => document.querySelector(sel)?.getAttribute('content') ?? null;
        const main = document.querySelector('article, main, [role="main"]');
        const pick = main && main.innerText.length > 400 ? main : document.body;
        const text = (pick?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
        const published = meta('meta[property="article:published_time"]') ?? meta('meta[name="date"]') ?? meta('meta[itemprop="datePublished"]') ?? document.querySelector('time[datetime]')?.getAttribute('datetime') ?? null;
        const desc = meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
        return { title: document.title, text: text.slice(0, max), length: text.length, published, description: desc, loginWall: /sign in to (view|see)|log in to (see|continue)|join (linkedin|now) to/i.test(text.slice(0, 2000)) };
      }, Math.min(Math.max(Number(maxChars) || 15_000, 1000), 40_000));
      return { url: page.url(), status: resp?.status() ?? null, ...r, truncated: r.length > r.text.length };
    });
  }

  // He signs in to LinkedIn / X once in THIS profile (a visible window; Friday never types passwords). The window
  // closes itself after 10 minutes; later searches run hidden again with the saved login.
  async login({ site = 'linkedin' } = {}) {
    const url = { linkedin: 'https://www.linkedin.com/login', x: 'https://x.com/i/flow/login', reddit: 'https://www.reddit.com/login' }[site];
    if (!url) throw new Error('site must be linkedin, x or reddit');
    await this.close();
    const headless = this.headless; this.headless = false;
    try { const ctx = await this.#context(); const p = await ctx.newPage(); await p.goto(url, { waitUntil: 'domcontentloaded' }); }
    finally { this.headless = headless; }
    clearTimeout(this.idle); this.idle = setTimeout(() => this.close(), 10 * 60_000); this.idle.unref?.();
    return { opened: url, note: 'A Chrome window is open on his screen: he signs in there himself; it closes by itself in 10 minutes.' };
  }

  async close() { clearTimeout(this.idle); const c = this.ctx; this.ctx = null; await c?.close().catch(() => {}); }
}
