import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerLogin } from '../src/login.mjs';

const settingsMem = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? structuredClone(m.get(k)) : d), set: (k, v) => m.set(k, structuredClone(v)), raw: m }; };

test('owner login: password rules, scrypt check, email must match, nothing stored in clear', () => {
  const settings = settingsMem();
  const l = new OwnerLogin({ settings });
  assert.throws(() => l.setPassword('me@x.com', 'short'), /10-200/);
  assert.throws(() => l.setPassword('me@x.com', 'aaaaaaaaaaaa'), /repetitive/);
  assert.throws(() => l.setPassword('nope', 'a-good-password-1'), /email/);
  l.setPassword('Me@X.com', 'a-good-password-1');
  assert.equal(l.checkPassword('me@x.com', 'a-good-password-1'), true);
  assert.equal(l.checkPassword('ME@x.com ', 'a-good-password-1'), true, 'email is case/space-insensitive');
  assert.equal(l.checkPassword('me@x.com', 'a-good-password-2'), false);
  assert.equal(l.checkPassword('other@x.com', 'a-good-password-1'), false);
  assert.ok(!JSON.stringify([...settings.raw.values()]).includes('a-good-password-1'));
  assert.equal(new OwnerLogin({ settings: settingsMem() }).checkPassword('me@x.com', ''), false, 'no password set -> nothing passes');
  l.clearPassword(); assert.equal(l.checkPassword('me@x.com', 'a-good-password-1'), false);
});

test('owner login: Google allows only the allow-listed verified email; handoff is single-use and short-lived', async () => {
  let userinfo = { email: 'bhosaleatharv2@gmail.com', email_verified: true };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (String(url).includes('/token') ? { access_token: 'at' } : userinfo) });
  let now = 1_000_000;
  const l = new OwnerLogin({ settings: settingsMem(), google: { clientId: 'cid', clientSecret: 'sec' }, publicUrl: 'https://fridayy.site/', fetchImpl, now: () => now });
  assert.throws(() => new OwnerLogin({ settings: settingsMem() }).googleStart(), /not_configured/);
  l.setGoogle({ email: 'BhosaleAtharv2@gmail.com' });
  const u = new URL(l.googleStart());
  assert.equal(u.searchParams.get('redirect_uri'), 'https://fridayy.site/oauth/google/login/callback');
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
  await assert.rejects(() => l.googleFinish({ code: 'c', state: 'forged' }), /expired/);
  const h = await l.googleFinish({ code: 'c', state: u.searchParams.get('state') });
  assert.equal(h.needsTotp, true, 'authenticator still required by default');
  assert.equal(l.takeHandoff(h.handoff).email, 'bhosaleatharv2@gmail.com');
  assert.equal(l.takeHandoff(h.handoff), null, 'single use');
  userinfo = { email: 'someone@gmail.com', email_verified: true };
  await assert.rejects(() => l.googleFinish({ code: 'c', state: new URL(l.googleStart()).searchParams.get('state') }), /not allowed/);
  userinfo = { email: 'bhosaleatharv2@gmail.com', email_verified: false };
  await assert.rejects(() => l.googleFinish({ code: 'c', state: new URL(l.googleStart()).searchParams.get('state') }), /not allowed/);
  userinfo = { email: 'bhosaleatharv2@gmail.com', email_verified: true };
  l.setGoogle({ skipTotp: true });
  const h2 = await l.googleFinish({ code: 'c', state: new URL(l.googleStart()).searchParams.get('state') });
  assert.equal(h2.needsTotp, false);
  now += 4 * 60_000; assert.equal(l.peekHandoff(h2.handoff), null, 'expires after 3 minutes');
});
