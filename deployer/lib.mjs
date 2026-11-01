// Pure helpers for the deployer (build context + app type detection); unit-tested without Docker.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.next/cache', '.venv', '__pycache__']);
const MAX_CONTEXT = 200 * 1024 * 1024;

// ---------------------------------------------------------------- tiny ustar writer for the build context
export function tarFiles(files) { // [{ name, data, mode }]
  const blocks = [];
  for (const f of files) {
    const h = Buffer.alloc(512);
    let name = f.name, prefix = '';
    if (Buffer.byteLength(name) > 100) { const i = name.lastIndexOf('/', 154); prefix = name.slice(0, i); name = name.slice(i + 1); }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long: ${f.name}`);
    h.write(name, 0); h.write((f.mode ?? 0o644).toString(8).padStart(7, '0'), 100); h.write('0000000', 108); h.write('0000000', 116);
    h.write(f.data.length.toString(8).padStart(11, '0'), 124); h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar', 257); h.write('00', 263); h.write(prefix, 345);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
export function collect(root) {
  const out = []; let total = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name); const rel = relative(root, p);
      if (SKIP.has(e.name) || SKIP.has(rel) || e.name === '.env' || e.name.startsWith('.env.')) continue; // secrets never go into images
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) { total += st.size; if (total > MAX_CONTEXT) throw new Error('project too large (200 MB without node_modules)'); out.push({ name: rel, data: readFileSync(p), mode: st.mode & 0o111 ? 0o755 : 0o644 }); }
    }
  };
  walk(root);
  return out;
}

// What kind of app is it? Dockerfile wins; otherwise static site or Node app.
export function plan(files) {
  const has = (n) => files.some((f) => f.name === n);
  const df = files.find((f) => f.name === 'Dockerfile');
  if (df) { const m = /^\s*EXPOSE\s+(\d+)/mi.exec(df.data.toString()); return { kind: 'dockerfile', port: m ? Number(m[1]) : 8080, dockerfile: null }; }
  for (const dir of ['', 'dist/', 'build/', 'out/', 'public/']) if (has(`${dir}index.html`) && !has('package.json')) return { kind: 'static', port: 8080, dockerfile: `FROM nginxinc/nginx-unprivileged:1.27-alpine\nCOPY ${dir || '.'} /usr/share/nginx/html/\nEXPOSE 8080\n` };
  if (has('package.json')) return { kind: 'node', port: 3000, dockerfile: 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN (npm ci || npm install) && npm run build --if-present\nENV NODE_ENV=production PORT=3000 HOST=0.0.0.0\nEXPOSE 3000\nUSER node\nCMD ["npm", "start"]\n' };
  throw new Error('no Dockerfile, index.html or package.json in the project');
}

