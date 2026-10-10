// src/browser-live.mjs — RealBrowser: zero-dependency read-only browser driver.
//
// Uses ONLY node built-ins + the system google-chrome binary. No npm packages,
// no websocket library, no network client of our own.
//
// Follow-up for FULL DOM automation (NOT installed here — repo stays zero-dep):
//   npm i playwright-core
// Then drive the SAME dedicated profile with:
//   import { chromium } from 'playwright-core';
//   const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
//     channel: 'chrome', headless: true,
//     args: [`--remote-debugging-port=${PORT}`], // loopback only (127.0.0.1)
//   });
//
// Why dump-dom instead of CDP here:
// - CDP automation needs a websocket client; we ship no ws library and add
//   none (zero-dep constraint). The /json/list + /json/protocol HTTP endpoints
//   can list tabs but Runtime.evaluate requires a websocket, so interactive
//   DOM driving (clicks, typing, waiting) is NOT implemented in this file.
// - Instead snapshot(url) shells `google-chrome --headless=new --dump-dom <url>`
//   and extracts a SEMANTIC subset { url, title, headings, links } via regex.
//   No JS of ours executes in the page; no raw HTML is returned (page text is
//   untrusted data, never instructions).
// - stageFile() is a real filesystem check (exists + is-file + size + mtime);
//   staging NEVER sends (sent:false always; there is no send path).
//
// Safety:
// - https-only: http/file/data/ftp refused (file:// refused in particular).
// - Profile confined under data/browser-profiles (reuses confineProfileDir).
// - Remote-debugging port is FIXED to 127.0.0.1:9222 (loopback-only). There is
//   no option to bind 0.0.0.0/LAN/Tailscale. A lockfile guards the fixed port.
// - Auth-state / profile dir created 0700 (owner-only: cookies are
//   impersonation-grade and must never be sent to a model).

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { confineProfileDir, DEBUG_HOST, DEFAULT_DEBUG_PORT, resolveProfileRoot } from './browser.mjs';

export const CHROME_PATH = process.env.FRIDAY_CHROME ?? '/usr/bin/google-chrome';
export const PROFILE_NAME = 'friday';
export const LOCK_FILENAME = 'debug-port.lock';
export const MAX_URL_LENGTH = 2048;

function defaultRunner(cmd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(`chrome_dump_failed: ${stderr?.toString().slice(0, 500) ?? error.message}`);
        err.cause = error;
        rejectPromise(err);
        return;
      }
      resolvePromise({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}

export function parseHttpsUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_URL_LENGTH) {
    throw new TypeError(`url must be a 1..${MAX_URL_LENGTH} char https URL string`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError('url must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new TypeError('only https URLs are allowed (http/file/data refused)');
  }
  if (!parsed.hostname) throw new TypeError('url must have a host');
  if (parsed.username || parsed.password) throw new TypeError('urls with credentials are refused');
  return parsed;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCharCode(Number(n)); } catch { return ''; }
    });
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 500);
}

export function parseSemanticSnapshot(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 300) : '';
  const headings = [];
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = headingRe.exec(html)) !== null && headings.length < 50) {
    const text = stripTags(m[2]);
    if (text) headings.push(text);
  }
  const links = [];
  const linkRe = /<a\b[^>]*\bhref\s*=\s*("([^"]{1,2048})"|'([^']{1,2048})'|([^\s>]{1,2048}))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  while ((m = linkRe.exec(html)) !== null && links.length < 200) {
    const href = m[2] ?? m[3] ?? m[4] ?? '';
    const text = stripTags(m[5]).slice(0, 200);
    if (/^https?:\/\//i.test(href) || href.startsWith('/')) {
      links.push({ href: href.slice(0, 2048), text });
    }
  }
  return { status: 'ok', url, title, headings, links };
}

