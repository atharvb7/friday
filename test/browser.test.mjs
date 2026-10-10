// test/browser.test.mjs — coverage for the Friday dedicated-browser scaffold.
//
// All tests use injected Playwright doubles (present stub or forced-missing
// null). No real browser is launched and no network is touched: the stub's
// launch hook counts invocations and must stay at zero.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDriver } from '../src/browser.mjs';

const stubPlaywright = { chromium: { launch: async () => ({}) } };

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-browser-'));
  const root = join(dir, 'profiles');
  mkdirSync(root, { recursive: true });
  return { dir, root };
}

function makeDriver(root, extra = {}) {
  return new BrowserDriver({ profileRoot: root, playwright: stubPlaywright, ...extra });
}

async function launchedDriver(root, extra = {}) {
  const driver = makeDriver(root, extra);
  const out = await driver.launch({ profileDir: join(root, 'friday') });
  assert.equal(out.status, 'ok');
  return driver;
}

function readBrowserSource() {
  return readFileSync(new URL('../src/browser.mjs', import.meta.url), 'utf8');
}

test('goto validates URLs as https-only without touching the network', async () => {
  const { dir, root } = makeRoot();
  try {
    const driver = makeDriver(root, { allowedHosts: ['web.whatsapp.com'] });
    await assert.rejects(driver.goto('http://web.whatsapp.com/'), TypeError);
    await assert.rejects(driver.goto('file:///etc/passwd'), TypeError);
    await assert.rejects(driver.goto('data:text/html,hi'), TypeError);
    await assert.rejects(driver.goto('ftp://example.com/x'), TypeError);
    await assert.rejects(driver.goto('not a url'), TypeError);
    await assert.rejects(driver.goto(''), TypeError);
    await assert.rejects(driver.goto(42), TypeError);
    await assert.rejects(driver.goto('https://user:pass@web.whatsapp.com/'), TypeError);
    await assert.rejects(driver.goto(`https://web.whatsapp.com/${'a'.repeat(2048)}`), TypeError);
    // Non-allowlisted https host is refused even though the scheme is valid.
    await assert.rejects(driver.goto('https://evil.example/'), /allowlist/);
    // A valid allowlisted https URL passes validation, so it fails only on
    // not-launched — proving validation ran without any fetch.
    const pending = await driver.goto('https://web.whatsapp.com/');
    assert.deepEqual(pending, { status: 'failed', error: 'not_launched' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profileDir is confined to the dedicated browser-profiles root', async () => {
  const { dir, root } = makeRoot();
  try {
    const driver = makeDriver(root);
    await assert.rejects(driver.launch({ profileDir: '/etc/passwd' }), /escapes|inside/);
    await assert.rejects(driver.launch({ profileDir: '/tmp/evil-profile' }), /escapes|inside/);
    await assert.rejects(driver.launch({ profileDir: join(root, '..', 'evil') }), /escapes|inside/);
    await assert.rejects(driver.launch({ profileDir: '../../etc/passwd' }), /escapes|inside/);
    await assert.rejects(driver.launch({ profileDir: '' }), TypeError);
    await assert.rejects(driver.launch({}), TypeError);
    await assert.rejects(driver.launch({ profileDir: '\0' }), TypeError);
    // The container root itself is not a launchable profile.
    await assert.rejects(driver.launch({ profileDir: root }), /inside/);
    // A profile inside the root launches with safe defaults.
    const ok = await driver.launch({ profileDir: join(root, 'friday') });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.headless, true);
    assert.equal(ok.debugHost, '127.0.0.1');
    await driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing playwright maps to {status:failed} and import stays lazy', async () => {
  const { dir, root } = makeRoot();
  try {
    const missing = new BrowserDriver({ profileRoot: root, playwright: null });
    assert.deepEqual(await missing.launch({ profileDir: join(root, 'friday') }), {
      status: 'failed',
      error: 'playwright_not_installed',
    });
    assert.deepEqual(await missing.goto('https://example.com/'), {
      status: 'failed',
      error: 'playwright_not_installed',
    });
    assert.deepEqual(await missing.snapshot(), {
      status: 'failed',
      error: 'playwright_not_installed',
    });
    assert.deepEqual(await missing.stageFile({ name: 'a.pdf', size: 1 }), {
      status: 'failed',
      error: 'playwright_not_installed',
    });
    // Input validation still runs before the missing-playwright mapping.
    await assert.rejects(missing.goto('http://example.com/'), TypeError);
    // Module hygiene: lazy dynamic import only, no static require/import, no
    // network primitives, dedicated-profile and WhatsApp cautions documented.
    const source = readBrowserSource();
    assert.ok(!source.includes("from 'playwright'"), 'no static playwright import');
    assert.ok(!source.includes('require('), 'no require()');
    assert.ok(source.includes('await import('), 'lazy dynamic import present');
    assert.ok(!source.includes('fetch('), 'no fetch');
    assert.ok(source.includes('127.0.0.1'), 'loopback binding documented');
    assert.ok(source.includes('WhatsApp'), 'personal-account caution documented');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stageFile stages the attachment without sending', async () => {
  const { dir, root } = makeRoot();
  try {
    const driver = await launchedDriver(root);
    const staged = await driver.stageFile({ filePath: join('somewhere', 'xyz.pdf'), size: 12345 });
    assert.equal(staged.status, 'ok');
    assert.equal(staged.staged, true);
    assert.equal(staged.name, 'xyz.pdf');
    assert.equal(staged.size, 12345);
    assert.equal(staged.sent, false);
    // Bare-string form resolves the basename with stub size 0, still unsent.
    const byString = await driver.stageFile('notes.txt');
    assert.deepEqual(byString, { status: 'ok', staged: true, name: 'notes.txt', size: 0, sent: false });
    // Malformed staging requests are rejected.
    await assert.rejects(driver.stageFile({}), TypeError);
    await assert.rejects(driver.stageFile(null), TypeError);
    await assert.rejects(driver.stageFile([]), TypeError);
    await assert.rejects(driver.stageFile('https://example.com/x.pdf'), TypeError);
    await assert.rejects(driver.stageFile({ name: 'a/b.pdf' }), TypeError);
    await assert.rejects(driver.stageFile({ name: 'a.pdf', size: -1 }), TypeError);
    await assert.rejects(driver.stageFile({ name: '' }), TypeError);
    await driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot returns a semantic shape, never raw HTML', async () => {
  const { dir, root } = makeRoot();
  try {
    const driver = await launchedDriver(root);
    const target = 'https://example.com/docs';
    const went = await driver.goto(target);
    assert.equal(went.status, 'ok');
    const snap = await driver.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ['headings', 'links', 'status', 'title', 'url']);
    assert.equal(snap.status, 'ok');
    assert.equal(snap.url, new URL(target).href);
    assert.equal(typeof snap.title, 'string');
    assert.ok(Array.isArray(snap.headings));
    assert.ok(Array.isArray(snap.links));
    for (const banned of ['html', 'rawHtml', 'innerHTML', 'outerHTML', 'body']) {
      assert.ok(!(banned in snap), `snapshot must not contain ${banned}`);
    }
    await driver.close();
    // Snapshot after close reports not-launched instead of stale state.
    assert.deepEqual(await driver.snapshot(), { status: 'failed', error: 'not_launched' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('headless defaults to true and debugging stays on loopback', async () => {
  const { dir, root } = makeRoot();
  try {
    const driver = makeDriver(root);
    const out = await driver.launch({ profileDir: join(root, 'friday') });
    assert.equal(out.headless, true);
    assert.equal(out.debugHost, '127.0.0.1');
    assert.ok(Number.isInteger(out.debugPort) && out.debugPort >= 1);
    await driver.close();
    // Explicit headed mode is accepted only as an explicit boolean.
    const headed = makeDriver(root);
    const headedOut = await headed.launch({ profileDir: join(root, 'friday'), headless: false });
    assert.equal(headedOut.headless, false);
    assert.equal(headedOut.debugHost, '127.0.0.1');
    await headed.close();
    const bad = makeDriver(root);
    await assert.rejects(bad.launch({ profileDir: join(root, 'friday'), headless: 'yes' }), TypeError);
    await assert.rejects(bad.launch({ profileDir: join(root, 'friday'), debugPort: 0 }), RangeError);
    await assert.rejects(bad.launch({ profileDir: join(root, 'friday'), debugPort: 99999 }), RangeError);
    await bad.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close is idempotent and the stub browser is never really launched', async () => {
  const { dir, root } = makeRoot();
  try {
    let launches = 0;
    const counting = {
      chromium: {
        launch: async () => {
          launches += 1;
          return {};
        },
      },
    };
    const driver = new BrowserDriver({ profileRoot: root, playwright: counting });
    assert.deepEqual(await driver.close(), { status: 'ok', closed: true, launched: false });
    const out = await driver.launch({ profileDir: join(root, 'friday') });
    assert.equal(out.status, 'ok');
    assert.deepEqual(await driver.close(), { status: 'ok', closed: true, launched: true });
    assert.deepEqual(await driver.close(), { status: 'ok', closed: true, launched: false });
    assert.equal(launches, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
