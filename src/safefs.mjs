// Filesystem helpers for directories an untrusted agent can write to. The agent may plant
// symlinks, FIFOs or device files where Friday later reads/writes, so the host never follows
// links or blocks on special files there.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Read a regular file (never a symlink/FIFO/device), at most maxBytes. Returns a Buffer or throws.
export function readRegularFile(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('not_a_regular_file');
    if (st.size > maxBytes) throw new Error('file_too_large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

// Replace `path` atomically without following whatever is currently there.
export function writeFileReplacing(path, data, mode = 0o600) {
  const tmp = join(dirname(path), `.tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, data, { mode, flag: 'wx' });
  try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; } // rename replaces a symlink itself, never its target
}

// mkdir -p that refuses to treat a symlink as the directory (replaces it with a real one).
export function ensureRealDir(path, mode = 0o700) {
  try { const st = lstatSync(path); if (st.isSymbolicLink() || !st.isDirectory()) unlinkSync(path); } catch { /* absent */ }
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}
