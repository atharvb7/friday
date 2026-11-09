# Would a maintainer merge this? (check every line before writing result.json)

Correctness
- [ ] It fixes the ROOT cause the issue describes, not a symptom (e.g. a guard in the caller when the callee is wrong).
- [ ] Edge cases next to the bug are handled the same way (empty, None/undefined, zero, unicode, Windows paths) — only
      where the issue's scenario reaches them.
- [ ] No behaviour change for inputs the issue does not mention. Public APIs, signatures and defaults are unchanged.
- [ ] The new test fails on the original commit for the RIGHT reason (read the failure message), and passes now.
- [ ] The whole suite passes. Nothing was skipped, xfailed, deleted or loosened.

Fit
- [ ] Same style as the file: naming, quotes, imports order, typing, docstring format, error types, log style.
- [ ] Test lives where similar tests live and uses the same helpers/fixtures.
- [ ] No unrelated whitespace, formatting or import changes. `git diff --stat` shows only files that had to change.
- [ ] No new dependency, no version bump, no CI/lockfile/licence edits.
- [ ] Comments only where the code would otherwise surprise a reader; no commented-out code, no debug output.

Communication
- [ ] Title says what changes, in the project's convention, < 72 chars.
- [ ] Summary explains the cause in plain words a maintainer can verify in 30 seconds.
- [ ] Nothing claimed that was not observed. No "comprehensive", "robust", "seamless" or similar filler.

If any box cannot be ticked honestly: fix it, or give up with the reason.
