// Where research gets its raw material. Measured from the server and the laptop on 3 Nov 2026:
//   search   the laptop's hidden Chrome (node/research-browser.mjs: DuckDuckGo, Google fallback) gives real results
//            incl. LinkedIn people/company pages, X posts and Reddit threads, free. From the server, Bing/DDG scraping
//            returned junk or captchas, and SerpApi is a 250/month free plan: it is only a rationed fallback.
//   read     normal pages: the server's hardened fetch. JS apps (X, LinkedIn, Instagram...) or pages that come back
//            nearly empty: the laptop's hidden Chrome. X posts also via X's public embed API. PDFs and anything else
//            the server cannot render: Jina Reader (r.jina.ai, sees only the URL).
//   APIs     Hacker News (Algolia), GitHub, arXiv, OpenAlex, Wikipedia: free, structured, no key.
import { safeFetch, serpSearch, countryForTimezone } from '../web.mjs';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const JS_SITES = /(^|\.)(x\.com|twitter\.com|linkedin\.com|instagram\.com|facebook\.com|threads\.net|tiktok\.com|crunchbase\.com|glassdoor\.[a-z.]+|quora\.com|medium\.com)$/i;
const SNIPPET_ONLY = /(^|\.)reddit\.com$/i; // bot wall from the server and from a hidden browser alike
const SERP_MONTHLY = 200;

export function normalizeUrl(u) {
  try {
    const x = new URL(u); x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src|s$|t$|si$|igsh|mc_)/i.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.replace(/^(www\.|m\.|mobile\.)/, '').replace(/^twitter\.com$/, 'x.com').replace(/^[a-z]{2}\.linkedin\.com$/, 'linkedin.com');
    return x.toString().replace(/\/$/, '');
  } catch { return null; }
}
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^(www\.|m\.|[a-z]{2}\.)(?=linkedin\.com)|^www\./, ''); } catch { return ''; } };

export class Sources {
  constructor({ nodes = null, env = process.env, settings = null, fetchImpl = globalThis.fetch, fetchPage = safeFetch, now = () => Date.now() } = {}) {
    Object.assign(this, { nodes, env, settings, fetchImpl, fetchPage, now });
    this.stats = { laptop: 0, serp: 0, fail: 0 };
  }

  // Which browser searches: the SERVER browser container first (works with the laptop off), else his laptop's hidden
  // Chrome. -> 'server' | 'laptop' | null
  where() {
    if (this.nodes?.server?.('research_search')) return 'server';
    const n = this.nodes?.online && this.nodes.list?.()[0];
    return n?.caps?.includes('research_search') ? 'laptop' : null;
  }
  laptopReady() { return this.where() !== null; } // "a browser can search" (name kept for callers)

