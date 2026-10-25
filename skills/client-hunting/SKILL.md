---
name: client-hunting
description: Find, study and shortlist the right companies to pitch (automation, freelance dev, Friday) - pick non-tech businesses that cannot build it themselves, audit each one for a real operational gap, score fit, find the decision maker and a real email, and decide who gets what message. Use for "find me clients", "find candidates", "who should I email", "shortlist companies", "prospect for me".
---

# Client hunting

The goal is not a list of companies. It is a short list of businesses where we can point at a specific, costly gap,
we are clearly the right people to fix it, and we can reach the person who decides. Five of those beat fifty names.

Read the business profile first (`business_profile`). Use `prospecting` (and its references local-prospecting,
account-research, sourcing-and-enrichment) for craft; this skill decides WHO and WHY.

## Rule 1: sell to businesses that cannot build this themselves

Our buyer runs an operations-heavy business, not a tech company. They have real, repetitive work (customers,
orders, documents, scheduling, follow-ups, reporting) and no engineering team to automate it.

**Hard disqualify (skip immediately, note the reason):**
- Anyone whose product is software, AI, automation, agents, chatbots, voice AI, data/ML, dev tools, or IT services.
  They are competitors or have in-house engineers. (This includes "AI startups", "agentic platforms", SaaS companies,
  dev shops, digital agencies that sell development, and anything YC/tech-funded whose team is mostly engineers.)
- Companies with a visible in-house engineering team (careers page full of engineering roles, engineering blog).
- Enterprises that buy through procurement; one-person businesses with no budget.
- Ahum Labs' clients/competitors (see profile), existing clients, do-not-contact.

**Exception (freelance development offer only):** non-technical founders and businesses that need a product built
(no CTO, idea-stage or outdated site/app). Still never pitch dev work to a company that sells dev work.

## Rule 2: hunt where the manual work lives

Good verticals for automation (pick 1–2 per batch, rotate, keep what replies):
- Logistics, freight forwarding, courier and transport (quotes, shipment updates, documents, tracking calls)
- Real estate brokerages and property management (lead follow-up, site-visit scheduling, rent/maintenance requests)
- Accounting, CA, tax and bookkeeping firms (document collection, reminders, data entry, compliance deadlines)
- Law firms and immigration/visa consultants (intake, document checklists, case status updates)
- Insurance brokers and loan/mortgage agents (lead qualification, document collection, renewals)
- Clinics, diagnostics labs and multi-location healthcare (booking calls, reports delivery, reminders)
- Education: coaching institutes, study-abroad consultants, training companies (enquiries, counselling follow-up)
- Travel agencies and tour operators (enquiries, itineraries, bookings, payments follow-up)
- D2C / e-commerce brands (order status queries, returns, supplier follow-ups, reporting)
- Distributors, wholesalers, manufacturers (order intake from email/PDF, invoicing, stock updates)
- Marketing/creative agencies (client reporting, onboarding, content ops) - they sell services, not software, so OK
- Hospitality, events, interiors and construction firms (quotes, scheduling, vendor coordination)

Markets: India and international (US, UK, EU, Middle East, Australia, Singapore). Match the time zone in the email.

**Where to find them (not only job boards):** Google search and Maps by category + city
("freight forwarder Dubai", "property management company Austin"), industry directories and associations, review sites
(Google reviews, Trustpilot, Yelp, Justdial, IndiaMART), Shopify/D2C brand lists, local business news, "top N" lists,
LinkedIn company search (public pages only, no scraping), the company's own site. Job posts are ONE signal, not the source.

## Rule 3: stalk the business, find the gap (the audit)

For each candidate, spend real effort (5-10 minutes of reading) before deciding. Use `web_fetch` on their site
(home, services, contact, about/team, careers) and `web_search` for reviews and news. Answer:

1. **What do they sell, to whom, and how big are they?** (team size, locations, years, volume hints)
2. **How does a customer come in?** (form, phone, WhatsApp, email, walk-in, marketplace) **What happens after?**
   Look for: "fill this form and we'll call you", "email us your documents", phone-only booking, PDF forms, "response
   within 48 hours", manual quote requests, order status by email/phone.
3. **Where is the repetitive work?** quotes, scheduling, document collection, status updates, follow-ups, data entry
   between systems, reporting, invoicing, call handling.
4. **What do customers complain about?** reviews mentioning slow replies, no callback, lost documents, wrong orders,
   "couldn't reach anyone". Quote the review (short) as evidence.
