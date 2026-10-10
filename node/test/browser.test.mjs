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
  const b = new BrowserController({ chromium, profileDir: join(dir, 'profile'), headless: true, allowedDirs: [dl] });
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
    await assert.rejects(() => b.click({ ref: 9999 }), /Timeout|waiting/);
    await assert.rejects(() => b.click({ ref: 'x' }), /invalid_ref/);
  } finally { await b.close(); srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
