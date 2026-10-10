// src/browser.mjs — Friday dedicated-browser scaffold (Chromium profile owned by Friday).
//
// Browser ownership (design sections 4-5):
// - Friday NEVER attaches to your everyday Chrome. It owns one dedicated,
//   visibly labeled Chromium profile rooted at data/browser-profiles, so the
//   launch flags and profile lifecycle stay deterministic, crashes and site
//   state stay reproducible, and revocation is just deleting a directory.
// - profileDir inputs are confined inside that root (prefix guard plus a
//   realpath walk-up, mirroring src/tools.mjs). Anything outside — including
//   `~/.config/google-chrome` or another browser's profile — is refused.
// - Headless defaults to true. Run headed only for explicit local debugging.
// - The remote-debugging/CDP endpoint binds to 127.0.0.1 ONLY (see DEBUG_HOST).
//   Never expose it on 0.0.0.0, LAN, or Tailscale. Tailscale Serve fronts the
//   Friday web UI, never the browser debugger.
//
// Desktop ladder position: prefer this semantic browser driver (roles, labels,
// file inputs via setInputFiles-style staging) over screenshots, and screenshots
// over raw coordinates. snapshot() therefore returns a semantic subset only —
// { url, title, headings, links } — never a raw HTML dump. Page text is
// untrusted data, never instructions, and browser authentication-state files
// (impersonation-grade cookies/headers) must stay owner-only and must never be
// sent to a model.
//
// WhatsApp / personal-account caution: WhatsApp's consumer terms restrict
// automated access and auto-messaging. Driving WhatsApp Web in this profile is
// user-directed UI assistance only — no bulk or unsolicited messaging — and can
// break at any time through account or UI changes. The officially supported
// automation route for eligible business use is the WhatsApp Business API, not
// this personal-account profile. Staging an attachment is NOT sending: any send
// is a separate, explicitly approved commit step (stage -> verify -> approve ->
// commit -> verify).
//
// Playwright is loaded lazily: this module never imports it at top level, so
// importing this file never throws when Playwright is not installed. Every
// method that needs Playwright returns
// { status: 'failed', error: 'playwright_not_installed' } instead. No method
// performs network I/O itself; goto() only records the validated target URL in
// this scaffold (the Phase-0 spike wires the real navigation).

import { realpathSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loopback-only bind for any browser debugging endpoint. There is deliberately
// no option to override this host.
export const DEBUG_HOST = '127.0.0.1';
export const DEFAULT_DEBUG_PORT = 9222;

export const MAX_URL_LENGTH = 2048;
export const MAX_PROFILE_PATH_LENGTH = 4096;
export const MAX_NAME_LENGTH = 255;

export const PLAYWRIGHT_MISSING_ERROR = 'playwright_not_installed';
export const NOT_LAUNCHED_ERROR = 'not_launched';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILE_ROOT = resolve(HERE, '..', 'data', 'browser-profiles');

function anchorReal(absolute) {
  // Resolve the nearest existing ancestor and re-attach the missing tail, so
  // symlink escapes are judged on real paths even for not-yet-created profiles.
  let current = absolute;
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? normalize(join(real, ...tail)) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export function resolveProfileRoot(override) {
  const raw = override ?? process.env.FRIDAY_BROWSER_PROFILES ?? DEFAULT_PROFILE_ROOT;
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new TypeError('invalid browser profile root');
  }
  return anchorReal(resolve(raw.trim()));
}

export function confineProfileDir(profileRootReal, requested) {
  if (typeof profileRootReal !== 'string' || !profileRootReal || profileRootReal.includes('\0')) {
    throw new TypeError('invalid profile root');
  }
  if (
    typeof requested !== 'string' ||
    requested.length < 1 ||
    requested.length > MAX_PROFILE_PATH_LENGTH ||
    requested.includes('\0')
  ) {
    throw new TypeError('profileDir must be a non-empty path string');
  }
  // resolve() anchors relative paths at the root; absolute paths must still
  // land inside it. Traversal (`..`) that escapes the root is rejected below.
  const resolved = resolve(profileRootReal, requested);
  const anchored = anchorReal(resolved);
  if (anchored !== profileRootReal && anchored.startsWith(profileRootReal + sep)) {
    return { absolute: anchored, relative: relative(profileRootReal, anchored) || '.' };
  }
  if (anchored === profileRootReal) {
    // The container itself is not a launchable profile.
    throw new TypeError('profileDir must be a profile inside the browser-profiles root');
  }
  throw new TypeError('profileDir escapes browser profiles root');
}

function parseHttpsUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_URL_LENGTH) {
    throw new TypeError(`url must be a 1..${MAX_URL_LENGTH} char https URL string`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError('url must be a valid URL');
  }
  // https-only allowlist: http, file, data, and every other scheme are refused.
  if (parsed.protocol !== 'https:') {
    throw new TypeError('only https URLs are allowed (http/file/data refused)');
  }
  if (!parsed.hostname) throw new TypeError('url must have a host');
  if (parsed.username || parsed.password) throw new TypeError('urls with credentials are refused');
  if (allowedHosts !== null && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new TypeError(`host not allowlisted: ${parsed.hostname}`);
  }
  return parsed;
}

