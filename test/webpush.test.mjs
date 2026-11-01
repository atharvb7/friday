import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify, createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptPayload, vapidAuth, generateVapid, WebPush, b64u, unb64u } from '../src/webpush.mjs';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';

// Receiver side of RFC 8291 §3.4, written independently of encryptPayload's code path.
function decrypt(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16), idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const hk = (salt2, ikm, info, n) => { const prk = createHmac('sha256', salt2).update(ikm).digest(); return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, n); };
  const ikm = hk(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const d = createDecipheriv('aes-128-gcm', hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2, 'last-record padding delimiter');
  return plain.subarray(0, -1).toString();
}

test('RFC 8291 message encryption: header layout, round trip with an independent receiver, tamper detection', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = Buffer.alloc(16, 9);
  const body = encryptPayload({ payload: 'When I grow up, I want to be a watermelon', uaPublic: ua.getPublicKey(), authSecret: auth });
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body[20], 65, 'keyid length = uncompressed P-256 point');
  assert.equal(body.length, 16 + 4 + 1 + 65 + 41 + 1 + 16);
  assert.equal(decrypt(body, ua.getPrivateKey(), ua.getPublicKey(), auth), 'When I grow up, I want to be a watermelon');
  const bad = Buffer.from(body); bad[bad.length - 3] ^= 1;
  assert.throws(() => decrypt(bad, ua.getPrivateKey(), ua.getPublicKey(), auth));
});

test('VAPID JWT verifies with the advertised public key; keys are persisted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-push-'));
  try {
    const store = new Store(join(dir, 'db.sqlite')); const settings = new Settings(store);
    const wp = new WebPush({ store, settings });
    assert.equal(new WebPush({ store, settings }).publicKey, wp.publicKey, 'stable across restarts');
    const hdr = vapidAuth({ endpoint: 'https://push.example.com/abc', subject: 'mailto:a@b.c', privateJwk: wp.keys.privateJwk, publicKey: wp.publicKey });
    const [, jwt, k] = /^vapid t=(.+), k=(.+)$/.exec(hdr);
    const [h, p, s] = jwt.split('.');
    const pub = unb64u(wp.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(s)));
    assert.equal(JSON.parse(unb64u(p)).aud, 'https://push.example.com');
    assert.equal(k, wp.publicKey);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('send: encrypts per subscription, prunes 410, validates subscriptions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-push-'));
  try {
    const store = new Store(join(dir, 'db.sqlite')); const settings = new Settings(store);
    const calls = [];
    const wp = new WebPush({ store, settings, post: async (ep, body, headers) => { calls.push({ ep, len: body.length, headers }); return ep.includes('gone') ? 410 : 201; } });
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const sub = (ep) => ({ endpoint: ep, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 7)) } });
    wp.subscribe(sub('https://push.example.com/ok')); wp.subscribe(sub('https://push.example.com/gone'));
    assert.throws(() => wp.subscribe({ endpoint: 'http://insecure', keys: sub('x').keys }), /invalid endpoint/);
    assert.throws(() => wp.subscribe({ endpoint: 'https://x.example/y', keys: { p256dh: 'AAAA', auth: 'AAAA' } }), /invalid keys/);
    assert.equal(await wp.send({ title: 'Hi', body: 'there' }), 1);
    assert.equal(wp.count(), 1, 'gone endpoint removed');
    assert.equal(calls[0].headers['Content-Encoding'], 'aes128gcm');
    assert.match(calls[0].headers.Authorization, /^vapid t=/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
