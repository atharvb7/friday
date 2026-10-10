// Confinement for agent processes (DSH). One sandbox layer, owned by Friday:
// the agent sees the system read-only, can write only its task workspace and its
// own DSH home, and cannot see Friday's database, tokens, .env or the user's
// home directory. Network stays on (research/coding need it); secrets are never
// in its environment or filesystem. Fails closed when bubblewrap is missing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function bwrapPath() {
  const r = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Verifies that unprivileged user namespaces actually work here (some kernels/containers forbid them).
export function bwrapUsable(bin = bwrapPath()) {
  if (!bin) return false;
  return spawnSync(bin, ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { stdio: 'ignore' }).status === 0;
}

const under = (child, parent) => child === parent || child.startsWith(`${parent}/`);

export function buildBwrapArgs({ home, appRoot, dataDir, writable = [], readonly = [] }) {
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  const rw = writable.map((p) => resolve(p));
  const ro = readonly.map((p) => resolve(p));
  // Hide: the user's home, Friday's code/config, Friday's data dir.
  const hide = [home, appRoot, dataDir].filter(Boolean).map((p) => resolve(p));
  // De-duplicate nested hides (hiding the parent already hides the child).
  const roots = hide.filter((p) => !hide.some((q) => q !== p && under(p, q)));
  for (const p of roots) if (existsSync(p)) args.push('--tmpfs', p);
  // Re-expose only what the agent legitimately needs, if it was hidden above.
  for (const p of ro) if (existsSync(p) && roots.some((r) => under(p, r))) args.push('--ro-bind', p, p);
  for (const p of rw) { if (existsSync(p)) args.push('--bind', p, p); }
  return args;
}

// Directory that must stay readable so `node <bin>` works (the DSH install tree).
export function dshInstallRoot(binPath) {
  let dir = dirname(resolve(binPath));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml')) || existsSync(resolve(dir, 'node_modules', '.pnpm'))) return dir;
    dir = dirname(dir);
  }
  return resolve(dirname(binPath), '../../..');
}