function missingPlaywright() {
  return { status: 'failed', error: PLAYWRIGHT_MISSING_ERROR };
}

export class BrowserDriver {
  constructor(
    { profileRoot = null, playwright = undefined, playwrightLoader = null, allowedHosts = null, debugPort = DEFAULT_DEBUG_PORT } = {},
  ) {
    if (profileRoot !== null && (typeof profileRoot !== 'string' || !profileRoot.trim() || profileRoot.includes('\0'))) {
      throw new TypeError('invalid profileRoot');
    }
    if (playwrightLoader !== null && typeof playwrightLoader !== 'function') {
      throw new TypeError('playwrightLoader must be a function');
    }
    if (allowedHosts !== null) {
      if (!Array.isArray(allowedHosts)) throw new TypeError('allowedHosts must be an array of hostnames or null');
      if (allowedHosts.length < 1) throw new TypeError('allowedHosts must not be empty');
      allowedHosts = allowedHosts.map((host) => {
        if (typeof host !== 'string' || !host.trim()) throw new TypeError('invalid allowed host');
        return host.trim().toLowerCase();
      });
    }
    if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
      throw new RangeError('debugPort must be 1..65535');
    }
    // playwright: undefined = lazy-import at call time; null = forced missing
    // (tests); any other value = injected stub/real module, never imported.
    this._profileRootOverride = profileRoot;
    this._playwrightOverride = playwright;
    this._playwrightLoader = playwrightLoader;
    this._allowedHosts = allowedHosts;
    this._defaultDebugPort = debugPort;
    this._launched = false;
    this._profileDir = null;
    this._headless = true;
    this._debugPort = debugPort;
    this._currentUrl = '';
  }

  get launched() {
    return this._launched;
  }

  get profileDir() {
    return this._profileDir;
  }

  get currentUrl() {
    return this._currentUrl;
  }

  async _loadPlaywright() {
    if (this._playwrightOverride !== undefined) return this._playwrightOverride;
    if (this._playwrightLoader) {
      try {
        return await this._playwrightLoader();
      } catch {
        return null;
      }
    }
    try {
      return await import('playwright');
    } catch {
      return null;
    }
  }

  async launch(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    const { profileDir, headless = true, debugPort = this._defaultDebugPort } = options;
    const root = resolveProfileRoot(this._profileRootOverride);
    const confined = confineProfileDir(root, profileDir);
    if (typeof headless !== 'boolean') throw new TypeError('headless must be a boolean (default true)');
    if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
      throw new RangeError('debugPort must be 1..65535');
    }
    if (this._launched) return { status: 'failed', error: 'already_launched' };
    const playwright = await this._loadPlaywright();
    if (!playwright) return missingPlaywright();
    // Scaffold: record launch intent only. The Phase-0 spike wires real
    // persistent-context creation here, with the debugging port bound to
    // DEBUG_HOST (127.0.0.1) — never 0.0.0.0, LAN, or Tailscale.
    this._launched = true;
    this._profileDir = confined.absolute;
    this._headless = headless;
    this._debugPort = debugPort;
    this._currentUrl = '';
    return {
      status: 'ok',
      launched: true,
      profileDir: confined.absolute,
      headless,
      debugHost: DEBUG_HOST,
      debugPort,
    };
  }

  async goto(urlOrOptions) {
    const url =
      urlOrOptions && typeof urlOrOptions === 'object' && !Array.isArray(urlOrOptions)
        ? urlOrOptions.url
        : urlOrOptions;
    const parsed = parseHttpsUrl(url, this._allowedHosts);
    const playwright = await this._loadPlaywright();
    if (!playwright) return missingPlaywright();
    if (!this._launched) return { status: 'failed', error: NOT_LAUNCHED_ERROR };
    // Scaffold: no network fetch here — record the validated navigation target.
    this._currentUrl = parsed.href;
    return { status: 'ok', url: parsed.href };
  }

  async snapshot() {
    const playwright = await this._loadPlaywright();
    if (!playwright) return missingPlaywright();
    if (!this._launched) return { status: 'failed', error: NOT_LAUNCHED_ERROR };
    // Semantic snapshot only: url, title, headings, links. Never raw HTML.
    return { status: 'ok', url: this._currentUrl, title: '', headings: [], links: [] };
  }

  async stageFile(input) {
    let filePath = null;
    let name = null;
    let size = null;
    if (typeof input === 'string') {
      filePath = input;
    } else if (input && typeof input === 'object' && !Array.isArray(input)) {
      ({ filePath = null, name = null, size = null } = input);
    } else {
      throw new TypeError('stageFile expects a file path string or { filePath?, name?, size? }');
    }
    if (filePath !== null) {
      if (
        typeof filePath !== 'string' ||
        !filePath.trim() ||
        filePath.length > MAX_PROFILE_PATH_LENGTH ||
        filePath.includes('\0')
      ) {
        throw new TypeError('invalid filePath');
      }
      // A URL is not a local file: staging resolves a file input, never a
      // remote resource.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(filePath.trim())) {
        throw new TypeError('filePath must be a local path, not a URL');
      }
    }
    if (name !== null) {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > MAX_NAME_LENGTH ||
        name.includes('\0') ||
        name.includes('/') ||
        name.includes('\\')
      ) {
        throw new TypeError('invalid name');
      }
    }
    if (size !== null) {
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative integer');
    }
    if (filePath === null && name === null) throw new TypeError('filePath or name required');
    // Selectorless resolution stub: the real driver fills the page's file
    // input directly (no native picker); here we only resolve the name.
    const resolvedName = name ?? basename(filePath);
    if (!resolvedName) throw new TypeError('could not resolve file name');
    const playwright = await this._loadPlaywright();
    if (!playwright) return missingPlaywright();
    if (!this._launched) return { status: 'failed', error: NOT_LAUNCHED_ERROR };
    // Staging is explicitly NOT sending: sent:false always. The send/commit is
    // a separate, explicitly approved step after verification.
    return { status: 'ok', staged: true, name: resolvedName, size: size ?? 0, sent: false };
  }

  async close() {
    // Idempotent by design: closing a never-launched driver succeeds and never
    // needs Playwright, so recovery paths can always call it.
    const wasLaunched = this._launched;
    this._launched = false;
    this._profileDir = null;
    this._currentUrl = '';
    return { status: 'ok', closed: true, launched: wasLaunched };
  }
}
