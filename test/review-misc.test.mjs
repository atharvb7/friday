// Regression tests for bugs found in the Oct 2026 code review (documents, images, Google, login).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { ChatStore } from '../src/chat.mjs';
import { Files } from '../src/files.mjs';
import { Documents } from '../src/documents.mjs';
import { GoogleAuth } from '../src/google.mjs';
import { OwnerLogin } from '../src/login.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('documents: append_pdf never takes a caller-supplied path, only a PDF chat file', async () => {
  const dir = tmp('friday-review-docs-');
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const files = new Files({ store, dir: join(dir, 'files') });
    const docs = new Documents({ files, appRoot, python: 'python3' });
    const pdf = files.save({ name: 'a.pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n'), source: 'user' });
    const txt = files.save({ name: 'b.txt', data: Buffer.from('hello'), source: 'user' });
    assert.match((await docs.edit(pdf.id, [{ op: 'append_pdf', path: '/etc/secret.pdf' }])).error, /append_pdf needs file/);
    assert.match((await docs.edit(pdf.id, [{ op: 'append_pdf', file: 'nope', path: '/etc/secret.pdf' }])).error, /append_pdf needs file/);
    assert.match((await docs.edit(pdf.id, [{ op: 'append_pdf', file: txt.id }])).error, /append_pdf needs file/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('google: invalid_grant on a reconnect code exchange keeps the working token file', async () => {
  const dir = tmp('friday-review-google-');
  try {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
    const g = new GoogleAuth({ clientId: 'c', clientSecret: 's', publicUrl: 'https://x.test', dataDir: dir, fetchImpl });
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'google.json'), JSON.stringify({ refresh_token: 'rt', email: 'me@x.com' }));
    const state = new URL(g.authUrl()).searchParams.get('state');
    await assert.rejects(() => g.callback({ code: 'used-code', state }), /google_token_400/);
    assert.ok(existsSync(join(dir, 'secrets', 'google.json')), 'token file kept');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('login: pending Google sign-in states are capped', () => {
  const m = new Map();
  const settings = { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) };
  const l = new OwnerLogin({ settings, google: { clientId: 'cid', clientSecret: 'sec' }, publicUrl: 'https://fridayy.site/' });
  for (let i = 0; i < 2000; i++) l.googleStart();
  assert.ok(l.states.size <= 500, String(l.states.size));
});
