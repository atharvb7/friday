// Sales judgments from JEV (TypeSafe System One): JEV answers small typed questions about a lead, a draft email or
// a reply; the code here turns those answers into decisions (truth tables below). All question wording lives in this
// file. JEV never sends or approves anything; when it is unavailable, callers fall back to their deterministic rules.
// Thresholds follow TypeSafe's guidance: a noul above 0.7 reads as yes, below 0.3 as no, between = not settled.

const YES = 0.7, NO = 0.3;
const clip = (s, n) => String(s ?? '').slice(0, n);

// ---- outreach review: one request per email (lead + gap + draft share the state) ----
export const OUTREACH_QUESTIONS = {
  sells_software: { type: 'noul', instructions: 'Is selling software, AI, automation, chatbots, or IT/software development services the main business of the company in `lead`?',
    criteria: { true: 'The company\'s product or service is software, an AI/automation product, or software development', false: 'The company sells a non-software product or service, such as logistics, legal, accounting, healthcare, retail or real estate, even if it uses software' } },
  gap_specific: { type: 'score', instructions: 'How specific and evidenced is the problem described in `lead.gap`?',
    criteria: ['No real problem is described, only a generic statement about the company', 'A plausible but generic problem that could apply to most companies', 'A specific manual process at this company, without evidence', 'A specific manual process at this company, backed by something seen on their site, reviews or posts'] },
  offer_fits_gap: { type: 'noul', instructions: 'Would `offer` directly fix the problem described in `lead.gap`?',
    criteria: { true: 'The offer addresses that exact problem', false: 'The offer is unrelated to that problem or only loosely connected' } },
  opener_specific: { type: 'noul', instructions: 'Does the first sentence of `email.body` mention something specific to the company in `lead`?',
    criteria: { true: 'The first sentence refers to a concrete fact about this company (a process, a review, a post, a branch, a hire)', false: 'The first sentence is generic and would fit any company, or is about the sender' } },
  lists_services: { type: 'noul', instructions: 'Does `email.body` list several services, features or technologies the sender offers?',
    criteria: { true: 'It lists several separate things the sender sells (for example lead qualification, document pipelines, websites) or names the sender\'s tech stack', false: 'It describes one offer in plain words; naming the client\'s own tools where the system would run (their email, sheets, CRM, phones) is part of that one offer, not a list of services' } },
  mentions_price: { type: 'noul', instructions: 'Does `email.body` state a price, fee, rate or package cost for the sender\'s work?',
    criteria: { true: 'An amount of money or a pricing model for the work appears (for example "$2,000", "starts at", "per month")', false: 'No amount or pricing model appears; saying a plan or teardown is free or has no cost is not a price' } },
  mixes_offers: { type: 'noul', instructions: 'Does `email.body` pitch more than one kind of offer (for example automation and also website development)?' },
  unsupported_claims: { type: 'noul', instructions: 'Does `email.body` state a fact or number about the company in `lead` that `lead` does not support?',
    criteria: { true: 'The email asserts something specific about the company (a volume, a process, hours worked, a problem) that does not appear in `lead`', false: 'Every statement about the company appears in `lead`, or the email only describes what usually happens in businesses like theirs' } },
  fabricated_proof: { type: 'noul', instructions: 'Does `email.body` claim a past result, client or achievement for the sender that is not listed in `proof`?',
    criteria: { true: 'The email says the sender helped, built, saved or achieved something (often with numbers) for a client, and `proof` does not list it', false: 'Every statement about the sender\'s past work matches `proof`, or the email makes no claim about past work' } },
  sounds_low_level: { type: 'noul', instructions: 'Does `email.body` describe the sender\'s own work as small tasks or simple tools rather than engineered AI systems?',
    criteria: { true: 'The sender presents their work as things like updating spreadsheets, sending WhatsApp or chat messages, simple bots, Zapier/n8n flows or admin help', false: 'The sender presents their work as designing and running production AI agent systems for a business' } },
  asks_one_easy_thing: { type: 'noul', instructions: 'Does `email.body` end with a single question that can be answered with a short reply?',
    criteria: { true: 'One clear, low-effort question such as "Want me to send it?"', false: 'No question, several asks, or it asks for a long meeting' } },
};

