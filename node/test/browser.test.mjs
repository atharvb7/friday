import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserController, checkUrl, checkFile, isPrivateHost } from '../browser.mjs';

const CHROME = '/usr/bin/google-chrome';

test('url + file policy: private hosts, schemes, allowed dirs, dotfiles, symlink escape', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '[::1]', 'router.local']) assert.equal(isPrivateHost(h), true, h);
  assert.equal(isPrivateHost('example.com'), false);
  assert.throws(() => checkUrl('file:///etc/passwd'), /only_http_urls/);
  assert.throws(() => checkUrl('http://localhost:8080'), /private_address_blocked/);
  assert.equal(checkUrl('https://example.com/a'), 'https://example.com/a');
  const d = mkdtempSync(join(tmpdir(), 'fn-files-'));
  try {
    const allowed = join(d, 'Downloads'); mkdirSync(allowed); mkdirSync(join(allowed, '.secret'));
    writeFileSync(join(allowed, 'ok.pdf'), 'x'); writeFileSync(join(allowed, '.secret', 'k'), 'x'); writeFileSync(join(d, 'outside.txt'), 'x');
    symlinkSync(join(d, 'outside.txt'), join(allowed, 'link.txt'));
    assert.ok(checkFile(join(allowed, 'ok.pdf'), [allowed]).endsWith('ok.pdf'));
    assert.throws(() => checkFile(join(d, 'outside.txt'), [allowed]), /path_not_allowed/);
    assert.throws(() => checkFile(join(allowed, 'link.txt'), [allowed]), /path_not_allowed/);
    assert.throws(() => checkFile(join(allowed, '.secret', 'k'), [allowed]), /hidden_path_blocked/);
    assert.throws(() => checkFile(allowed, [allowed]), /not_a_file/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('real Chrome: snapshot -> click/type/upload by ref, screenshot, private url blocked', { skip: !existsSync(CHROME) }, async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><title>Form</title><body><h1>Hello</h1><input id=e placeholder="Email"><input type=file id=f style="display:none"><button onclick="document.getElementById('o').textContent='clicked:'+document.getElementById('e').value">Go</button><a href="/x">Other</a><div id=o></div></body></html>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'fn-br-'));
  const dl = join(dir, 'Downloads'); mkdirSync(dl); writeFileSync(join(dl, 'a.txt'), 'hi');
  const b = new BrowserController({ chromium, profileDir: join(dir, 'profile'), headless: true, allowedDirs: [dl], allowPrivate: true });
  try {
    await assert.rejects(() => b.open({ url: `http://127.0.0.1:${srv.address().port}/` }), /private_address_blocked/);
    // test-only: bypass host policy by pointing the page at the local server directly
    const page = await b.ensure();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const snap = await b.snapshot();
    assert.equal(snap.title, 'Form');
    assert.deepEqual(snap.headings, [{ level: 'h1', text: 'Hello' }]);
    assert.match(snap.text, /Hello/);
    const email = snap.elements.find((e) => e.name === 'Email');
    const go = snap.elements.find((e) => e.name === 'Go');
    const file = snap.elements.find((e) => e.type === 'file');
    assert.ok(email && go && file && file.hidden, 'hidden file input is listed');
    await b.type({ ref: email.ref, text: 'a@b.co' });
    await b.click({ ref: go.ref });
    assert.match((await b.snapshot()).text, /clicked:a@b\.co/);
    const snap2 = await b.snapshot();
    const f2 = snap2.elements.find((e) => e.type === 'file');
    assert.deepEqual(await b.upload({ ref: f2.ref, path: join(dl, 'a.txt') }), { uploaded: 'a.txt' });
    await assert.rejects(() => b.upload({ ref: f2.ref, path: join(dir, 'profile', 'Default', 'Cookies') }), /path_not_allowed|ENOENT/);
    const shot = await b.screenshot();
    assert.equal(shot.mime, 'image/jpeg'); assert.ok(shot.base64.length > 500);
    await assert.rejects(() => b.click({ ref: 9999 }), /stale_ref/);
    await assert.rejects(() => b.click({ ref: 'x' }), /invalid_ref/);
  } finally { await b.close(); srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real Chrome: private/loopback targets are blocked at the request level (incl. IPv6-mapped and redirects)', { skip: !existsSync(CHROME) }, async () => {
  const internal = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('INTERNAL-SECRET'); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  const port = internal.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'fn-br2-'));
  const b = new BrowserController({ chromium, profileDir: join(dir, 'profile'), headless: true, allowedDirs: [] });
  try {
    const page = await b.ensure();
    for (const url of [`http://127.0.0.1:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://localhost:${port}/`]) {
      const r = await page.goto(url, { timeout: 8000 }).catch((e) => ({ failed: String(e.message).slice(0, 80) }));
      const text = r.failed ? '' : await page.content();
      assert.ok(r.failed || !text.includes('INTERNAL-SECRET'), `must not load ${url}`);
      assert.ok(!text.includes('INTERNAL-SECRET'));
    }
  } finally { await b.close(); internal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real Chrome: div-based clickables (cursor:pointer) are listed and clickable; stale refs fail fast; waits are bounded; click by text', { skip: !existsSync(CHROME) }, async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><title>Slots</title><body><h1>Pick a slot</h1>
      <div class=slots><div class=slot style="cursor:pointer;padding:8px" onclick="document.getElementById('o').textContent='picked '+this.textContent">2:00 PM</div><div class=slot style="cursor:pointer;padding:8px" onclick="document.getElementById('o').textContent='picked '+this.textContent">3:00 PM</div></div>
      <div id=o></div><p>plain text not clickable</p></body></html>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'fn-br3-'));
  const b = new BrowserController({ chromium, profileDir: join(dir, 'profile'), headless: true, allowedDirs: [], allowPrivate: true });
  try {
    const page = await b.ensure(); await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const snap = await b.snapshot();
    const slot = snap.elements.find((e) => /2:00 PM/.test(e.name));
    assert.ok(slot && slot.role === 'clickable', `div slot should be listed as clickable: ${JSON.stringify(snap.elements)}`);
    assert.ok(!snap.elements.some((e) => /plain text/.test(e.name)), 'non-clickable text is not listed');
    await b.click({ ref: slot.ref });
    assert.match((await b.snapshot()).text, /picked 2:00 PM/);
    await b.click_text({ text: '3:00 PM' });
    assert.match((await b.snapshot()).text, /picked 3:00 PM/);
    const t0 = Date.now();
    await assert.rejects(() => b.click({ ref: 999 }), /stale_ref/);
    assert.ok(Date.now() - t0 < 4000, 'stale refs fail fast, not after a 10 s timeout');
    const t1 = Date.now();
    await assert.rejects(() => b.wait({ text: 'Select date', ms: 30000 }), /text_not_found.*snapshot/);
    assert.ok(Date.now() - t1 < 8000, 'text waits are capped');
    await assert.rejects(() => b.click_text({ text: 'Nonexistent button' }), /text_not_found/);
  } finally { await b.close(); srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real Chrome: repeated generic labels ("Select") carry their card title so the agent can tell them apart', { skip: !existsSync(CHROME) }, async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h1>Services</h1>
      <div class=card><h3>Beard Trim</h3><p>15 min · ₹100</p><a href="#a">Select</a></div>
      <div class=card><h3>Hair Color</h3><p>90 min · ₹1500</p><a href="#b">Select</a></div>
      <button>Save settings</button></body></html>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'fn-br4-'));
  const b = new BrowserController({ chromium, profileDir: join(dir, 'profile'), headless: true, allowedDirs: [], allowPrivate: true });
  try {
    const page = await b.ensure(); await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const names = (await b.snapshot()).elements.map((e) => e.name);
    assert.deepEqual(names, ['Select — Beard Trim', 'Select — Hair Color', 'Save settings']);
  } finally { await b.close(); srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real Chrome: a ref that vanished after a re-render is healed by name; truly gone elements fail with a stale_ref error', { skip: !existsSync(CHROME) }, async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // clicking "Mon 12 Oct" re-renders the whole list with NEW nodes (SPA-style), so the old data-friday-ref attributes disappear
    res.end(`<html><body><div id=root></div><script>
      const render = (picked) => { document.getElementById('root').innerHTML = '<button id=d>Mon 12 Oct</button><button>2:00 pm</button><div id=o>' + (picked ? 'picked ' + picked : '') + '</div>';
        document.querySelectorAll('button')[0].onclick = () => render('date'); document.querySelectorAll('button')[1].onclick = () => { document.getElementById('o').textContent = 'slot chosen'; }; };
      render('');</script></body></html>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'fn-br5-'));
  const b = new BrowserController({ chromium, profileDir: join(dir, 'profile'), headless: true, allowedDirs: [], allowPrivate: true });
  try {
    const page = await b.ensure(); await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const snap = await b.snapshot();
    const date = snap.elements.find((e) => e.name === 'Mon 12 Oct'); const slot = snap.elements.find((e) => e.name === '2:00 pm');
    await b.click({ ref: date.ref });                    // re-renders everything: the slot's old ref no longer exists in the DOM
    assert.equal(await page.locator(`[data-friday-ref="${slot.ref}"]`).count(), 0, 'precondition: the old ref is gone');
    await b.click({ ref: slot.ref });                    // healed by name
    assert.match(await page.locator('#o').innerText(), /slot chosen/);
    assert.ok(b.healed >= 1);
    await assert.rejects(() => b.click({ ref: 777 }), /stale_ref/);
  } finally { await b.close(); srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
