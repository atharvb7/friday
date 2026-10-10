// Backup/restore: consistent SQLite snapshot (VACUUM INTO) + workspaces in one
// tar.gz. Secrets (access token, .env, DSH home) are excluded unless asked.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, chmodSync, copyFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const INCLUDE_DIRS = ['workspace', 'code-workspaces', 'files', 'research', 'generated', 'skills', 'agents'];

export function createBackup({ dataDir, outDir, withSecrets = false, keep = 7, now = new Date() }) {
  const db = join(dataDir, 'friday.sqlite');
  if (!existsSync(db)) throw new Error('no_database');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(tmpdir(), 'friday-backup-'));
  try {
    const src = new DatabaseSync(db, { readOnly: true });
    try { src.exec(`VACUUM INTO '${join(stage, 'friday.sqlite').replaceAll("'", "''")}'`); } finally { src.close(); }
    const entries = ['friday.sqlite'];
    for (const d of INCLUDE_DIRS) if (existsSync(join(dataDir, d))) entries.push(d);
    if (withSecrets) for (const f of ['access-token', 'dsh-home']) if (existsSync(join(dataDir, f))) entries.push(f);
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const file = join(outDir, `friday-backup-${stamp}${withSecrets ? '-SECRETS' : ''}.tgz`);
    // friday.sqlite comes from the staging snapshot, everything else from dataDir.
    const args = ['-czf', file, '-C', stage, 'friday.sqlite', ...(entries.length > 1 ? ['-C', dataDir, ...entries.slice(1)] : [])];
    const r = spawnSync('tar', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar_failed: ${r.stderr}`);
    chmodSync(file, 0o600);
    const old = readdirSync(outDir).filter((f) => /^friday-backup-.*\.tgz$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) rmSync(join(outDir, f), { force: true });
    return { file, bytes: statSync(file).size, withSecrets, pruned: old.length };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function restoreBackup({ file, dataDir, force = false }) {
  if (!existsSync(file)) throw new Error('backup_not_found');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (existsSync(join(dataDir, 'friday.sqlite'))) {
    if (!force) throw new Error('data_dir_not_empty (use --force; existing DB is moved aside, not deleted)');
    const aside = join(dataDir, `pre-restore-${Date.now()}`);
    mkdirSync(aside, { mode: 0o700 });
    for (const f of ['friday.sqlite', 'friday.sqlite-wal', 'friday.sqlite-shm']) if (existsSync(join(dataDir, f))) renameSync(join(dataDir, f), join(aside, f));
  }
  const r = spawnSync('tar', ['-xzf', resolve(file), '-C', dataDir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar_failed: ${r.stderr}`);
  chmodSync(join(dataDir, 'friday.sqlite'), 0o600);
  return { restoredFrom: basename(file) };
}
