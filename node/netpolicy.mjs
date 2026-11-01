// Network address policy for the laptop node (kept in sync with src/web.mjs by test/netpolicy-sync).
import net from 'node:net';
import { lookup } from 'node:dns/promises';

// Expand any IPv6 text form (incl. ::, embedded dotted v4) into 16 bytes, or null.
function ipv6Bytes(ip) {
  let v = ip.toLowerCase().split('%')[0];
  const m4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (m4) { const q = m4[1].split('.').map(Number); if (q.some((n) => n > 255)) return null; v = v.slice(0, -m4[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16); }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

function privateV4(a, b, c) {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

// Only global unicast is allowed; IPv4-in-IPv6 encodings are unwrapped and judged as IPv4.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) { const [a, b, c] = ip.split('.').map(Number); return privateV4(a, b, c); }
  if (!net.isIPv6(ip)) return true;
  const by = ipv6Bytes(ip);
  if (!by) return true;
  const zeros = (from, to) => by.subarray(from, to).every((x) => x === 0);
  if (zeros(0, 10) && by[10] === 0xff && by[11] === 0xff) return privateV4(by[12], by[13], by[14]); // ::ffff:a.b.c.d (any textual form)
  if (zeros(0, 12)) return true;                                                                       // ::, ::1, deprecated IPv4-compatible
  if (by[0] === 0x00 && by[1] === 0x64 && by[2] === 0xff && by[3] === 0x9b && zeros(4, 12)) return privateV4(by[12], by[13], by[14]); // NAT64
  if (by[0] === 0x20 && by[1] === 0x02) return privateV4(by[2], by[3], by[4]);                         // 6to4
  if (by[0] === 0x20 && by[1] === 0x01 && by[2] === 0x00 && by[3] === 0x00) return true;              // Teredo
  if (by[0] === 0x20 && by[1] === 0x01 && by[2] === 0x0d && by[3] === 0xb8) return true;              // documentation
  return (by[0] & 0xe0) !== 0x20;                                                                      // outside 2000::/3 (ULA, link-local, site-local, multicast...)
}


const cache = new Map();
// True when the host resolves (or is literally) to anything non-public. Resolution is cached briefly.
export async function hostIsPrivate(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (net.isIP(h)) return isPrivateAddress(h);
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v;
  try { v = (await lookup(h, { all: true })).some((a) => isPrivateAddress(a.address)); } catch { v = true; } // unresolvable => refuse
  cache.set(h, { at: Date.now(), v });
  return v;
}