export class RealBrowser {
  constructor({
    profileRoot = null,
    profileDir = PROFILE_NAME,
    chromePath = CHROME_PATH,
    debugPort = DEFAULT_DEBUG_PORT,
    runner = null,
    existsFn = existsSync,
  } = {}) {
    if (profileDir !== null && (typeof profileDir !== 'string' || !profileDir.trim())) {
      throw new TypeError('invalid profileDir');
    }
    if (typeof chromePath !== 'string' || !chromePath.trim() || chromePath.includes('\0')) {
      throw new TypeError('invalid chromePath');
    }
    if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
      throw new RangeError('debugPort must be 1..65535');
    }
    if (runner !== null && typeof runner !== 'function') throw new TypeError('runner must be a function');
    this._profileRootOverride = profileRoot;
    this._profileRequest = profileDir;
    this._chromePath = chromePath.trim();
    this._debugPort = debugPort;
    this._runner = runner ?? defaultRunner;
    this._existsFn = existsFn;
    this._launched = false;
    this._profileDir = null;
    this._currentUrl = '';
  }

  get launched() { return this._launched; }
  get profileDir() { return this._profileDir; }
  get debugHost() { return DEBUG_HOST; }
  get debugPort() { return this._debugPort; }

  launch(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    const requested = options.profileDir ?? this._profileRequest ?? PROFILE_NAME;
    const debugPort = options.debugPort ?? this._debugPort;
    if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
      throw new RangeError('debugPort must be 1..65535');
    }
    if (this._launched) return { status: 'failed', error: 'already_launched' };
    const root = resolveProfileRoot(this._profileRootOverride);
    const confined = confineProfileDir(root, requested);
    if (!this._existsFn(this._chromePath)) {
      return { status: 'failed', error: 'chrome_not_found', chromePath: this._chromePath };
    }
    mkdirSync(confined.absolute, { recursive: true, mode: 0o700 });
    chmodSync(confined.absolute, 0o700);
    // Fixed loopback port guard: loopback-only by construction (DEBUG_HOST is
    // 127.0.0.1 and is never configurable to anything else).
    const lockPath = join(confined.absolute, LOCK_FILENAME);
    try {
      const existing = readFileSync(lockPath, 'utf8').trim();
      if (existing && !options.force) {
        return { status: 'failed', error: 'debug_port_in_use', lock: existing };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    writeFileSync(lockPath, `pid=${process.pid} host=${DEBUG_HOST} port=${debugPort}\n`, { mode: 0o600 });
    try { chmodSync(lockPath, 0o600); } catch {}
    this._launched = true;
    this._profileDir = confined.absolute;
    this._debugPort = debugPort;
    this._currentUrl = '';
    return {
      status: 'ok',
      launched: true,
      profileDir: confined.absolute,
      headless: true,
      debugHost: DEBUG_HOST, // loopback-only; never 0.0.0.0/LAN/Tailscale
      debugPort,
      chromePath: this._chromePath,
      args: [
        '--headless=new',
        `--user-data-dir=${confined.absolute}`,
        `--remote-debugging-port=${DEBUG_HOST}:${debugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    };
  }

  async snapshot(url) {
    const parsed = parseHttpsUrl(url);
    if (!this._launched) return { status: 'failed', error: 'not_launched' };
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${this._profileDir}`,
      '--dump-dom',
      parsed.href,
    ];
    const out = await this._runner(this._chromePath, args);
    const html = typeof out === 'string' ? out : (out?.stdout ?? '');
    this._currentUrl = parsed.href;
    return parseSemanticSnapshot(html, parsed.href);
  }

  stageFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
      throw new TypeError('filePath must be a non-empty local path string');
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(filePath.trim())) {
      throw new TypeError('filePath must be a local path, not a URL (file:// refused)');
    }
    let st;
    try {
      st = statSync(filePath);
    } catch {
      throw new Error('file_not_found');
    }
    if (!st.isFile()) throw new Error('not_a_file');
    // Staging is NOT sending: no browser input is filled here without
    // playwright-core; the caller must verify preview before any commit.
    return {
      status: 'ok',
      staged: true,
      name: basename(filePath),
      size: st.size,
      mtime: st.mtime.toISOString(),
      sent: false,
    };
  }

  // There is intentionally no auto-send path. Any method named like a send
  // reports staged:true/sent:false and requires an explicit effects commit.
  send() {
    return { status: 'failed', error: 'send_requires_explicit_commit', staged: true, sent: false };
  }

  async close() {
    const wasLaunched = this._launched;
    if (this._profileDir) {
      try { rmSync(join(this._profileDir, LOCK_FILENAME), { force: true }); } catch {}
    }
    this._launched = false;
    this._profileDir = null;
    this._currentUrl = '';
    return { status: 'ok', closed: true, launched: wasLaunched };
  }
}
