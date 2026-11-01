// src/tools.mjs — Friday typed tool registry with workspace confinement.
//
// Safety rules (v1):
// - No shell execution and no network access. URL inputs are validated
//   syntactically only (https: required); nothing is ever retrieved.
// - File tools are confined under FRIDAY_WORKSPACE (default
//   /tmp/friday-workspace). Every path goes through a prefix guard plus a
//   realpath check, so traversal (`..`) and symlink escapes are rejected.
// - Read-only ("safe") tools run on a fast path with no effect-ledger writes.
// - Gated tools run the full effect-ledger flow: propose -> stage ->
//   requestApproval -> approve -> beginCommit -> handler -> resolve.
//   Approval binds the exact args: any change after requestApproval fails.
// - Every handler validates its args and throws TypeError on bad input.
//   Results are plain JSON-serializable structures suitable for receipts.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';

export const DEFAULT_WORKSPACE = '/tmp/friday-workspace';
export const MAX_FILE_READ_BYTES = 65536;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_QUERY_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 200;
export const MAX_CLAIM_LENGTH = 2000;

const TOOL_NAME_RE = /^[a-z][a-z0-9_.]{2,79}$/;
const SEARCH_SCAN_BUDGET = 2000;
const SEARCH_MAX_DEPTH = 25;

function assertArgsObject(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('args must be an object');
  }
}

function snapshotArgs(args) {
  // JSON round-trip: freezes the exact args for ledger binding and prevents
  // caller-side mutation aliasing between ledger steps and the handler.
  return JSON.parse(JSON.stringify(args));
}

export function resolveWorkspaceRoot(override) {
  const raw = override ?? process.env.FRIDAY_WORKSPACE ?? DEFAULT_WORKSPACE;
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new TypeError('invalid workspace');
  }
  const absolute = resolve(raw.trim());
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return absolute;
    throw error;
  }
}

export function confineToWorkspace(workspaceReal, requested) {
  if (typeof requested !== 'string' || requested.length < 1 || requested.length > 4096) {
    throw new TypeError('invalid path');
  }
  if (requested.includes('\0')) throw new TypeError('invalid path');
  // resolve() collapses `..` and anchors relative paths at the workspace.
  // Absolute paths are kept as-is, then must still land inside the workspace.
  const resolved = resolve(workspaceReal, requested);
  if (resolved !== workspaceReal && !resolved.startsWith(workspaceReal + sep)) {
    throw new TypeError('path escapes workspace');
  }
  // realpath check against symlink escape: walk up to the nearest existing
  // ancestor, resolve it, re-attach the missing tail, and re-check the prefix.
  let current = resolved;
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      const full = normalize(tail.length > 0 ? join(real, ...tail) : real);
      if (full !== workspaceReal && !full.startsWith(workspaceReal + sep)) {
        throw new TypeError('path escapes workspace (symlink)');
      }
      return { absolute: full, relative: relative(workspaceReal, full) || '.' };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function createFileSearch(getRoot) {
  return function fileSearch(args) {
    assertArgsObject(args);
    const { query, root = '.', limit = 20 } = args;
    if (typeof query !== 'string' || query.trim().length < 1 || query.trim().length > MAX_QUERY_LENGTH) {
      throw new TypeError(`query must be 1..${MAX_QUERY_LENGTH} chars`);
    }
    if (typeof root !== 'string' || root.length < 1 || root.length > 4096 || root.includes('\0')) {
      throw new TypeError('invalid root');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new TypeError(`limit must be 1..${MAX_SEARCH_RESULTS}`);
    }
    const workspaceReal = resolveWorkspaceRoot(getRoot());
    const confined = confineToWorkspace(workspaceReal, root);
    const rootStat = statSync(confined.absolute);
    if (!rootStat.isDirectory()) throw new TypeError('root is not a directory');

    const needle = query.trim().toLowerCase();
    const results = [];
    const visited = new Set();
    const stack = [{ dir: confined.absolute, depth: 0 }];
    let scanned = 0;
    while (stack.length > 0 && results.length < limit && scanned < SEARCH_SCAN_BUDGET) {
      const { dir, depth } = stack.pop();
      let dirReal;
      try {
        dirReal = realpathSync(dir);
      } catch {
        continue;
      }
      if (dirReal !== workspaceReal && !dirReal.startsWith(workspaceReal + sep)) continue;
      if (visited.has(dirReal)) continue;
      visited.add(dirReal);
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (results.length >= limit || scanned >= SEARCH_SCAN_BUDGET) break;
        scanned += 1;
        const full = join(dir, entry.name);
        let entryReal = full;
        let entryStat = null;
        if (entry.isSymbolicLink()) {
          try {
            entryReal = realpathSync(full);
          } catch {
            continue;
          }
          if (entryReal !== workspaceReal && !entryReal.startsWith(workspaceReal + sep)) continue;
          try {
            entryStat = statSync(entryReal);
          } catch {
            continue;
          }
        } else {
          try {
            entryStat = statSync(full);
          } catch {
            continue;
          }
        }
        if (entry.name.toLowerCase().includes(needle)) {
          // Filenames only: never return file contents from search.
          results.push({
            path: relative(workspaceReal, entryReal),
            size: entryStat.isFile() ? entryStat.size : 0,
            mtime: entryStat.mtime.toISOString(),
          });
        }
        if (entryStat.isDirectory() && depth < SEARCH_MAX_DEPTH) {
          stack.push({ dir: entryReal, depth: depth + 1 });
        }
      }
    }
    results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return results.slice(0, limit);
  };
}

