---
name: coding
description: Careful software changes in a repository: inspect, plan, edit, run tests, review the diff, report exactly what changed. Use for fixing bugs, features, refactors, PR prep.
---
# Coding skill

1. **Inspect first**: list the tree, read README/config, `git log -5`, `git status`. Find the code by searching, not guessing.
2. **Reproduce**: run the failing test/command before changing anything; capture the exact error.
3. **Plan** in 3-6 bullets. Prefer the smallest change that fixes the root cause.
4. **Edit** with minimal diffs matching the surrounding style. Do not touch unrelated files.
5. **Verify**: run the specific test, then the whole suite. If something fails, analyse before retrying; never loop on the same fix more than twice.
6. **Review**: read `git diff` as a reviewer. Remove debug code. Check for secrets.
7. **Report**: what was wrong, what you changed (files), test results (exact commands + pass/fail), and anything you could not verify.

Rules: work only inside the working directory. Never run destructive commands (rm -rf outside the workspace, force pushes, dropping databases). Create a branch for changes; commit with a clear message only when asked to prepare a commit/PR.
