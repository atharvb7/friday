# Open-source contributions

Friday fixes one well-scoped issue a day in someone else's public repository and opens the pull request in your name,
only after you approve it. Code: `src/contrib.mjs` (pipeline), `src/patch.mjs` (diff policy + strict apply),
`src/contrib-verify.mjs` (test proof, no model), `src/github.mjs` (GitHub API, core only),
`skills/oss-contribution` (how the coding agent works), tools `oss_*` in `src/agent/friday-tools.mjs`.

## How a contribution happens

1. **Find**: GitHub search for open, unassigned issues labelled `good first issue` / `help wanted` with no linked PR, in
   Python, JavaScript or TypeScript (what the agent container can build and test).
2. **Vet the repository**: active in the last 60 days, recognised open-source licence, enough stars, not archived, not
   yours. Skipped when its contribution guide rules out AI-assisted work, needs a CLA/DCO sign-off (only you can sign),
   or wants contributors to claim/discuss an issue first. **Vet the issue**: enough detail, no blocking labels, nobody
   assigned, nobody saying "I'm working on it", no open PR referencing it, never attempted before.
3. **Fix**: a background coding job in workspace `oss-<repo>` with the `oss-contribution` skill. The job has **no GitHub
   tools or token** (the GitHub MCP is removed for `oss-*` workspaces). It reproduces the bug with a failing test, makes
   the smallest fix, and writes `friday-contrib/result.json` + `change.patch`. Giving up is a valid result.
4. **Policy** (`src/patch.mjs`): <= 8 files, <= 400 changed lines, a test for a fix, no CI/lockfile/licence/changelog
   edits, no renames/binaries, no credentials.
5. **Proof** (`src/contrib-verify.mjs`, in the agent container, no model): fresh clone at the exact upstream commit ->
   setup -> targeted test must FAIL -> `git apply` -> targeted test, full suite and linter must PASS. Only exit codes count.
   Commands run with bash; Python repos get a fresh, already-active venv (the agent's own venv/activate steps are dropped).
6. **Review**: a strict-maintainer model pass; the code requires verdict approve, score >= 8, no blocker/major problem.
7. Steps 4-6 failing send the exact failure back to the agent (max `max_rounds`, default 2), then the attempt is dropped
   and you get a one-line note. Nothing is posted.
8. **Approval card** (Inbox): PR title, body, the independent test results, the review score and the exact diff.
   Friday core applies the diff to the real upstream files itself (no fuzz), so what is committed is what you saw.
   The PR body says it was prepared with an AI coding agent and reviewed by you.
9. **Approve** -> fork (if needed) -> commit on a branch of your fork -> pull request. **Deny** with a note -> the note
   becomes a lesson for later jobs.
10. **Follow-up** every 30 minutes: CI failures, reviews and comments are sent to you; "address the review" prepares a
    follow-up commit + reply as another approval card. Merges and closes are reported; maintainer comments are kept as
    lessons and included in every later job.

**Features**: a feature an issue asks for goes through the same pipeline (`kind: feature`): the new test exercises the
new behaviour, so it must fail before and pass after. The PR says "Closes #N / What this adds". Unrequested features are
never sent as PRs.

## 24/7 with one approval a day

`continuous` (default on): the next job starts as soon as one ends, all day, up to `max_attempts_day` (24) jobs. Items
that pass every check wait (status `ready`). At `digest_at` (20:00, your time zone) ONE digest card lists them all, at
most `pr_cap` PRs (max 5) and `issue_cap` issues (2), one per repository. Drop any item from the card (Drop button, or
"drop X from the digest"); the card is replaced by one without it, so approving still posts exactly what is shown.
Approving schedules the items about 45 minutes apart; each is checked against what you approved right before it is
posted, never more than the daily caps and never two to the same repository on one day. An unanswered digest returns
its items for the next one; items older than 3 days are dropped as stale. Replies to maintainers (revisions) still get
their own card. Work stops while a full digest is already waiting. "Send the digest now" sends it early.

## Bug hunt (finding bugs nobody reported)

`mode` = `issues` (fix existing issues), `hunt`, or `mixed` (default: alternates day by day). A hunt picks an active repo
that welcomes contributors (or the one you name), reads what its docs promise, probes edge cases, and reports at most ONE
bug. Before any card: the code location it cites must exist at that commit, the one-line reproduction must fail in a
clean clone with the error text it quoted (no model), the issue must not already be reported, and a triage review must
call it a real bug with confidence >= 0.8 (not intended behaviour). The card is an **issue**, not a PR. When maintainers
confirm it (a label like `bug`/`confirmed`, or a maintainer comment saying so), Friday starts the fix automatically; the
PR still comes to you as a card. Declined reports become lessons. At most 3 of our bug reports wait on maintainers at once.

Friday never emails maintainers and never comments, pushes or opens anything without an approved card.

## Setup (server)

1. Create a GitHub **classic** personal access token with **only** the `public_repo` scope (Settings -> Developer
   settings -> Personal access tokens -> Tokens (classic)). Broader scopes (`repo`, `workflow`, `delete_repo`, `admin:*` ...)
   are refused.
2. In `~/friday/.env` on the server: add `FRIDAY_GITHUB_CONTRIB_TOKEN=<token>` and **remove** `GITHUB_TOKEN`. While
   `GITHUB_TOKEN` is set the coding agent has its own GitHub access, and Friday refuses to contribute (a prompt injection
   in an issue could otherwise act on GitHub without your approval).
3. Optional: `FRIDAY_DSH_TIMEOUT_MS=2700000` (45 min) so the agent has time to set up unfamiliar projects.
4. Restart, then tell Friday e.g. "turn on open-source contributions, Python and TypeScript, at 10:00" (`oss_setup`, needs
   approval). "Contribute to owner/repo issue 123" starts a specific one; "how are my contributions going?" = `oss_status`.

## Limits worth knowing

- One contribution in progress at a time; at most `max_open_prs` (default 3) waiting on you or maintainers.
- The model review is Nemotron reviewing Nemotron; the hard guarantees are the policy checks and the test proof. Read
  the diff on the card before approving.
- Repos needing services (databases, browsers, GPUs) or other languages will usually fail setup and be dropped.
