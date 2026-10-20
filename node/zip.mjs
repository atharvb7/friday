// Minimal ZIP writer (STORE, no compression — photos/videos are already compressed). Zip64 not needed below 4 GB.
import { crc32 } from 'node:zlib';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

const dosTime = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });

export function zipFiles(files) { // [{ name, data, mtime }]
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const crc = crc32(f.data); const { time, date } = dosTime(f.mtime ?? new Date());
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(f.data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
    parts.push(h, name, f.data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export function zipFolder(dir, { maxBytes = 300 * 1024 * 1024 } = {}) {
  const files = []; let total = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); const st = lstatSync(p); if (st.isSymbolicLink() || e.name.startsWith('.')) continue; if (st.isDirectory()) walk(p); else if (st.isFile()) { total += st.size; if (total > maxBytes) throw new Error('folder too large to zip (300 MB)'); files.push({ name: relative(dir, p), data: readFileSync(p), mtime: st.mtime }); } } };
  walk(dir);
  if (!files.length) throw new Error('nothing to zip — the folder is empty');
  return { zip: zipFiles(files), count: files.length };
}
