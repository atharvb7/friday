// src/env.mjs — minimal .env loader (no dependencies).
// Reads KEY=VALUE lines (ignores blanks/#comments, strips matching quotes)
// and sets only keys that are NOT already in process.env, so real environment
// variables always win over the file. Never logs values.
import { readFileSync, existsSync } from 'node:fs';

export function loadEnvFile(path) {
  if (!path || !existsSync(path)) return { loaded: false, path };
  const out = { loaded: true, path, keys: [] };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !value) continue;
    if (!(key in process.env)) {
      process.env[key] = value;
      out.keys.push(key);
    }
  }
  return out;
}
