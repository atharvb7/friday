// Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291), dependency-free.
// Lets the phone PWA get a notification when the page is closed.
import { createECDH, createCipheriv, createHmac, createPrivateKey, randomBytes, sign, generateKeyPairSync, createPublicKey } from 'node:crypto';
import https from 'node:https';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');

function hkdf(salt, ikm, info, len) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  let out = Buffer.alloc(0), prev = Buffer.alloc(0);
  for (let i = 1; out.length < len; i++) { prev = createHmac('sha256', prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest(); out = Buffer.concat([out, prev]); }
  return out.subarray(0, len);
}

// RFC 8291 aes128gcm body for one subscription. `asKeys`/`salt` injectable for test vectors.
export function encryptPayload({ payload, uaPublic, authSecret, asKeys = null, salt = randomBytes(16) }) {
  const ecdh = createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(asKeys.private); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, secret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, data]);
}

export function generateVapid() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)]);
  return { privateJwk: jwk, publicKey: b64u(raw) };
}

export function vapidAuth({ endpoint, subject, privateJwk, publicKey, now = Date.now() }) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKey}`;
}

export class WebPush {
  constructor({ store, settings, subject = 'mailto:friday@localhost', post = defaultPost }) {
    this.db = store.db; this.settings = settings; this.subject = subject; this.post = post;
    this.db.exec('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT, created_at TEXT NOT NULL)');
    let keys = settings.get('vapid');
    if (!keys) { keys = generateVapid(); settings.set('vapid', keys); }
    this.keys = keys;
  }
  get publicKey() { return this.keys.publicKey; }

  subscribe({ endpoint, keys }, device = null) {
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) throw new TypeError('invalid endpoint');
    const p = unb64u(keys?.p256dh ?? ''), a = unb64u(keys?.auth ?? '');
    if (p.length !== 65 || p[0] !== 4 || a.length < 16) throw new TypeError('invalid keys');
    this.db.prepare('INSERT INTO push_subs (endpoint, p256dh, auth, device, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, device=excluded.device')
      .run(endpoint, keys.p256dh, keys.auth, device, new Date().toISOString());
  }
  unsubscribe(endpoint) { return this.db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint).changes > 0; }
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n; }

  async send({ title, body = '', tag = 'friday' }) {
    const payload = JSON.stringify({ title: String(title).slice(0, 120), body: String(body).slice(0, 300), tag });
    let sent = 0;
    for (const s of this.db.prepare('SELECT * FROM push_subs').all()) {
      try {
        const bodyBuf = encryptPayload({ payload, uaPublic: unb64u(s.p256dh), authSecret: unb64u(s.auth) });
        const status = await this.post(s.endpoint, bodyBuf, { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'normal',
          Authorization: vapidAuth({ endpoint: s.endpoint, subject: this.subject, privateJwk: this.keys.privateJwk, publicKey: this.keys.publicKey }) });
        if (status === 404 || status === 410) this.unsubscribe(s.endpoint); else if (status < 300) sent += 1;
      } catch { /* one bad endpoint must not block the rest */ }
    }
    return sent;
  }
}

function defaultPost(endpoint, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, timeout: 15_000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
  });
}