5. **How technical are they?** (no devs = good; basic site/forms = good; heavy in-house tech = disqualify)
6. **Growth or trigger:** new location, new service, hiring ops/admin/customer-service roles, funding, expansion.

Write the result as a **gap hypothesis**: "<Company> handles <process> by <manual way>; evidence: <what you saw +
source URL>. That likely costs them <time/leads/customers>. We would automate it by <one system, in plain words>."
If you cannot write a specific, evidenced gap, the company is not ready: skip it.

## Rule 4: score before you write

Score 1-5 each, with one line of evidence:
- **Gap clarity** - is the manual pain visible and specific?
- **Value** - does fixing it save real money/time or win customers? (volume x value)
- **Fit** - is it squarely our offer (automation / dev / Friday) and not something they'd build themselves?
- **Ability to pay** - real business with revenue (team, locations, years, clients)?
- **Reachability** - can we identify the decision maker and a working email?

Pitch only if total >= 18 and no score below 3. Fit P0 = 22+, P1 = 18-21. Everything else: skip and note why
(the skip notes teach us which segments work). Save qualified ones with `lead_save` (research = the audit + gap
hypothesis + scores, signal = the evidence WITH the URL where you saw it, offer = which offer). Outreach is refused
for a lead without an evidence URL. Industry stereotypes ("CA firms chase documents") are not evidence: point to
this company's page, review or post. Never set stage contacted yourself (it is set when an email really goes out).

## Rule 5: find the right person and a real email

- **Who:** the person who owns the problem and the budget. Small firms (<30 people): founder/owner/managing partner/
  director. Larger: COO, head of operations, operations manager, head of customer service. Not HR, not interns,
  not a generic "team" unless nothing else exists.
- **Where:** their About/Team page, founder interviews, press, the company's LinkedIn page (public view), podcasts,
  directory listings, the site's contact page, WHOIS-free sources like their blog author pages.
- **Email, in this order:**
  1. A personal work email published by the company or the person (site, press release, directory, signature in a
     public document).
  2. A published role address that the decision maker reads at a small firm (info@, hello@, contact@, office@):
     acceptable for businesses under ~30 people. Address the owner by name in the first line.
  3. No email found: save the lead with next_action "find contact" and suggest the LinkedIn message for the user to
     send personally. Do NOT guess patterns (firstname@domain) and do not use personal addresses; guessed addresses
     bounce and burn the sending account.
- Record where the email came from in `source`.
- `contact_name` is a real person's name or empty. A role ("Operations Head") goes in `role`; then greet
  "Hi {Company} team", never "Hi Operations Head".

## Rule 6: decide what to say (match message to gap)

- Pick the offer that fixes THEIR gap (usually FDE automation; freelance dev for build needs; Friday for owner-run
  firms drowning in admin).
- Use the matching template in the profile's Messaging section. Line one is the gap evidence, in their world's words.
- The give must be about their gap: "a one-page plan for automating your quote requests", not a generic call.

## Persuasion that works (and stays honest)

Use real levers, never tricks:
- **Specificity** - proof you studied them (the exact process, the exact review) is the strongest hook there is.
- **Reciprocity** - give something useful first (the free one-page plan, a teardown, a tiny demo).
- **Loss framing with true numbers** - what the gap costs them now (missed calls, slow replies, hours), only from evidence.
- **Social proof** - one real proof line from the profile.
- **Low-friction yes** - a one-word reply ("Want it?"), no meeting in the first email.
- **Relevance timing** - tie to their trigger (new branch, hiring, season).
Never: fake urgency or scarcity, pretending to be a customer, fake "Re:" subjects, invented mutual connections,
invented numbers or clients, pressure after a no. These get the domain blacklisted and the user's name burned.

## Output to the user (shortlist)

For each pitched company: name + site, what they do (one line), the gap hypothesis with evidence link, scores and
total, decision maker + email source, the offer, and the drafted email. Then a short "skipped" list with reasons
(e.g. "Vela - builds AI agents, competitor"). Ask for one approval to send the batch (`outreach_send`), unless the user
asked to review drafts first.

## Running it at scale

A proper audit needs several page reads per company, more than one chat turn allows. For more than 2 companies,
queue `research_start` (tell the user it's running and roughly what you're hunting) with: the vertical + market, "follow the client-hunting skill (load
it)", and the required output table (company, site, what they do, gap hypothesis, evidence URLs, scores, decision
maker, email + source, offer, skip reason). When the report arrives, save qualified rows with one `lead_save` call and
draft emails only for P0/P1.
