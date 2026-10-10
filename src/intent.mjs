// src/intent.mjs — Friday's built-in intent + risk classifier. Zero network,
// zero dependencies, deterministic. Used for chat routing while JEV stays
// disconnected (JEV requires FRIDAY_JEV_ENABLED=1 to be called at all).
//
// Split design: INTENT (what the user wants) is separate from RISK (whether
// acting needs approval). "Send me the file" is file_read, safe; "send X to
// Rohan on WhatsApp" is a consequential outbound act. Only the second lectures.

const INTENT_PATTERNS = [
  ['memory', /\bremember\b|\brecall\b|\bforget\b|\bmy (name|preference|dog|cat|sister|brother|bike|dog's|birthday)\b|\bwhat do you remember\b/i],
  ['file_search', /\bfind\b|\bsearch\b|\blocate\b|\bwhere is\b|\blist (files|.*files)\b|\bshow me (my |the )?files\b/i],
  ['file_read', /\bread\b|\bopen (the )?file\b|\bshow me the file\b|\bcat \b|\bcontents of\b/i],
  ['schedule', /\bremind\b|\bschedule\b|\blater\b|\btomorrow\b|\bat \d|\bin \d+ (min|hour)/i],
  ['automation', /\bevery day\b|\bautomate\b|\bwhenever\b|\bwatch (for|my)\b/i],
  ['coding', /\bcode\b|\bfix\b|\bbug\b|\bimplement\b|\brefactor\b|\bcommit\b|\bdiff\b|\bwrite (a|me|the) (function|script|program|test)/i],
  ['research', /\bresearch\b|\bsources\b|\binvestigate\b|\bcompare\b|\bwhat is\b|\bexplain\b|\bwho is\b|\bwhy (is|do|does)\b/i],
  ['browser', /\bwebsite\b|\bbrowse\b|\bwhatsapp\b|\bopen .*\.com\b|\blogin\b|\bgoogle\b/i],
  ['desktop', /\bopen (the )?app\b|\bdesktop\b|\bwindow\b|\bclick\b|\btype into\b/i],
  ['voice', /\bcall\b|\bvoice\b|\bspeak\b/i],
  ['chitchat', /\b(hi+|hey+|hello+|yo+|sup|howdy|namaste|good\s?(morning|evening|afternoon)|how('s| is) it going|how are you|who are you|what can you do|thanks|thank you|please|okay|ok\b|cool|nice|haha|lol|bye|good ?night)\b/i],
];

// Consequential = outbound to someone else, publishing, money, destruction.
// "Send me X" (me = the user, in-chat) is NOT consequential.
const DESTRUCTIVE_RE = /\b(delete|rm\s+-rf|format|pay|buy|purchase|transfer|wire money)\b/i;
const OUTBOUND_RE = /\b(send|post|publish|share|tweet|forward)\b/i;
const EXTERNAL_TARGET_RE = /\bto\s+[A-Z][a-z]+|\bto\s+(him|her|them|mom|dad|my|the team|everyone)\b|\bon\s+whatsapp\b|\btweet\b|\bpost\s+(it|this|that)\s+to\b/i;

export function assessRisk(text) {
  const t = String(text ?? '');
  if (DESTRUCTIVE_RE.test(t)) return { riskScore: 5, needsApproval: true };
  if (OUTBOUND_RE.test(t) && EXTERNAL_TARGET_RE.test(t)) {
    return { riskScore: 4, needsApproval: true };
  }
  return { riskScore: 1, needsApproval: false };
}

export function classifyIntent(text) {
  const t = String(text ?? '');
  for (const [intent, re] of INTENT_PATTERNS) {
    if (re.test(t)) return intent;
  }
  return 'unknown';
}

// Full route object shaped like the JEV router output (drop-in).
export function classifyLocal(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new TypeError('instruction required');
  const intent = classifyIntent(t);
  const risk = assessRisk(t);
  const needsApproval = risk.needsApproval || intent === 'unknown' || intent === 'desktop' || intent === 'browser';
  return {
    intent,
    intentConfidence: 0.55,
    riskScore: risk.riskScore,
    needsApproval,
    urgency: 1,
    source: 'local',
    tool: null,
  };
}
