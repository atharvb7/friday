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

// Expand any IPv6 text form (incl. ::, embedded dotted v4) into 16 bytes, or null.
function ipv6Bytes(ip) {
  let v = ip.toLowerCase().split('%')[0];
  const m4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (m4) { const q = m4[1].split('.').map(Number); if (q.some((n) => n > 255)) return null; v = v.slice(0, -m4[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16); }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

function privateV4(a, b, c) {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

// Only global unicast is allowed; IPv4-in-IPv6 encodings are unwrapped and judged as IPv4.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) { const [a, b, c] = ip.split('.').map(Number); return privateV4(a, b, c); }
  if (!net.isIPv6(ip)) return true;
  const by = ipv6Bytes(ip);
  if (!by) return true;
  const zeros = (from, to) => by.subarray(from, to).every((x) => x === 0);
  if (zeros(0, 10) && by[10] === 0xff && by[11] === 0xff) return privateV4(by[12], by[13], by[14]); // ::ffff:a.b.c.d (any textual form)
  if (zeros(0, 12)) return true;                                                                       // ::, ::1, deprecated IPv4-compatible
  if (by[0] === 0x00 && by[1] === 0x64 && by[2] === 0xff && by[3] === 0x9b && zeros(4, 12)) return privateV4(by[12], by[13], by[14]); // NAT64
  if (by[0] === 0x20 && by[1] === 0x02) return privateV4(by[2], by[3], by[4]);                         // 6to4
  if (by[0] === 0x20 && by[1] === 0x01 && by[2] === 0x00 && by[3] === 0x00) return true;              // Teredo
  if (by[0] === 0x20 && by[1] === 0x01 && by[2] === 0x0d && by[3] === 0xb8) return true;              // documentation
  return (by[0] & 0xe0) !== 0x20;                                                                      // outside 2000::/3 (ULA, link-local, site-local, multicast...)
}

// Linear-time HTML -> text (no backtracking regexes on attacker input). Input is capped first.
export function htmlToText(html) {
  const src = String(html).slice(0, 400_000);
  const lower = src.toLowerCase();
  let out = ''; let i = 0;
  const SKIP = ['script', 'style', 'noscript', 'svg', 'template'];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out += src.slice(i); break; }
    out += src.slice(i, lt);
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? src.length : e + 3; out += ' '; continue; }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) { i = src.length; break; }
    const m = /^<\/?([a-z][a-z0-9]*)/.exec(lower.slice(lt, Math.min(gt, lt + 40)));
    const name = m?.[1] ?? '';
    const closing = src[lt + 1] === '/';
    if (!closing && SKIP.includes(name)) { const e = lower.indexOf(`</${name}`, gt); i = e < 0 ? src.length : (lower.indexOf('>', e) < 0 ? src.length : lower.indexOf('>', e) + 1); out += ' '; continue; }
    if (closing && ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(name)) out += '\n\n';
    else if (name === 'br' || (closing && ['li', 'tr'].includes(name))) out += '\n';
    else out += ' ';
    i = gt + 1;
  }
  return out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
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
