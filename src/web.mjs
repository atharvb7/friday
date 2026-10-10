// Web access for the brain: SerpApi search + a hardened page fetcher.
// The fetcher defends against SSRF: it connects only to addresses it has just
// validated (the check runs inside the socket's own DNS lookup, so DNS
// rebinding cannot swap in a private IP), refuses non-http(s), caps redirects,
// size and time, and returns TEXT that callers must treat as untrusted data.
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20_000;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return m ? isPrivateAddress(m[1]) : false;
  }
  return true; // not an IP we understand: refuse
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6])\s*>/gi, '\n\n')
    .replace(/<(br|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function safeFetch(urlStr, { allowPrivate = false, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, redirects = 0, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch { return reject(new TypeError('invalid url')); }
    if (!['http:', 'https:'].includes(url.protocol)) return reject(new TypeError('only http(s) urls are allowed'));
    if (url.username || url.password) return reject(new TypeError('credentials in urls are not allowed'));
    // IP-literal hosts never go through DNS lookup, so check them up front.
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) && !allowPrivate && isPrivateAddress(bare)) return reject(new Error('blocked_address'));
    const mod = url.protocol === 'https:' ? https : http;
    const lookup = (host, opts, cb) => dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
      const bad = !allowPrivate && list.some((a) => isPrivateAddress(a.address));
      if (bad || !list.length) return cb(new Error('blocked_address'));
      if (opts?.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
    const req = mod.request(url, { method: 'GET', lookup, timeout: timeoutMs, headers: { 'User-Agent': 'Friday/1.0 (+personal agent)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('too_many_redirects'));
        return resolve(safeFetch(new URL(res.headers.location, url).toString(), { allowPrivate, maxBytes, timeoutMs, redirects: redirects + 1, headers }));
      }
      const type = String(res.headers['content-type'] ?? '');
      if (!/^(text\/|application\/(json|xml|xhtml|rss|atom))/i.test(type) && type) { res.resume(); return reject(new Error(`unsupported_content_type: ${type.split(';')[0]}`)); }
      const chunks = []; let size = 0; let truncated = false;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { truncated = true; res.destroy(); } else chunks.push(c); });
      const finish = () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ url: url.toString(), status: res.statusCode, contentType: type.split(';')[0], truncated, text: /html/i.test(type) ? htmlToText(raw) : raw });
      };
      res.on('end', finish);
      res.on('close', () => { if (truncated) finish(); });
      res.on('error', () => { if (truncated) finish(); else reject(new Error('read_error')); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(new Error(e.message === 'blocked_address' ? 'blocked_address' : `fetch_failed: ${e.message}`)));
    req.end();
  });
}

const ENGINES = new Set(['google', 'bing', 'youtube', 'google_news', 'google_scholar', 'duckduckgo']);

// SerpApi REST (key stays server-side). Returns compact organic results.
export async function serpSearch({ apiKey, query, engine = 'google', num = 8, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('serpapi_not_configured');
  if (!ENGINES.has(engine)) throw new TypeError(`engine must be one of ${[...ENGINES].join(', ')}`);
  const q = String(query ?? '').trim();
  if (!q || q.length > 300) throw new TypeError('query must be 1-300 chars');
  const params = new URLSearchParams({ engine, api_key: apiKey, num: String(Math.min(Math.max(num, 1), 10)) });
  params.set(engine === 'youtube' ? 'search_query' : engine === 'bing' ? 'q' : 'q', q);
  const res = await fetchImpl(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`serpapi_http_${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`serpapi_error: ${String(j.error).replaceAll(apiKey, '[redacted]').slice(0, 200)}`);
  const pick = (r) => ({ title: r.title, link: r.link, snippet: r.snippet ?? r.description, date: r.date ?? r.published_date ?? null, source: r.source ?? r.displayed_link ?? null });
  const results = (j.organic_results ?? j.news_results ?? j.video_results ?? []).slice(0, 10).map(pick);
  return { engine, query: q, answer: j.answer_box?.answer ?? j.answer_box?.snippet ?? null, results };
}