  // SerpApi is shared with prospecting and has 250 searches a month: research takes at most SERP_MONTHLY minus a reserve.
  #serpAllowed() {
    if (!this.env.SERPAPI_API_KEY) return false;
    if (!this.settings) return true;
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const b = this.settings.get('research_serp_budget', { month, used: 0 });
    return (b.month === month ? b.used : 0) < Number(this.env.FRIDAY_RESEARCH_SERP_MONTHLY ?? SERP_MONTHLY) / 2;
  }
  #serpUsed() {
    if (!this.settings) return;
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const b = this.settings.get('research_serp_budget', { month, used: 0 });
    this.settings.set('research_serp_budget', { month, used: (b.month === month ? b.used : 0) + 1 });
  }

  // -> { engine, results: [{ title, url, snippet, site, date }] }
  async search(query, { site = null, recent = null, num = 10, engine = 'web' } = {}) {
    const q = clip(query, 380);
    if (!q) return { engine: 'none', results: [] };
    if (engine === 'web' && this.laptopReady()) {
      try {
        const where = this.where();
        const r = await this.nodes.dispatch({ action: 'research_search', args: { query: q, site, recent, num }, timeoutMs: 45_000, where });
        if (r.results?.length) { this.stats.laptop++; return { engine: `${where}:${r.engine}`, results: r.results }; }
      } catch { /* fall through */ }
    }
    if (this.#serpAllowed()) {
      try {
        const serpEngine = engine === 'news' ? 'google_news' : engine === 'scholar' ? 'google_scholar' : engine === 'youtube' ? 'youtube' : 'google';
        const fullQ = site && !/\bsite:/.test(q) ? `${q} site:${site}` : q;
        const tz = this.settings?.get('timezone', null) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const r = await serpSearch({ apiKey: this.env.SERPAPI_API_KEY, query: fullQ, engine: serpEngine, num, country: countryForTimezone(tz), fetchImpl: this.fetchImpl });
        this.#serpUsed(); this.stats.serp++;
        return { engine: `serpapi:${serpEngine}`, answer: r.answer ?? r.ai_overview ?? null, results: r.results.map((x) => ({ title: x.title, url: x.link, snippet: x.snippet ?? '', site: x.source ?? '', date: x.date ?? null })) };
      } catch { /* fall through */ }
    }
    this.stats.fail++;
    return { engine: 'none', results: [], note: this.where() ? 'search failed' : 'no search backend: the server browser and his laptop are both unavailable and the SerpApi research budget is used up' };
  }

  // Free structured sources -> same shape as search results.
  async api(kind, query) {
    const q = encodeURIComponent(clip(query, 200));
    const j = async (url) => { const r = await this.fetchImpl(url, { headers: { 'User-Agent': 'Fridayy-research/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }); if (!r.ok) throw new Error(`http_${r.status}`); return r.json(); };
    try {
      if (kind === 'hn') return (await j(`https://hn.algolia.com/api/v1/search?query=${q}&hitsPerPage=8&tags=(story,comment)`)).hits.map((h) => ({ title: h.title ?? clip(h.comment_text, 90), url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`, snippet: clip(h.story_text ?? h.comment_text ?? `${h.points ?? 0} points, ${h.num_comments ?? 0} comments on HN`, 300), site: 'Hacker News', date: h.created_at?.slice(0, 10) ?? null }));
      if (kind === 'github') return (await j(`https://api.github.com/search/repositories?q=${q}&per_page=8&sort=stars`)).items.map((r) => ({ title: r.full_name, url: r.html_url, snippet: clip(`${r.description ?? ''} · ★${r.stargazers_count} · ${r.language ?? ''} · updated ${r.pushed_at?.slice(0, 10)}`, 300), site: 'GitHub', date: r.pushed_at?.slice(0, 10) ?? null }));
      if (kind === 'openalex') return (await j(`https://api.openalex.org/works?search=${q}&per-page=8&sort=relevance_score:desc`)).results.map((w) => ({ title: w.title, url: w.doi ?? w.id, snippet: clip(`${w.publication_year} · cited ${w.cited_by_count} · ${(w.authorships ?? []).slice(0, 3).map((a) => a.author?.display_name).join(', ')}`, 300), site: w.primary_location?.source?.display_name ?? 'OpenAlex', date: w.publication_date ?? null }));
      if (kind === 'wikipedia') return (await j(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${q}&limit=5`)).pages.map((p) => ({ title: p.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`, snippet: clip(String(p.excerpt ?? '').replace(/<[^>]+>/g, ''), 300), site: 'Wikipedia', date: null }));
      if (kind === 'arxiv') {
        const r = await this.fetchImpl(`https://export.arxiv.org/api/query?search_query=all:${q}&max_results=8&sortBy=relevance`, { signal: AbortSignal.timeout(15_000) });
        const xml = await r.text();
        return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
          const g = (t) => (new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(m[1])?.[1] ?? '').trim();
          return { title: clip(g('title'), 200), url: g('id'), snippet: clip(g('summary'), 300), site: 'arXiv', date: g('published').slice(0, 10) || null };
        });
      }
    } catch { /* an API being down never fails research */ }
    return [];
  }

  // -> { url, title, text, published, via } ; text is untrusted page content.
  async read(url, { maxChars = 14_000 } = {}) {
    const host = hostOf(url);
    if (SNIPPET_ONLY.test(host)) return { url, title: '', text: '', via: 'snippet_only', error: 'reddit blocks automated reading; use the search snippet' };
    const tweet = /^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/(\d+)/.exec(url);
    if (tweet) {
      try {
        const r = await this.fetchImpl(`https://cdn.syndication.twimg.com/tweet-result?id=${tweet[3]}&token=a&lang=en`, { signal: AbortSignal.timeout(12_000) });
        if (r.ok) { const t = await r.json(); if (t.text) return { url, title: `${t.user?.name ?? ''} (@${t.user?.screen_name ?? ''}) on X`, text: clip(`${t.text}${t.quoted_tweet?.text ? `\nQuoting @${t.quoted_tweet.user?.screen_name}: ${t.quoted_tweet.text}` : ''}\n${t.favorite_count ?? 0} likes · ${t.conversation_count ?? 0} replies`, maxChars), published: t.created_at ? new Date(t.created_at).toISOString().slice(0, 10) : null, via: 'x_embed' }; }
      } catch { /* try the browser */ }
    }
    const viaLaptop = async () => {
      const where = this.where();
      const r = await this.nodes.dispatch({ action: 'research_read', args: { url, maxChars }, timeoutMs: 60_000, where });
      // Behind a login wall LinkedIn still serves its preview description (headline, company, education, location).
      const text = String(r.text ?? '').length < 800 && r.description ? `${r.title ?? ''}\n${r.description}\n${r.text ?? ''}` : r.text;
      return { url: r.url ?? url, title: r.title ?? '', text: clip(text, maxChars), published: r.published ?? null, via: where === 'server' ? 'server_browser' : 'laptop', ...(r.loginWall ? { loginWall: true } : {}), ...(r.description ? { preview: true } : {}) };
    };
    const viaJina = async () => {
      const r = await this.fetchPage(`https://r.jina.ai/${url}`, { timeoutMs: 25_000 });
      return { url, title: /^Title: (.*)$/m.exec(r.text)?.[1] ?? '', text: clip(r.text.replace(/^(Title|URL Source|Published Time):.*$/gm, ''), maxChars), published: /^Published Time: (.*)$/m.exec(r.text)?.[1]?.slice(0, 10) ?? null, via: 'jina' };
    };
    if (JS_SITES.test(host) && this.laptopReady()) { try { const r = await viaLaptop(); if (r.text.length > 300 || r.preview) return r; } catch { /* next */ } }
    let server = null;
    try {
      const r = await this.fetchPage(url, { timeoutMs: 15_000 });
      const meta = (n) => (r.html ? new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]+content=["']([^"']+)`, 'i').exec(r.html)?.[1] ?? null : null);
      server = { url: r.url, title: r.html ? clip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.html)?.[1], 200) : '', text: clip(r.text, maxChars), published: meta('article:published_time') ?? meta('datePublished') ?? meta('date'), description: meta('description') ?? meta('og:description'), via: 'server', status: r.status };
      if (r.status < 400 && server.text.length > 800) return server;
    } catch { /* blocked, PDF, timeout */ }
    if (this.laptopReady() && !JS_SITES.test(host)) { try { const r = await viaLaptop(); if (r.text.length > 500) return r; } catch { /* next */ } }
    try { const r = await viaJina(); if (r.text.length > 300) return r; } catch { /* next */ }
    return server ?? { url, title: '', text: '', via: 'failed', error: 'could not read this page' };
  }
}