// Truth table for one email. Hard blocks stop the batch; holds ask Friday to improve the email first.
export function judgeOutreach(answers) {
  const n = (k) => answers?.[k]?.noul;
  const s = answers?.gap_specific?.score;
  const problems = [];
  if (n('sells_software') >= YES) problems.push({ block: true, why: 'the company sells software/AI/automation itself (competitor or has engineers): drop this lead' });
  if (typeof s === 'number' && s < 1.5) problems.push({ block: true, why: 'no specific, evidenced gap at this company: research it more or drop it' });
  if (n('offer_fits_gap') <= NO) problems.push({ block: true, why: 'the offer does not fix the gap described: pick the right offer or drop the lead' });
  if (n('opener_specific') <= NO) problems.push({ why: 'the first sentence is generic: open with the specific thing you saw at this company' });
  if (n('lists_services') >= YES) problems.push({ why: 'it lists services/technologies: describe one end-to-end outcome instead' });
  if (n('mentions_price') >= YES) problems.push({ why: 'it mentions pricing: remove it (pricing comes after a call)' });
  if (n('mixes_offers') >= YES) problems.push({ why: 'it pitches more than one offer: keep one' });
  if (n('fabricated_proof') >= YES) problems.push({ why: 'it claims a past result or client that is not in your Proof list: remove it and use a real proof line from the profile (never invent results)' });
  if (n('unsupported_claims') >= YES) problems.push({ why: 'it states facts or numbers about them that your research does not show (e.g. invented volumes or hours): say only what you saw, or frame it as what usually happens' });
  if (n('sounds_low_level') >= YES) problems.push({ why: 'it positions the work as small tasks/simple tools: present Atharv as a forward-deployed AI engineer who builds production agentic systems' });
  if (n('asks_one_easy_thing') <= NO) problems.push({ why: 'it does not end with one easy question: end with a one-line ask' });
  return { ok: problems.length === 0, problems };
}

// ---- qualification: should we pitch this company at all? (before any email is written) ----
export const QUALIFY_QUESTIONS = {
  sells_software: OUTREACH_QUESTIONS.sells_software,
  gap_specific: OUTREACH_QUESTIONS.gap_specific,
  offer_fits_gap: OUTREACH_QUESTIONS.offer_fits_gap,
  operations_heavy: { type: 'noul', instructions: 'Does the business in `lead` handle a steady volume of repeated operational work (customer requests, orders, bookings, documents or quotes)?',
    criteria: { true: 'The business processes many similar requests or transactions as part of daily operations', false: 'The business does few, bespoke engagements or has little repeated operational work' } },
};
// Truth table: hard disqualify, qualify, or hold (worth a look by a person / more research).
export function judgeQualify(answers) {
  const n = (k) => answers?.[k]?.noul; const gap = answers?.gap_specific?.score;
  if (n('sells_software') >= YES) return { verdict: 'skip', why: 'sells software/AI/automation itself (competitor or in-house engineers)' };
  if (typeof gap === 'number' && gap < 1.5) return { verdict: 'skip', why: 'no specific, evidenced operational gap found' };
  if (n('offer_fits_gap') <= NO) return { verdict: 'skip', why: 'our offer does not fit the gap found' };
  if (n('operations_heavy') <= NO) return { verdict: 'skip', why: 'little repeated operational work to automate' };
  if (gap >= 2 && n('offer_fits_gap') >= YES) return { verdict: 'qualify', why: 'specific evidenced gap that our offer fits', gap };
  return { verdict: 'hold', why: 'possible fit, evidence not strong enough yet', gap };
}

