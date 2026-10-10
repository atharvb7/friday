// src/jev.mjs — JEV by TypeSafe AI (System One classification model) for Friday.
// JEV returns typed decisions, not text: choice (up to 255 labels), score
// (ordered scale), noul (yes/no probability), each with calibrated confidence,
// in ~70-500ms at ~$0.001/decision. Friday uses it as the fast deterministic
// router: intent classification, risk scoring, approval gating — WITHOUT an LLM
// round-trip. JEV output is untrusted routing advice; the policy layer (effects,
// governor, leases) still owns authority. Never grants permission by itself.
//
// Endpoints (same shape): POST https://jevtypesafeai.com/api/v1/decide (jv_live_)
// or POST https://api.typesafe.ai/v1/systemone (official). Pinned default
// model jev-1.13.0 so thresholds don't drift. Key from FRIDAY_JEV_KEY only,
// never logged. Offline/no-key → local keyword fallback with LOW confidence
// that fails closed (unknown / needs review).
const PINNED_MODEL = 'jev-1.13.0';
const HOSTED_URL = 'https://jevtypesafeai.com/api/v1/decide';
const OFFICIAL_URL = 'https://api.typesafe.ai/v1/systemone';

export const INTENT_LABELS = Object.freeze({
  file_search: 'Find or list files',
  file_read: 'Read a file',
  research: 'Research a topic with sources',
  coding: 'Write or fix code',
  browser: 'Use a website',
  desktop: 'Control a desktop app',
  memory: 'Remember or recall something',
  schedule: 'Schedule or remind later',
  automation: 'Set up a recurring automation',
  voice: 'Voice interaction',
  chitchat: 'General chat',
  unknown: 'Unclear — needs clarification',
});

export const TOOL_FOR_INTENT = Object.freeze({
  file_search: 'file.search', file_read: 'file.read', research: 'research.record',
  coding: 'codework', browser: 'browser', desktop: 'desktop',
  memory: 'memory', schedule: 'scheduler', automation: 'automation',
  voice: 'voice', chitchat: null, unknown: null,
});

// Local keyword fallback: deliberately low confidence, fails closed.
export function classifyIntentLocal(text) {
  const t = String(text ?? '').toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));
  if (has('find', 'search', 'locate', 'where is', 'list files')) return { intent: 'file_search', confidence: 0.45 };
  if (has('read', 'open file', 'show me the file', 'cat ')) return { intent: 'file_read', confidence: 0.45 };
  if (has('research', 'sources', 'investigate', 'compare', 'what is', 'explain')) return { intent: 'research', confidence: 0.4 };
  if (has('code', 'fix', 'bug', 'implement', 'refactor', 'test', 'commit', 'diff')) return { intent: 'coding', confidence: 0.45 };
  if (has('website', 'browse', 'whatsapp', 'send', 'login', 'click', 'web')) return { intent: 'browser', confidence: 0.4 };
  if (has('open app', 'desktop', 'window', 'click', 'type into')) return { intent: 'desktop', confidence: 0.35 };
  if (has('remember', 'recall', 'forget', 'my preference', 'my name')) return { intent: 'memory', confidence: 0.5 };
  if (has('remind', 'schedule', 'later', 'at 7', 'tomorrow', 'cron')) return { intent: 'schedule', confidence: 0.5 };
  if (has('every day', 'automate', 'whenever', 'watch')) return { intent: 'automation', confidence: 0.4 };
  if (has('hello', 'hi', 'thanks', 'joke')) return { intent: 'chitchat', confidence: 0.5 };
  return { intent: 'unknown', confidence: 0.3 };
}

export function assessRiskLocal(text) {
  const t = String(text ?? '').toLowerCase();
  const consequential = ['send', 'post', 'publish', 'buy', 'purchase', 'delete', 'rm ', 'format', 'pay', 'transfer', 'whatsapp'];
  const hit = consequential.some((w) => t.includes(w));
  return { riskScore: hit ? 4 : 1, needsApproval: hit, confidence: 0.5 };
}

function questionsFor(text) {
  void text;
  return {
    intent: {
      type: 'choice', instructions: 'What does the user want Friday to do?',
      criteria: { ...INTENT_LABELS },
    },
    risk: {
      type: 'score', instructions: 'How consequential/risky is acting on this now?',
      criteria: ['harmless read-only', 'minor local change', 'reversible share', 'hard-to-reverse send/post', 'destructive or financial'],
    },
    needsApproval: { type: 'boolean', instructions: 'Would a careful assistant ask for explicit approval before acting?' },
    urgency: {
      type: 'score', instructions: 'How urgent is this?',
      criteria: ['whenever', 'today', 'soon', 'now'],
    },
  };
}

export class JevClient {
  constructor({ apiKey = null, endpoint = null, model = PINNED_MODEL, timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey ?? process.env.FRIDAY_JEV_KEY ?? null;
    this.endpoint = endpoint ?? (this.apiKey?.startsWith('jv_live_') ? HOSTED_URL : OFFICIAL_URL);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  get configured() { return typeof this.apiKey === 'string' && this.apiKey.length > 8; }

  async decide({ state, questions }) {
    if (!this.configured) throw new Error('jev_not_configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('jev_timeout')), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, state, questions }),
      });
      if (!res.ok) throw new Error(`jev_http_${res.status}`);
      const data = await res.json();
      return { answers: data.answers ?? {}, confidence: data.confidence ?? {}, model: data.model ?? this.model, source: 'jev' };
    } finally { clearTimeout(timer); }
  }

  // One batched call: intent choice + risk score + approval noul + urgency.
  // Falls back locally (low confidence, fail-closed) when unconfigured/offline.
  async routeInstruction(instruction) {
    const text = String(instruction ?? '');
    if (!text.trim()) throw new TypeError('instruction required');
    if (!this.configured) {
      const { intent, confidence } = classifyIntentLocal(text);
      const risk = assessRiskLocal(text);
      return {
        intent, intentConfidence: confidence, riskScore: risk.riskScore,
        needsApproval: risk.needsApproval || intent === 'unknown',
        urgency: 1, source: 'local-fallback', tool: TOOL_FOR_INTENT[intent] ?? null,
      };
    }
    try {
      const { answers, confidence } = await this.decide({ state: { instruction: text }, questions: questionsFor(text) });
      const intent = answers.intent?.choice && INTENT_LABELS[answers.intent.choice] ? answers.intent.choice : 'unknown';
      const intentConfidence = confidence.intent ?? answers.intent?.confidence ?? 0.5;
      const riskScore = Math.round(answers.risk?.score ?? 1);
      const needsApproval = (answers.needsApproval?.probability ?? 0) >= 0.5 || intent === 'unknown' || riskScore >= 3;
      // Fail closed on low confidence: unknown + approval.
      if (intentConfidence < 0.6) return { intent: 'unknown', intentConfidence, riskScore, needsApproval: true, urgency: 1, source: 'jev', tool: null };
      return { intent, intentConfidence, riskScore, needsApproval, urgency: Math.round(answers.urgency?.score ?? 1), source: 'jev', tool: TOOL_FOR_INTENT[intent] ?? null };
    } catch {
      const { intent, confidence } = classifyIntentLocal(text);
      const risk = assessRiskLocal(text);
      return { intent, intentConfidence: Math.min(confidence, 0.4), riskScore: risk.riskScore, needsApproval: true, urgency: 1, source: 'local-fallback', tool: null };
    }
  }
}
