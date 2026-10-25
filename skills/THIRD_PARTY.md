# Third-party skills

Vendored (pinned, reviewed, lightly edited for a generic coding agent — no Claude-Code-only tools, no subagents,
test material and maintainer files removed). Each folder keeps its upstream license file.

| Skill | Source (commit) | License |
|---|---|---|
| systematic-debugging, test-driven-development, writing-plans, verification-before-completion, receiving-code-review | github.com/obra/superpowers @ bb92a77741419a4ab5f06e711a283343f1ada0c3 | MIT |
| frontend-design | github.com/anthropics/skills @ dbd4588f9e1033efb41dad4bef2f7947c8993d44 | Apache-2.0 (LICENSE.txt) |
| react-best-practices, composition-patterns | github.com/vercel-labs/agent-skills @ 063bee94c3f4df8453406c830b0a7df0f2860278 | MIT (per upstream README/frontmatter) |
| supabase-postgres-best-practices | github.com/supabase/agent-skills @ c9be0e931b7930f7d02126d04774d904c381e7d7 | MIT |
| security-review | github.com/getsentry/skills @ d18b7aa8ba878354e5c348310230e652f7690f9c | CC BY-SA 4.0 — adapted (frontmatter tool list removed, note added); this folder stays under CC BY-SA 4.0 |
| api-design-principles | github.com/wshobson/agents @ 46891e7e60da0e52baf1050b7b6391b64e84c6d9 | MIT (insecure example template removed) |

Friday's own skills (coding, research, report-writing, competitive-analysis, daily-briefing, friday-deploy) are part of this repo.

## Business development (added 2026-10-25)

| Skill | Source (commit) | License |
|---|---|---|
| cold-email, prospecting, copywriting, marketing-psychology, offers, pricing, sales-enablement, product-marketing, competitor-profiling, revops | github.com/coreyhaines31/marketingskills @ e85f3cbc2e4a79bf33b2a12e9bdd9087d414735b | MIT (LICENSE in each folder). Edited: evals removed; the `.agents/product-marketing.md` context file is replaced by Friday's `business_profile` tool. |
| account-research, stakeholder-map, call-prep, call-summary, handle-objection, lead-triage | github.com/anthropics/knowledge-work-plugins (sales plugin) @ 33d3dea41a341b341d4f5da2e8801ae0c89be2b8 | Apache-2.0 (LICENSE in each folder). Modified: the generic connector/rendering rules block and "How it adapts" section removed; a Friday adaptation note maps CRM/email/enrichment to Friday's tools. |

`business-development` (the orchestrating skill, with references/plays.md and references/discovery-and-proposal.md) is Friday's own.
