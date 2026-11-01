# Discovery, scoping, proposal

## Discovery call (30 min) - the user talks, the prospect talks more

1. **Context (2 min):** confirm what you know; ask what made them reply now.
2. **Current process:** "Walk me through what happens today when [a call comes in / a lead fills the form / an order
   lands]." Get steps, tools, people, volumes.
3. **Pain in numbers:** how many per week, how long each, what gets missed, what one missed one is worth.
   (Calls/week x miss rate x conversion x deal value = monthly leak.)
4. **Tried before:** tools, agencies, in-house attempts, and why they stopped.
5. **Success:** "In 3 months, what would make this a clear win?" Get a measurable outcome.
6. **Decision:** who else decides, budget range, timeline, procurement/security needs.
7. **Next step:** agree a dated next step on the call (proposal by X, demo on Y).

Prep with `call-prep`; after the call run `call-summary`, then `lead_update` with notes, stage and next step.

## Scoping rules

- Start with ONE workflow that has clear volume and value (a pilot), not a platform.
- Write what is out of scope. Name the assumptions (volumes, integrations, languages, access needed).
- Identify their dependencies: API access, phone number/telephony, data, a person who answers questions.
- Risks for AI work: accuracy on edge cases, handoff to humans, data privacy, call recording consent. Address them up front.

## Pricing patterns for our services (use the actual numbers in the business profile)

- **Pilot / setup fee + monthly retainer** (AI agents, voice agents): setup covers build and integration; the retainer
  covers hosting, monitoring, improvements and usage within a stated limit; usage above it is billed per minute or per conversation.
- **Fixed-price project** (automation, freelance builds): milestones with acceptance criteria; 30-50% upfront.
- **Value anchor:** compare to the leak or the hire it replaces (a receptionist's or SDR's monthly cost), never to "hours of coding".
- Offer 2-3 options (pilot / standard / scale); most buyers pick the middle. Load `pricing` and `offers` for depth.

## Proposal structure (create with `document_create`)

1. Their situation in their words (from discovery).
2. The outcome and how we'll measure it.
3. The solution: what we build, how it works for them (one simple diagram or flow).
4. Scope, out of scope, assumptions, what we need from them.
5. Timeline with milestones.
6. Investment: options, payment terms, what the retainer includes.
7. Proof: 1-2 relevant projects or a demo link from the profile.
8. Next step with a date ("reply 'go' and we start Monday").

Send the proposal through `email_send` (approval), set `lead_update` stage proposal with next_at in 3 business days,
and follow up with a useful nudge, not "any update?".
