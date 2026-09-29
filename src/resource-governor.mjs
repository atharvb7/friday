import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { modeRank, readResources, RESOURCE_GIB } from './resources.mjs';

const G = RESOURCE_GIB;
const DEFAULTS = {
  // Enter thresholds are deliberately conservative because host-level OOMs
  // have already interrupted this laptop's browser sessions.
  enter: { constrained: 4 * G, paused: 2 * G, emergency: 1.25 * G },
  exit: { constrained: 4.75 * G, paused: 2.75 * G, emergency: 1.75 * G },
  psiEnter: { constrained: 3, paused: 10, emergency: 25 },
  psiExit: { constrained: 1.5, paused: 6, emergency: 18 },
  fullPsiEnter: { constrained: 0.5, paused: 2, emergency: 5 },
  fullPsiExit: { constrained: 0.25, paused: 1, emergency: 3 },
  cgroupRatioEnter: { constrained: 0.8, paused: 0.9, emergency: 0.98 },
  cgroupRatioExit: { constrained: 0.7, paused: 0.82, emergency: 0.92 },
  clearForMs: 30_000,
  telemetryMaxBytes: 1_000_000,
  sampleHistory: 120,
};

const WORKER_RULES = {
  interactive: { normal: true, constrained: true, paused: true, emergency: false, maxConcurrent: 1 },
  voice: { normal: true, constrained: true, paused: false, emergency: false, maxConcurrent: 1 },
  browser: { normal: true, constrained: false, paused: false, emergency: false, maxConcurrent: 1 },
  background: { normal: true, constrained: false, paused: false, emergency: false, maxConcurrent: 1 },
  subagent: { normal: true, constrained: false, paused: false, emergency: false, maxConcurrent: 1 },
  'local-model': { normal: false, constrained: false, paused: false, emergency: false, maxConcurrent: 0 },
};

function nextObservedMode(snapshot, thresholds) {
  let rank = 0;
  const available = snapshot.availableBytes ?? 0;
  const some = snapshot.pressureSomeAvg10 ?? 0;
  const full = snapshot.pressureFullAvg10 ?? 0;
  for (const [name, level] of [['constrained', 1], ['paused', 2], ['emergency', 3]]) {
    if (available < thresholds.enter[name] || some >= thresholds.psiEnter[name] || full >= thresholds.fullPsiEnter[name]) rank = Math.max(rank, level);
  }
  const cg = snapshot.cgroup;
  if (cg?.usageRatio !== null && cg?.usageRatio !== undefined) {
    for (const [name, level] of [['constrained', 1], ['paused', 2], ['emergency', 3]]) {
      if (cg.usageRatio >= thresholds.cgroupRatioEnter[name]) rank = Math.max(rank, level);
    }
  }
  if (cg?.currentBytes !== null && cg?.highBytes !== null && cg?.highBytes > 0 && cg.currentBytes >= cg.highBytes) rank = Math.max(rank, 2);
  if ((cg?.pressureSomeAvg10 ?? 0) >= 10 || (cg?.pressureFullAvg10 ?? 0) >= 2) rank = Math.max(rank, 2);
  return ['normal', 'constrained', 'paused', 'emergency'][rank];
}

function canClearTo(snapshot, mode, thresholds) {
  if (mode === 'normal') return snapshot.availableBytes >= thresholds.exit.constrained
    && snapshot.pressureSomeAvg10 < thresholds.psiExit.constrained
    && snapshot.pressureFullAvg10 < thresholds.fullPsiExit.constrained;
  const next = ({ emergency: 'paused', paused: 'constrained', constrained: 'normal' })[mode];
  const available = snapshot.availableBytes ?? 0;
  const some = snapshot.pressureSomeAvg10 ?? 0;
  const full = snapshot.pressureFullAvg10 ?? 0;
  let clear = available >= thresholds.exit[mode]
    && some < thresholds.psiExit[mode]
    && full < thresholds.fullPsiExit[mode];
  const cg = snapshot.cgroup;
  if (cg?.usageRatio !== null && cg?.usageRatio !== undefined) clear &&= cg.usageRatio < thresholds.cgroupRatioExit[mode];
  if (cg?.currentBytes !== null && cg?.highBytes !== null && cg?.highBytes > 0) clear &&= cg.currentBytes < cg.highBytes * 0.9;
  if (cg?.pressureSomeAvg10 >= 10 || cg?.pressureFullAvg10 >= 2) clear = false;
  return clear && Boolean(next);
}

