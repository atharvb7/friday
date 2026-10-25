import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth, Gmail } from '../src/google.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';

const b64u = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-g-'));
  const calls = []; let tokenFail = null; let refreshes = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); calls.push({ url: u, opts, body: opts.body instanceof URLSearchParams ? Object.fromEntries(opts.body) : opts.body ? JSON.parse(opts.body) : null });
    const ok = (j, status = 200) => ({ ok: status < 300, status, json: async () => j });
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      if (tokenFail) return ok({ error: tokenFail }, 400);
      const b = Object.fromEntries(opts.body);
      if (b.grant_type === 'refresh_token') { refreshes++; return ok({ access_token: `at${refreshes}`, expires_in: 3600 }); }
      return ok({ access_token: 'at0', refresh_token: 'rt-secret', expires_in: 3600, scope: 'gmail.modify' });
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return ok({});
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return ok({ emailAddress: 'atharv@gmail.com' });
    if (p === '/messages' && opts.method === 'GET') return ok({ messages: [{ id: 'm1' }], resultSizeEstimate: 1 });
    if (p === '/messages/m1') return ok({ id: 'm1', threadId: 't1', labelIds: ['UNREAD', 'INBOX'], snippet: 'Congrats', payload: { headers: [{ name: 'From', value: 'HR <hr@co.com>' }, { name: 'Subject', value: 'Offer' }, { name: 'Message-ID', value: '<abc@co>' }], mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: b64u('Hello Atharv') } }, { filename: 'offer.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 10 } }] } });
    if (p === '/messages/send') return ok({ id: 'sent1', threadId: calls.at(-1).body.threadId ?? 'tnew' });
    if (p === '/messages/batchModify') return ok({}, 204);
    if (p === '/messages/m1/attachments/att1') return ok({ data: b64u('%PDF-1.4 fake') });
    return ok({ error: { message: 'nope' } }, 404);
  };
  let now = 1_000_000;
  const store = new Store(join(dir, 'db.sqlite'));
  const files = new Files({ store, dir: join(dir, 'files') });
  const reauth = [];
  const opts = { clientId: 'cid', clientSecret: 'csec', publicUrl: 'https://friday.example.ts.net:4317/', dataDir: dir, fetchImpl, now: () => now, onReauth: (x) => reauth.push(x) };
  const g = new GoogleAuth(opts);
  const out = new GoogleAuth({ ...opts, account: 'outreach' });
  return { dir, g, out, reauth, gmail: new Gmail({ google: g, files }), files, calls, fail: (e) => { tokenFail = e; }, advance: (ms) => { now += ms; }, refreshes: () => refreshes, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('google oauth: PKCE auth url, single-use state, refresh token stored 0600 and never returned, refresh + revoke handling', async () => {
  const r = rig();
  try {
    assert.equal(new GoogleAuth({ dataDir: r.dir }).configured, false);
    const url = new URL(r.g.authUrl());
    assert.equal(url.searchParams.get('redirect_uri'), 'https://friday.example.ts.net:4317/oauth/google/callback');
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    await assert.rejects(() => r.g.callback({ code: 'c', state: 'forged' }), /invalid_or_expired_state/);
    const state = url.searchParams.get('state');
    assert.deepEqual(await r.g.callback({ code: 'c', state }), { email: 'atharv@gmail.com' });
    await assert.rejects(() => r.g.callback({ code: 'c', state }), /invalid_or_expired_state/, 'state is single use');
    const f = join(r.dir, 'secrets', 'google.json');
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(r.g.status()).includes('rt-secret'));
    assert.equal(r.g.status().connected, true);
    r.advance(2 * 3600_000);
    assert.equal(await r.g.accessToken(), 'at1'); assert.equal(await r.g.accessToken(), 'at1', 'cached until expiry');
    r.advance(2 * 3600_000); r.fail('invalid_grant');
    await assert.rejects(() => r.g.accessToken(), /google_reauth_needed/);
    assert.equal(existsSync(f), false, 'revoked token removed');
  } finally { r.done(); }
});

test('gmail: search/open parse headers, body and attachments; send builds MIME with chat attachments; reply threads correctly; organize + attachment save', async () => {
  const r = rig();
  try {
    const st = new URL(r.g.authUrl()).searchParams.get('state'); await r.g.callback({ code: 'c', state: st });
    const s = await r.gmail.search({ query: 'is:unread' });
    assert.equal(s.messages[0].subject, 'Offer'); assert.equal(s.messages[0].unread, true);
    assert.equal(r.calls.find((c) => c.url.pathname.endsWith('/messages') && c.opts.method === 'GET').url.searchParams.get('q'), 'is:unread');
    const m = await r.gmail.open('m1');
    assert.equal(m.body, 'Hello Atharv'); assert.equal(m.attachments[0].name, 'offer.pdf');
    const file = r.files.save({ name: 'plan.docx', data: 'PK fake docx' });
    const sent = await r.gmail.send({ to: 'prof@iitb.ac.in', subject: 'Plan — draft', body: 'Hi sir,\nPlease find attached.', attachments: [file.id.slice(0, 8)] });
    assert.equal(sent.sent, true);
    const raw = Buffer.from(r.calls.filter((c) => c.url.pathname.endsWith('/messages/send')).at(-1).body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    assert.match(raw, /To: prof@iitb\.ac\.in/); assert.match(raw, /Subject: =\?UTF-8\?B\?/); assert.match(raw, /multipart\/mixed/); assert.match(raw, /filename="plan\.docx"/);
    assert.match((await r.gmail.send({ to: 'x', subject: 's' })).error, /required/);
    await r.gmail.reply({ message_id: 'm1', body: 'Thank you!' });
    const rep = r.calls.filter((c) => c.url.pathname.endsWith('/messages/send')).at(-1).body;
    assert.equal(rep.threadId, 't1');
    const rraw = Buffer.from(rep.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    assert.match(rraw, /To: HR <hr@co\.com>/); assert.match(rraw, /Subject: Re: Offer/); assert.match(rraw, /In-Reply-To: <abc@co>/);
    assert.deepEqual(await r.gmail.organize({ op: 'mark_read', ids: ['m1'] }), { ok: true, op: 'mark_read', count: 1 });
    assert.deepEqual(r.calls.at(-1).body, { ids: ['m1'], addLabelIds: [], removeLabelIds: ['UNREAD'] });
    const at = await r.gmail.attachment({ message_id: 'm1', attachment_id: 'att1', name: 'offer.pdf' });
    assert.equal(at.file.name, 'offer.pdf'); assert.equal(r.files.read(at._attach[0]).toString(), '%PDF-1.4 fake');
  } finally { r.done(); }
});

test('google: a second (outreach) account has its own token file and state; reauth is reported, not silent', async () => {
  const r = rig();
  try {
    const mainState = new URL(r.g.authUrl()).searchParams.get('state');
    const outState = new URL(r.out.authUrl()).searchParams.get('state');
    assert.ok(r.out.ownsState(outState)); assert.ok(!r.out.ownsState(mainState)); assert.ok(r.g.ownsState(mainState));
    assert.equal(new URL(r.out.authUrl()).searchParams.get('redirect_uri'), 'https://friday.example.ts.net:4317/oauth/google/callback', 'one redirect URI for both');
    await r.out.callback({ code: 'c', state: outState });
    assert.ok(existsSync(join(r.dir, 'secrets', 'google-outreach.json')));
    assert.equal(existsSync(join(r.dir, 'secrets', 'google.json')), false, 'personal slot untouched');
    assert.equal(r.out.status().account, 'outreach'); assert.equal(r.out.status().connected, true); assert.equal(r.g.status().connected, false);
    assert.throws(() => new GoogleAuth({ dataDir: r.dir, account: '../x' }), /bad google account/);
    r.advance(2 * 3600_000); r.fail('invalid_grant');
    await assert.rejects(() => r.out.accessToken(), /google_reauth_needed/);
    assert.deepEqual(r.reauth, [{ account: 'outreach', email: 'atharv@gmail.com' }]);
  } finally { r.done(); }
});
