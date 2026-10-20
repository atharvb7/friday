#!/usr/bin/env node
// Friday laptop node. Dials OUT to the Friday server (SSE command stream + HTTP
// results), executes browser/desktop commands locally, and tells the server when
// the user is actively using the machine so automation can step aside.
//   friday-node pair --server https://host --token fdv_... [--name laptop]
//   friday-node run
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reelEdit } from './reel-edit.mjs';
import { BrowserController } from './browser.mjs';
import { atspiAvailable, defaultAllowedDirs, idleMs, makeDesktop } from './desktop.mjs';

const CONF_DIR = process.env.FRIDAY_NODE_HOME ?? join(homedir(), '.friday-node');
const CONF = join(CONF_DIR, 'config.json');

const args = process.argv.slice(2);
const cmd = args[0] ?? 'run';
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

function loadConf() { try { return JSON.parse(readFileSync(CONF, 'utf8')); } catch { return null; } }

if (cmd === 'pair') {
  // Prefer FRIDAY_NODE_TOKEN so the token does not appear in `ps` output.
  const server = opt('server'); const token = process.env.FRIDAY_NODE_TOKEN || opt('token');
  if (!server || !token || !/^https?:\/\//.test(server)) { console.error('usage: FRIDAY_NODE_TOKEN=fdv_... friday-node pair --server https://host[:port] [--name laptop]'); process.exit(64); }
  if (server.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(server)) { console.error('Refusing plaintext http to a non-local server; use https (e.g. tailscale serve).'); process.exit(64); }
  mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONF, JSON.stringify({ server: server.replace(/\/+$/, ''), token, name: opt('name') ?? 'laptop', allowedDirs: defaultAllowedDirs(), headless: false }, null, 2), { mode: 0o600 });
  chmodSync(CONF, 0o600);
  console.log(`Paired. Config: ${CONF}\nStart with: node friday-node.mjs run`);
  process.exit(0);
}

const conf = loadConf();
if (!conf) { console.error('Not paired. Run: friday-node pair --server URL --token TOKEN'); process.exit(1); }
const { server, token } = conf;
const allowedDirs = (conf.allowedDirs ?? defaultAllowedDirs());
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const post = (path, body) => fetch(server + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000) });
const log = (...a) => console.log(new Date().toISOString(), ...a);

const { chromium } = await import('playwright-core');
const chromePath = conf.chrome ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => existsSync(p));
const browser = chromePath ? new BrowserController({ chromium, profileDir: join(CONF_DIR, 'chrome-profile'), executablePath: chromePath, headless: conf.headless === true, allowedDirs }) : null;
const desktop = makeDesktop({ allowedDirs });

const handlers = {
  ...(browser ? {
    browser_open: (a) => browser.open(a), browser_snapshot: (a) => browser.snapshot(a), browser_click: (a) => browser.click(a), browser_type: (a) => browser.type(a),
    browser_press: (a) => browser.press(a), browser_upload: (a) => browser.upload(a), browser_scroll: (a) => browser.scroll(a), browser_back: () => browser.back(),
    browser_wait: (a) => browser.wait(a), browser_click_text: (a) => browser.click_text(a), browser_screenshot: (a) => browser.screenshot(a),
    ig_dm_send: (a) => browser.ig_dm_send(a),
    browser_download_folder: (a) => browser.download_folder(a), browser_downloads: (a) => browser.downloads_list(a),
    reel_edit: (a) => reelEdit(a, { downloadsRoot: allowedDirs.find((d) => /\/Downloads$/.test(d)) ?? join(homedir(), 'Downloads') }),
  } : {}),
  file_find: (a) => desktop.file_find(a), open_target: (a) => desktop.open_target(a), open_app: (a) => desktop.open_app(a),
};
if (await atspiAvailable()) Object.assign(handlers, { windows_list: () => desktop.windows_list(), ui_tree: (a) => desktop.ui_tree(a), ui_act: (a) => desktop.ui_act(a), ui_set_text: (a) => desktop.ui_set_text(a) });
const caps = Object.keys(handlers);

async function execute(c) {
  const fn = handlers[c.action];
  let out;
  try { out = { id: c.id, ok: true, result: fn ? await fn(c.args ?? {}) : (() => { throw new Error('unknown_action'); })() }; }
  catch (e) { out = { id: c.id, ok: false, error: String(e.message ?? e).slice(0, 300) }; }
  log(c.action, out.ok ? 'ok' : `error: ${out.error}`);
  try { await post('/v1/node/result', out); } catch (e) { log('result post failed', e.message); }
}

// Tell the server when the human is using the machine (GNOME idle monitor).
setInterval(async () => {
  const idle = await idleMs();
  if (idle !== null && idle < 3000) post('/v1/node/events', { type: 'activity', holdMs: 15_000 }).catch(() => {});
}, 3000).unref();

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopping = true; await browser?.close(); process.exit(0); });

let backoff = 1000;
while (!stopping) {
  try {
    const res = await fetch(`${server}/v1/node/stream`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`stream http ${res.status}`);
    log('connected; capabilities:', caps.join(','));
    await post('/v1/node/hello', { caps, platform: `${process.platform}/${process.env.XDG_SESSION_TYPE ?? '?'}` });
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