// ---- reply classification ----
export const REPLY_CATEGORIES = {
  positive: 'They are interested and want to talk, see the plan, or move forward',
  question: 'They ask a question (price, how it works, examples) without saying yes or no yet',
  objection: 'They push back (already have a solution, no budget, not a priority) without asking to stop',
  not_now: 'They say to reach out later or give a later time',
  referral: 'They point to someone else who handles this',
  stop: 'They ask not to be contacted again, say no, or are hostile',
  out_of_office: 'An automatic away or out-of-office message',
};
export const REPLY_QUESTIONS = {
  category: { type: 'choice', instructions: 'What kind of reply is `reply.text` to our email `our_email`?', criteria: REPLY_CATEGORIES },
  asks_to_stop: { type: 'noul', instructions: 'Does the sender of `reply.text` ask us to stop contacting them or say they are not interested?' },
  out_of_office: { type: 'noul', instructions: 'Is `reply.text` an automatic out-of-office or away message?' },
  wants_meeting: { type: 'noul', instructions: 'Does the sender of `reply.text` agree to or ask for a call or meeting?' },
};
export function judgeReply(answers) {
  const n = (k) => answers?.[k]?.noul;
  const category = answers?.category?.choice ?? null;
  if (n('asks_to_stop') >= YES) return { action: 'stop', category: category ?? 'stop' };
  if (n('out_of_office') >= YES) return { action: 'pause', category: 'out_of_office' };
  return { action: 'human', category, meeting: n('wants_meeting') >= YES, unsettled: !category || (n('asks_to_stop') > NO && n('asks_to_stop') < YES) };
}

export class SalesJudge {
  constructor({ jev = null }) { this.jev = jev; }
  get ready() { return Boolean(this.jev?.configured); }

  // emails: [{ lead, offer, subject, body }] -> per-email verdicts. Throws if JEV fails (callers decide the fallback).
  async reviewOutreach(items) {
    return Promise.all(items.map(async (it) => {
      const state = {
        lead: { company: clip(it.lead?.company, 200), website: clip(it.lead?.website, 200), what_they_do: clip(it.lead?.research, 1500), gap: clip(it.lead?.signal || it.lead?.research, 1500) },
        offer: clip(it.offer, 300),
        proof: clip(it.proof, 3000),
        email: { subject: clip(it.subject, 200), body: clip(it.body, 3000) },
      };
      const { answers } = await this.jev.decide({ state, questions: OUTREACH_QUESTIONS });
      return { to: it.to, company: it.lead?.company ?? null, ...judgeOutreach(answers) };
    }));
  }

  // An email without a lead (e.g. a test to the user, or a reply in a thread): style, proof and positioning only.
  async reviewMessage({ subject, body, proof, firstTouch = true }) {
    const keys = ['fabricated_proof', 'sounds_low_level', 'lists_services', 'mentions_price', 'mixes_offers', ...(firstTouch ? ['asks_one_easy_thing'] : [])];
    const { answers } = await this.jev.decide({ state: { proof: clip(proof, 3000), email: { subject: clip(subject, 200), body: clip(body, 3000) } }, questions: Object.fromEntries(keys.map((k) => [k, OUTREACH_QUESTIONS[k]])) });
    return judgeOutreach(answers);
  }

  async qualify({ lead, offer }) {
    const { answers } = await this.jev.decide({ state: { lead: { company: clip(lead.company, 200), website: clip(lead.website, 200), what_they_do: clip(lead.what_they_do, 1500), gap: clip(lead.gap, 2000) }, offer: clip(offer, 300) }, questions: QUALIFY_QUESTIONS });
    return judgeQualify(answers);
  }

  async classifyReply({ ourSubject, replyText }) {
    const { answers } = await this.jev.decide({ state: { our_email: clip(ourSubject, 200), reply: { text: clip(replyText, 4000) } }, questions: REPLY_QUESTIONS });
    return judgeReply(answers);
  }
}
