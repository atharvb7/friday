import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GIB = 1024 ** 3;
const read = (path, fallback = null) => {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
};

function parseMeminfo(text) {
  return Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
    const match = line.match(/^([^:]+):\s+(\d+)(?:\s+(kB))?/);
    return match ? [match[1], Number(match[2]) * (match[3] ? 1024 : 1)] : null;
  }).filter(Boolean));
}

function parsePressure(text) {
  if (!text) return null;
  const parseLine = name => {
    const line = text.split('\n').find(item => item.startsWith(`${name} `));
    if (!line) return null;
    const fields = Object.fromEntries([...line.matchAll(/(avg10|avg60|avg300|total)=([\d.]+)/g)].map(m => [m[1], Number(m[2])]));
    return fields;
  };
  return { some: parseLine('some'), full: parseLine('full') };
}

function parseLimit(text) {
  if (!text) return null;
  const value = text.trim();
  if (value === 'max') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function findCgroupV2({ procRoot, mountInfoText, cgroupText }) {
  const entry = cgroupText.split('\n').map(line => line.match(/^0::(.+)$/)).find(Boolean)?.[1];
  if (!entry) return null;
  for (const line of mountInfoText.split('\n')) {
    const marker = line.indexOf(' - cgroup2 ');
    if (marker < 0) continue;
    const before = line.slice(0, marker).split(' ');
    const root = before[3]?.replaceAll('\\040', ' ');
    const mount = before[4]?.replaceAll('\\040', ' ');
    if (!root || !mount) continue;
    const relative = entry === root ? '' : entry.startsWith(`${root}/`) ? entry.slice(root.length + 1) : entry.replace(/^\//, '');
    const path = join(mount, relative);
    return { path, mount, cgroupPath: entry };
  }
  // Useful for synthetic proc roots and containers with the standard mount.
  const fallback = '/sys/fs/cgroup';
  return { path: join(fallback, entry.replace(/^\//, '')), mount: fallback, cgroupPath: entry };
}

export function readResources(options = {}) {
  const procRoot = options.procRoot ?? '/proc';
  const meminfo = parseMeminfo(read(join(procRoot, 'meminfo'), ''));
  const hostPressure = parsePressure(read(join(procRoot, 'pressure/memory'), ''));
  const cgroup = options.cgroupPath
    ? { path: options.cgroupPath, mount: null, cgroupPath: options.cgroupPath }
    : findCgroupV2({
      procRoot,
      cgroupText: read(join(procRoot, 'self/cgroup'), ''),
      mountInfoText: read(join(procRoot, 'self/mountinfo'), ''),
    });
  const cgPath = cgroup?.path;
  const current = cgPath ? parseLimit(read(join(cgPath, 'memory.current'))) : null;
  const high = cgPath ? parseLimit(read(join(cgPath, 'memory.high'))) : null;
  const max = cgPath ? parseLimit(read(join(cgPath, 'memory.max'))) : null;
  const cgroupPressure = cgPath ? parsePressure(read(join(cgPath, 'memory.pressure'))) : null;
  const available = meminfo.MemAvailable ?? 0;
  const pressureSomeAvg10 = hostPressure?.some?.avg10 ?? 0;
  const pressureFullAvg10 = hostPressure?.full?.avg10 ?? 0;
  let mode = 'normal';
  if (available < 1.25 * GIB || pressureSomeAvg10 >= 25 || pressureFullAvg10 >= 5) mode = 'emergency';
  else if (available < 2 * GIB || pressureSomeAvg10 >= 10 || pressureFullAvg10 >= 2) mode = 'paused';
  else if (available < 4 * GIB || pressureSomeAvg10 >= 3 || pressureFullAvg10 >= 0.5) mode = 'constrained';
  const usageRatio = current !== null && max !== null && max > 0 ? current / max : null;
  if (usageRatio !== null) {
    if (usageRatio >= 0.98) mode = 'emergency';
    else if (usageRatio >= 0.90 && modeRank(mode) < modeRank('paused')) mode = 'paused';
    else if (usageRatio >= 0.80 && modeRank(mode) < modeRank('constrained')) mode = 'constrained';
  }
  if (high !== null && current !== null && current >= high) {
    if (modeRank(mode) < modeRank('paused')) mode = 'paused';
  }
  const coreRssBytes = options.process?.memoryUsage?.().rss ?? process.memoryUsage().rss;
  return {
    sampledAt: new Date((options.now?.() ?? Date.now())).toISOString(),
    totalBytes: meminfo.MemTotal ?? null,
    availableBytes: available,
    swapTotalBytes: meminfo.SwapTotal ?? 0,
    swapFreeBytes: meminfo.SwapFree ?? 0,
    pressureSomeAvg10,
    pressureFullAvg10,
    pressureSomeAvg60: hostPressure?.some?.avg60 ?? 0,
    pressureSomeTotal: hostPressure?.some?.total ?? 0,
    cgroup: cgPath ? {
      path: cgPath,
      cgroupPath: cgroup.cgroupPath,
      currentBytes: current,
      highBytes: high,
      maxBytes: max,
      usageRatio,
      pressureSomeAvg10: cgroupPressure?.some?.avg10 ?? 0,
      pressureFullAvg10: cgroupPressure?.full?.avg10 ?? 0,
    } : null,
    coreRssBytes,
    mode,
    permitsNewWorkers: mode === 'normal',
    localModelEnabled: false,
  };
}

export function modeRank(mode) {
  return ({ normal: 0, constrained: 1, paused: 2, emergency: 3 })[mode] ?? 3;
}

export const RESOURCE_GIB = GIB;