export class ResourceGovernor {
  constructor({ readSnapshot = readResources, now = Date.now, telemetryPath = null, thresholds = {}, maxHistory, onPressureChange = null, sampleIntervalMs = 2_000 } = {}) {
    this.readSnapshot = readSnapshot;
    this.now = now;
    this.telemetryPath = telemetryPath;
    this.thresholds = {
      ...DEFAULTS,
      ...thresholds,
      enter: { ...DEFAULTS.enter, ...thresholds.enter },
      exit: { ...DEFAULTS.exit, ...thresholds.exit },
      psiEnter: { ...DEFAULTS.psiEnter, ...thresholds.psiEnter },
      psiExit: { ...DEFAULTS.psiExit, ...thresholds.psiExit },
      fullPsiEnter: { ...DEFAULTS.fullPsiEnter, ...thresholds.fullPsiEnter },
      fullPsiExit: { ...DEFAULTS.fullPsiExit, ...thresholds.fullPsiExit },
      cgroupRatioEnter: { ...DEFAULTS.cgroupRatioEnter, ...thresholds.cgroupRatioEnter },
      cgroupRatioExit: { ...DEFAULTS.cgroupRatioExit, ...thresholds.cgroupRatioExit },
    };
    this.historyLimit = maxHistory ?? this.thresholds.sampleHistory;
    this.onPressureChange = onPressureChange;
    this.sampleIntervalMs = sampleIntervalMs;
    this.mode = 'normal';
    this.clearSince = null;
    this.history = [];
    this.active = new Map();
    this.lastSnapshot = null;
    this.lastSampleAt = null;
  }

  sample() {
    const now = this.now();
    const snapshot = this.readSnapshot();
    const observed = nextObservedMode(snapshot, this.thresholds);
    const oldMode = this.mode;
    if (modeRank(observed) > modeRank(this.mode)) {
      this.mode = observed;
      this.clearSince = null;
    } else if (modeRank(observed) < modeRank(this.mode)) {
      if (canClearTo(snapshot, this.mode, this.thresholds)) {
        this.clearSince ??= now;
        if (now - this.clearSince >= this.thresholds.clearForMs) {
          const rank = Math.max(0, modeRank(this.mode) - 1);
          this.mode = ['normal', 'constrained', 'paused', 'emergency'][rank];
          this.clearSince = null;
        }
      } else this.clearSince = null;
    } else this.clearSince = null;

    const result = { ...snapshot, observedMode: observed, mode: this.mode, permitsNewWorkers: this.mode === 'normal' };
    this.lastSnapshot = result;
    this.lastSampleAt = now;
    this.history.push(result);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    this.#persist(result, oldMode);
    if (this.mode !== oldMode) this.onPressureChange?.({ previous: oldMode, current: this.mode, snapshot: result });
    return result;
  }

  getSnapshot() { return this.lastSnapshot ?? this.sample(); }

  canAdmit(workerClass, { maxConcurrent = null } = {}) {
    if (this.lastSampleAt === null || this.now() - this.lastSampleAt >= this.sampleIntervalMs) this.sample();
    const rule = WORKER_RULES[workerClass];
    if (!rule) return { allowed: false, reason: 'unknown_worker_class', mode: this.mode };
    if (!rule[this.mode]) return { allowed: false, reason: this.mode === 'emergency' ? 'memory_emergency' : 'memory_pressure', mode: this.mode };
    const cap = maxConcurrent ?? rule.maxConcurrent;
    const active = this.active.get(workerClass) ?? 0;
    if (active >= cap) return { allowed: false, reason: 'worker_class_limit', mode: this.mode, active, maxConcurrent: cap };
    if (workerClass === 'browser' && this.lastSnapshot?.availableBytes < 5 * G) {
      return { allowed: false, reason: 'browser_reserve_required', mode: this.mode };
    }
    if (workerClass === 'subagent' && this.lastSnapshot?.availableBytes < 6 * G) {
      return { allowed: false, reason: 'subagent_reserve_required', mode: this.mode };
    }
    return { allowed: true, reason: 'admitted', mode: this.mode, active, maxConcurrent: cap };
  }

  acquire(workerClass, options) {
    const admission = this.canAdmit(workerClass, options);
    if (!admission.allowed) return { ...admission, release() {} };
    this.active.set(workerClass, (this.active.get(workerClass) ?? 0) + 1);
    let released = false;
    return {
      ...admission,
      release: () => {
        if (released) return;
        released = true;
        const count = this.active.get(workerClass) ?? 0;
        if (count <= 1) this.active.delete(workerClass);
        else this.active.set(workerClass, count - 1);
      },
    };
  }

  pressureActions() {
    return {
      stopAdmitting: this.mode !== 'normal',
      cancelBackground: modeRank(this.mode) >= 1,
      cancelSubagents: modeRank(this.mode) >= 1,
      pauseBrowsers: modeRank(this.mode) >= 1,
      stopVoiceEnhancements: modeRank(this.mode) >= 2,
      localModelEnabled: false,
      emergencyTerminate: modeRank(this.mode) >= 3,
    };
  }

  #persist(snapshot, previousMode) {
    if (!this.telemetryPath) return;
    try {
      mkdirSync(dirname(this.telemetryPath), { recursive: true });
      try {
        if (statSync(this.telemetryPath).size >= this.thresholds.telemetryMaxBytes) {
          renameSync(this.telemetryPath, `${this.telemetryPath}.1`);
        }
      } catch {}
      appendFileSync(this.telemetryPath, `${JSON.stringify({ ...snapshot, previousMode })}\n`, { mode: 0o600 });
    } catch {
      // Telemetry is best effort and must never prevent task admission.
    }
  }
}

export const WORKER_CLASSES = Object.freeze(Object.keys(WORKER_RULES));