function createFileRead(getRoot) {
  return function fileRead(args) {
    assertArgsObject(args);
    const { path, maxBytes = 8192 } = args;
    if (typeof path !== 'string' || path.length < 1 || path.length > 4096 || path.includes('\0')) {
      throw new TypeError('invalid path');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_READ_BYTES) {
      throw new TypeError(`maxBytes must be 1..${MAX_FILE_READ_BYTES}`);
    }
    const workspaceReal = resolveWorkspaceRoot(getRoot());
    const confined = confineToWorkspace(workspaceReal, path);
    const fd = openSync(confined.absolute, 'r');
    try {
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) throw new TypeError('path is not a file');
      const toRead = Math.min(fileStat.size, maxBytes);
      const buffer = Buffer.alloc(toRead);
      if (toRead > 0) readSync(fd, buffer, 0, toRead, 0);
      return {
        path: confined.relative,
        bytes: buffer.toString('utf8'),
        truncated: fileStat.size > toRead,
        previewHash: createHash('sha256').update(buffer).digest('hex'),
      };
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Closing is best effort; the read already completed or threw.
      }
    }
  };
}

function createResearchRecord() {
  // In-memory only: recording a research note must never auto-write to the
  // durable Memory store. Persistence happens via effect receipts instead.
  const records = [];
  function researchRecord(args) {
    assertArgsObject(args);
    const { source, title, claim } = args;
    if (typeof source !== 'string' || source.trim().length < 1 || source.trim().length > MAX_URL_LENGTH) {
      throw new TypeError('invalid source');
    }
    let url;
    try {
      url = new URL(source.trim());
    } catch {
      throw new TypeError('source must be a valid URL');
    }
    if (url.protocol !== 'https:') throw new TypeError('source must use https');
    if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > MAX_TITLE_LENGTH) {
      throw new TypeError('invalid title');
    }
    if (typeof claim !== 'string' || claim.trim().length < 1 || claim.trim().length > MAX_CLAIM_LENGTH) {
      throw new TypeError('invalid claim');
    }
    const record = {
      id: randomUUID(),
      source: source.trim(),
      title: title.trim(),
      claim: claim.trim(),
      recordedAt: new Date().toISOString(),
    };
    records.push(record);
    return { ...record };
  }
  return { handler: researchRecord, records };
}

export class ToolRegistry {
  constructor({ workspace = null } = {}) {
    if (workspace !== null && (typeof workspace !== 'string' || !workspace.trim())) {
      throw new TypeError('invalid workspace');
    }
    this.workspaceOverride = workspace;
    this.tools = new Map();
    const getRoot = () => this.workspaceOverride ?? process.env.FRIDAY_WORKSPACE ?? DEFAULT_WORKSPACE;
    const { handler: recordHandler, records } = createResearchRecord();
    this.researchRecords = records;
    this.register('file.search', { handler: createFileSearch(getRoot), permission: 'safe' });
    this.register('file.read', { handler: createFileRead(getRoot), permission: 'safe' });
    this.register('research.record', { handler: recordHandler, permission: 'safe' });
  }

  register(name, { handler, permission } = {}) {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) throw new TypeError('invalid tool name');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (typeof permission !== 'string' || !permission.trim()) throw new TypeError('permission required');
    if (this.tools.has(name)) throw new Error(`tool already registered: ${name}`);
    this.tools.set(name, { handler, permission: permission.trim() });
    return this;
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return [...this.tools.entries()].map(([name, entry]) => ({ name, permission: entry.permission }));
  }

  async run({ taskId, tool, args, effects = null, approvalArgs, ttlMs } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId required');
    if (typeof tool !== 'string' || !tool) throw new TypeError('tool required');
    const entry = this.tools.get(tool);
    if (!entry) throw new TypeError(`unknown tool: ${tool}`);
    assertArgsObject(args);
    const exact = snapshotArgs(args);
    if (entry.permission === 'safe') {
      // Read-only fast path: no effect-ledger writes.
      const result = await entry.handler(exact);
      return { ok: true, tool, result, effectId: null, receipt: null };
    }
    if (!effects || typeof effects.propose !== 'function') {
      throw new TypeError('effects ledger required for gated tools');
    }
    const proposed = effects.propose(taskId, tool, exact);
    effects.stage(proposed.id, exact);
    const { token } =
      ttlMs === undefined ? effects.requestApproval(proposed.id) : effects.requestApproval(proposed.id, ttlMs);
    // Approval binds the exact args: supplying different args here (or a
    // caller mutating args mid-flow) fails with "arguments changed ...".
    const toCommit = approvalArgs === undefined ? exact : snapshotArgs(approvalArgs);
    effects.approve(proposed.id, token, toCommit);
    effects.beginCommit(proposed.id, toCommit);
    try {
      const result = await entry.handler(toCommit);
      const receipt = { tool, args: toCommit, result };
      effects.resolve(proposed.id, 'verified_success', receipt);
      return { ok: true, tool, result, effectId: proposed.id, receipt };
    } catch (error) {
      const receipt = { tool, args: toCommit, error: error?.message ?? String(error) };
      try {
        effects.resolve(proposed.id, 'verified_failure', receipt);
      } catch {
        // Resolution failure must not mask the original handler error.
      }
      throw error;
    }
  }
}
