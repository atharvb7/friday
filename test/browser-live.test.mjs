// test/browser-live.test.mjs — RealBrowser without network or real Chrome.
// dump-dom is mocked via an injected runner fn; profile confinement, https-only
// validation, file staging, and never-auto-send are all exercised offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealBrowser } from '../src/browser-live.mjs';

const MOCK_HTML = `<!doctype html><html><head><title>Mock Page</title></head>
<body><h1>Hello</h1><h2>Sub</h2>
<a href="https://example.com/a">Alpha</a><a href="/local">Local</a>
</body></html>`;

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-live-'));
  const root = join(dir, 'profiles');
  mkdirSync(root, { recursive: true });
  return { dir, root };
}

function mockRunner(calls) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    assert.ok(args.includes('--dump-dom'), 'snapshot must use --dump-dom');
    assert.ok(!args.some((a) => a.includes('0.0.0.0')), 'never bind non-loopback');
    return { stdout: MOCK_HTML, stderr: '' };
  };
}

function makeBrowser(root, calls = []) {
  return new RealBrowser({
    profileRoot: root,
    chromePath: '/usr/bin/google-chrome',
    existsFn: () => true, // no real binary touched; runner is also mocked
    runner: mockRunner(calls),
  });
}

test('file:// and http URLs are refused without spawning chrome', async () => {
  const { dir, root } = makeRoot();
  try {
    const calls = [];
    const b = makeBrowser(root, calls);
    b.launch({ profileDir: join(root, 'friday') });
    await assert.rejects(b.snapshot('file:///etc/passwd'), TypeError);
    await assert.rejects(b.snapshot('http://example.com/'), TypeError);
    await assert.rejects(b.snapshot('data:text/html,hi'), TypeError);
    await assert.rejects(b.snapshot(''), TypeError);
    assert.equal(calls.length, 0);
    await b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile is confined to the browser-profiles root', () => {
  const { dir, root } = makeRoot();
  try {
    const b = makeBrowser(root);
    assert.throws(() => b.launch({ profileDir: '/etc/passwd' }), /escapes|inside/);
    assert.throws(() => b.launch({ profileDir: join(root, '..', 'evil') }), /escapes|inside/);
    assert.throws(() => b.launch({ profileDir: '' }), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launch is loopback-only with fixed port + lockfile; snapshot is semantic', async () => {
  const { dir, root } = makeRoot();
  try {
    const calls = [];
    const b = makeBrowser(root, calls);
    const out = b.launch({ profileDir: join(root, 'friday') });
    assert.equal(out.status, 'ok');
    assert.equal(out.debugHost, '127.0.0.1');
    assert.equal(out.debugPort, 9222);
    assert.ok(out.args.some((a) => a.includes('127.0.0.1:9222')), 'args pin loopback:port');
    assert.ok(out.args.includes('--headless=new'));
    const snap = await b.snapshot('https://example.com/docs');
    assert.equal(snap.status, 'ok');
    assert.equal(snap.url, 'https://example.com/docs');
    assert.equal(snap.title, 'Mock Page');
    assert.deepEqual(snap.headings, ['Hello', 'Sub']);
    assert.equal(snap.links.length, 2);
    for (const banned of ['html', 'rawHtml', 'innerHTML', 'outerHTML', 'body', 'stdout']) {
      assert.ok(!(banned in snap), `snapshot must not contain ${banned}`);
    }
    await b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot before launch reports not_launched; missing chrome reported', async () => {
  const { dir, root } = makeRoot();
  try {
    const b = makeBrowser(root);
    assert.deepEqual(await b.snapshot('https://example.com/'), { status: 'failed', error: 'not_launched' });
    const noChrome = new RealBrowser({ profileRoot: root, existsFn: () => false, runner: async () => ({ stdout: '' }) });
    assert.deepEqual(noChrome.launch({ profileDir: join(root, 'friday') }).error, 'chrome_not_found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stageFile checks the real filesystem; send never auto-sends', () => {
  const { dir, root } = makeRoot();
  try {
    const b = makeBrowser(root);
    b.launch({ profileDir: join(root, 'friday') });
    const f = join(dir, 'doc.pdf');
    writeFileSync(f, 'hello');
    const staged = b.stageFile(f);
    assert.equal(staged.status, 'ok');
    assert.equal(staged.staged, true);
    assert.equal(staged.name, 'doc.pdf');
    assert.equal(staged.size, 5);
    assert.equal(staged.sent, false);
    assert.throws(() => b.stageFile(join(dir, 'missing.pdf')), /file_not_found/);
    assert.throws(() => b.stageFile('https://example.com/x.pdf'), TypeError);
    assert.throws(() => b.stageFile('file:///etc/passwd'), TypeError);
    const send = b.send();
    assert.equal(send.sent, false);
    assert.match(send.error, /explicit_commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
