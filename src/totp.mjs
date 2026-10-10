// RFC 6238 TOTP (SHA-1, 6 digits, 30s) with no dependencies.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new TypeError('invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret() { return base32Encode(randomBytes(20)); }

export function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[19] & 15;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

export function totp(secret, now = Date.now()) { return hotp(secret, Math.floor(now / 30000)); }

// Returns the matched time-step (for replay protection) or null.
export function verifyTotp(secret, code, { now = Date.now(), window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(secret, step + d));
    if (timingSafeEqual(expected, Buffer.from(code))) return step + d;
  }
  return null;
}

export function otpauthUri(secret, account = 'owner', issuer = 'Friday') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
