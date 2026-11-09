import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { EventBus } from '../src/events.mjs';
import { Approvals } from '../src/approvals.mjs';
import { parsePatch, applyFilePatch, checkPatchPolicy, sha256 } from '../src/patch.mjs';
import { runVerify, validateVerifyRequest } from '../src/contrib-verify.mjs';
import { Contrib, workspaceFor, AI_BAN, DISCLOSURE } from '../src/contrib.mjs';
import { ossTools } from '../src/agent/friday-tools.mjs';
import { GROUPS } from '../src/agent/toolsets.mjs';

// ---------- patch.mjs ----------
const ORIGINAL = 'def add(a, b):\n    return a - b\n\n\ndef sub(a, b):\n    return a - b\n';
const FIX = `diff --git a/calc.py b/calc.py
index 1111111..2222222 100644
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b
+    return a + b
diff --git a/tests/test_calc.py b/tests/test_calc.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/tests/test_calc.py
@@ -0,0 +1,4 @@
+from calc import add
+
+def test_add():
+    assert add(2, 3) == 5
`;

test('patch: parses and applies a modification and a new file exactly', () => {
  const files = parsePatch(FIX);
  assert.deepEqual(files.map((f) => [f.path, f.isNew]), [['calc.py', false], ['tests/test_calc.py', true]]);
  assert.equal(applyFilePatch(ORIGINAL, files[0]), ORIGINAL.replace('return a - b', 'return a + b'));
  assert.equal(applyFilePatch(null, files[1]), 'from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n');
});

test('patch: refuses to apply when upstream differs (no fuzz)', () => {
  const [f] = parsePatch(FIX);
  assert.throws(() => applyFilePatch(ORIGINAL.replace('def add', 'def plus'), f), /does not match/);
  assert.throws(() => applyFilePatch(null, f), /does not exist upstream/);
});

test('patch: handles "No newline at end of file" and deletions', () => {
  const p = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+TWO\n\\ No newline at end of file\n';
  assert.equal(applyFilePatch('one\ntwo', parsePatch(p)[0]), 'one\nTWO');
  const d = 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n';
  assert.equal(applyFilePatch('bye\n', parsePatch(d)[0]), null);
});

test('patch: rejects renames, binaries and wrong hunk counts', () => {
  assert.throws(() => parsePatch('diff --git a/a b/b\nsimilarity index 90%\nrename from a\nrename to b\n'), /renames/);
  assert.throws(() => parsePatch('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n'), /binary/);
  assert.throws(() => parsePatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n x\n-y\n'), /hunk_counts_wrong/);
});

test('patch policy: test required for a fix; CI, lockfiles, secrets and size are refused', () => {
  const files = parsePatch(FIX);
  assert.equal(checkPatchPolicy(files).ok, true);
  assert.match(checkPatchPolicy([files[0]]).problems.join(), /must add or update a test/);
  assert.equal(checkPatchPolicy([files[0]], { kind: 'revision' }).ok, true);
  const ci = parsePatch('diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-a\n+b\n');
  assert.match(checkPatchPolicy([...files, ...ci]).problems.join(), /must not be changed/);
  const lock = parsePatch('diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n');
  assert.match(checkPatchPolicy([...files, ...lock]).problems.join(), /must not be changed/);
  const secret = parsePatch(`diff --git a/tests/t.py b/tests/t.py\n--- a/tests/t.py\n+++ b/tests/t.py\n@@ -1 +1 @@\n-a\n+TOKEN = "ghp_${'a'.repeat(36)}"\n`);
  assert.match(checkPatchPolicy(secret).problems.join(), /credential/);
  assert.match(checkPatchPolicy(files, { limits: { maxFiles: 1, maxChangedLines: 400 } }).problems.join(), /too many files/);
});

// ---------- contrib-verify.mjs (real git + node, local repo) ----------
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
function localRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-oss-repo-'));
  writeFileSync(join(dir, 'add.js'), 'module.exports = (a, b) => a - b;\n');
  writeFileSync(join(dir, 'suite.js'), "require('./add.js'); console.log('suite ok');\n");
  git(dir, 'init', '-q'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init');
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}
const JS_FIX = `diff --git a/add.js b/add.js
--- a/add.js
+++ b/add.js
@@ -1 +1 @@
-module.exports = (a, b) => a - b;
+module.exports = (a, b) => a + b;
diff --git a/test/add.test.js b/test/add.test.js
new file mode 100644
--- /dev/null
+++ b/test/add.test.js
@@ -0,0 +1,2 @@
+const add = require('../add.js');
+if (add(2, 3) !== 5) { console.error('expected 5'); process.exit(1); }
`;
const verifyWith = (repo, over = {}) => runVerify({ cloneUrl: `file://${repo.dir}`, baseSha: repo.sha, patch: JS_FIX, setup: ['node --version'], test: 'node test/add.test.js', suite: 'node suite.js', ...over },
  { workRoot: mkdtempSync(join(tmpdir(), 'friday-oss-work-')), id: 'v1', allowUrl: (u) => u.startsWith('file://') });

test('verify: a real fix is proven (fails before, passes after, suite passes)', async () => {
  const repo = localRepo();
  const v = await verifyWith(repo);
  assert.equal(v.verdict, 'verified', JSON.stringify(v.steps.map((s) => [s.name, s.exit, s.tail])));
  assert.notEqual(v.steps.find((s) => s.name === 'test_before').exit, 0);
  assert.equal(v.steps.find((s) => s.name === 'test_after').exit, 0);
  assert.equal(v.steps.find((s) => s.name === 'suite_after').exit, 0);
});

test('verify: a test that already passes, a broken fix and a non-applying patch are all refused', async () => {
  const repo = localRepo();
  assert.equal((await verifyWith(repo, { test: 'node suite.js', suite: null })).verdict, 'not_reproduced');
  assert.equal((await verifyWith(repo, { patch: JS_FIX.replace('a + b', 'a * b') })).verdict, 'failing_after');
  assert.equal((await verifyWith(repo, { patch: JS_FIX.replace('-module.exports = (a, b) => a - b;', '-module.exports = (x) => x;') })).verdict, 'patch_failed');
  assert.equal((await verifyWith(repo, { setup: ['exit 3'] })).verdict, 'setup_failed');
});

test('verify: repro mode confirms a bug only when the expected error text appears', async () => {
  const repo = localRepo();
  const run = (over) => runVerify({ cloneUrl: `file://${repo.dir}`, baseSha: repo.sha, ...over }, { workRoot: mkdtempSync(join(tmpdir(), 'friday-oss-w-')), id: 'r1', allowUrl: () => true });
  assert.equal((await run({ repro: "node -e \"if (require('./add.js')(2,3) !== 5) { console.error('add(2,3) returned -1'); process.exit(1) }\"", expect: 'returned -1' })).verdict, 'reproduced');
  assert.equal((await run({ repro: 'node -e "process.exit(1)"', expect: 'returned -1' })).verdict, 'not_reproduced');
});

test('verify: only github.com clone URLs and full shas are accepted by default', () => {
  assert.throws(() => validateVerifyRequest({ cloneUrl: 'https://evil.example/x.git', baseSha: 'a'.repeat(40), patch: 'x', test: 't' }), /cloneUrl/);
  assert.throws(() => validateVerifyRequest({ cloneUrl: 'https://github.com/a/b.git', baseSha: 'main', patch: 'x', test: 't' }), /baseSha/);
  assert.throws(() => validateVerifyRequest({ cloneUrl: 'https://github.com/a/b.git', baseSha: 'a'.repeat(40), patch: 'x', test: 'a\nb' }), /one shell command/);
});

// ---------- contrib.mjs (stubbed GitHub, agent, verifier, reviewer) ----------
const SHA = 'b'.repeat(40);
class FakeGitHub {
  constructor({ guide = '', files = { 'calc.py': ORIGINAL }, issue = {} } = {}) {
    this.configured = true; this.login = null; this.calls = []; this.guide = guide; this.files = files;
    this.issueData = { number: 7, state: 'open', title: 'add() subtracts instead of adding', html_url: 'https://github.com/acme/calc/issues/7', body: 'Calling add(2, 3) returns -1 instead of 5. Expected the sum of both arguments, as the docs say.', assignees: [], labels: [{ name: 'good first issue' }], ...issue };
    this.pullData = { number: 12, state: 'open', merged: false, title: 'Fix add' };
    this.comments = []; this.branchHead = 'c'.repeat(40);
  }
  async whoami() { this.login = 'atharvb7'; return { login: 'atharvb7', scopes: ['public_repo'], too_broad: [] }; }
  async repo(full) { return { full_name: full, default_branch: 'main', archived: false, fork: false, private: false, has_issues: true, owner: { login: full.split('/')[0] }, stargazers_count: 500, pushed_at: new Date().toISOString(), license: { spdx_id: 'MIT' }, size: 1000, language: 'Python' }; }
  async issue() { return this.issueData; }
  async issueComments() { return this.comments; }
  async timeline() { return []; }
  async searchIssues(q) { this.calls.push(['search', q]); return { items: [{ repository_url: 'https://api.github.com/repos/acme/calc', number: 7 }], total_count: 1 }; }
  async fileAt(full, path) { if (path === 'CONTRIBUTING.md') return this.guide || null; return this.files[path] ?? null; }
  async branchSha() { return SHA; }
  async ensureFork(full) { this.calls.push(['fork', full]); return `atharvb7/${full.split('/')[1]}`; }
  async syncFork() { return true; }
  async commitFiles(repo, opts) { this.calls.push(['commit', repo, opts]); return 'd'.repeat(40); }
  async openPull(full, opts) { this.calls.push(['pull', full, opts]); return { number: 12, html_url: 'https://github.com/acme/calc/pull/12' }; }
  async get() { return []; }
  async pull() { return this.pullData; }
  async pullReviews() { return []; }
  async pullReviewComments() { return []; }
  async checkRuns() { return { check_runs: [] }; }
  async comment(full, n, body) { this.calls.push(['comment', full, n, body]); }
  async openIssue(full, o) { this.calls.push(['issue', full, o]); return { number: 99, html_url: 'https://github.com/acme/calc/issues/99' }; }
}
const RESULT = { status: 'ready', kind: 'fix', pr_title: 'Fix add() returning the difference', summary: 'add() used subtraction. It now adds.', changes: ['calc.py: use +', 'tests/test_calc.py: regression test'], setup: ['pip install -e .'], test: 'python -m pytest tests/test_calc.py -q', suite: 'python -m pytest -q', lint: '' };
const VERIFIED = { ok: true, verdict: 'verified', steps: [{ name: 'test_before', cmd: RESULT.test, exit: 1, tail: '' }, { name: 'test_after', cmd: RESULT.test, exit: 0, tail: '' }, { name: 'suite_after', cmd: RESULT.suite, exit: 0, tail: '' }] };
const APPROVE = { content: JSON.stringify({ verdict: 'approve', score: 9, solves_issue: true, problems: [], advice: 'Looks good.' }) };

function world({ gh = new FakeGitHub(), files = { 'friday-contrib/result.json': JSON.stringify(RESULT), 'friday-contrib/change.patch': FIX }, verify = async () => VERIFIED, review = async () => APPROVE, agentGithubToken = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-oss-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store);
  const bus = new EventBus();
  const notes = [];
  const notifications = { create: (n) => notes.push(n) };
  const approvals = new Approvals({ store, notifications, chat: { getConversation: () => null }, bus });
  const verifies = [];
  const contrib = new Contrib({ store, settings, ai: { run: async (role, o) => review(role, o) }, github: gh, approvals, notifications, bus,
    verifier: async (id, req) => { verifies.push(req); return verify(req); }, readFiles: async () => files, agentGithubToken });
  approvals.register('oss_submit', (p) => contrib.submit(p));
  approvals.register('oss_update', (p) => contrib.update(p));
  approvals.register('oss_issue', (p) => contrib.openIssue(p));
  const finishTask = async (status = 'completed') => {
    const t = store.claimNextQueuedTask(); assert.ok(t, 'a task was queued');
    store.transition(t.id, status, status === 'completed' ? { result: 'done' } : { error: 'boom' });
    await contrib.onTaskFinished(t.id, `task.${status}`);
    return t;
  };
  return { store, settings, bus, approvals, contrib, gh, notes, verifies, finishTask };
}

test('contrib: issue -> agent -> verified -> reviewed -> ONE approval card -> approved -> fork, commit, PR', async () => {
  const w = world();
  const s = await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  assert.equal(s.started, true);
  const queued = w.store.nextQueuedTask();
  assert.equal(queued.kind, 'coding');
  assert.equal(queued.workspace, workspaceFor('acme/calc'));
  assert.match(queued.instruction, /oss-contribution skill/);
  assert.match(queued.instruction, new RegExp(SHA));
  assert.match(queued.instruction, /untrusted data/);
  await w.finishTask();
  assert.equal(w.verifies.length, 1);
  assert.equal(w.verifies[0].cloneUrl, 'https://github.com/acme/calc.git');
  assert.equal(w.verifies[0].baseSha, SHA);
  assert.equal(w.verifies[0].testBefore, true);
  const pending = w.approvals.list();
  assert.equal(pending.length, 1);
  const card = pending[0];
  assert.equal(card.tool, 'oss_submit');
  const c = card.payload.contribution;
  assert.equal(c.diff, FIX);
  assert.match(c.body, /^Fixes #7/);
  assert.match(c.body, /fails before this change and passes with it/);
  assert.ok(c.body.includes(DISCLOSURE));
  assert.equal(w.gh.calls.filter((x) => ['fork', 'commit', 'pull'].includes(x[0])).length, 0, 'nothing touches GitHub before approval');
  await w.approvals.decide(card.id, true);
  const commit = w.gh.calls.find((x) => x[0] === 'commit');
  assert.equal(commit[1], 'atharvb7/calc');
  assert.equal(commit[2].parentSha, SHA);
  assert.deepEqual(commit[2].files.map((f) => f.path), ['calc.py', 'tests/test_calc.py']);
  assert.equal(commit[2].files[0].content, ORIGINAL.replace('return a - b', 'return a + b'));
  const pull = w.gh.calls.find((x) => x[0] === 'pull');
  assert.equal(pull[2].head, `atharvb7:${c.branch}`);
  assert.equal(w.contrib.status().open[0].status, 'pr_open');
});

test('contrib: a failed proof goes back to the agent with the exact failure, then is dropped after max_rounds', async () => {
  const w = world({ verify: async () => ({ ok: false, verdict: 'failing_after', error: 'tests fail with the change applied', steps: [{ name: 'suite_after', cmd: 'python -m pytest -q', exit: 1, tail: 'FAILED test_other' }] }) });
  await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  await w.finishTask();
  const redo = w.store.nextQueuedTask();
  assert.match(redo.instruction, /Round: 2/);
  assert.match(redo.instruction, /FAILED test_other/);
  await w.finishTask();
  assert.equal(w.approvals.list().length, 0);
  assert.equal(w.contrib.list()[0].status, 'rejected');
  assert.ok(w.notes.some((n) => /dropped/.test(n.title)));
});

test('contrib: a reviewer asking for changes sends it back; a missing test is refused before any verification', async () => {
  const w = world({ review: async () => ({ content: JSON.stringify({ verdict: 'revise', score: 6, solves_issue: true, problems: [{ severity: 'major', text: 'test name does not follow the project style' }] }) }) });
  await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  await w.finishTask();
  assert.match(w.store.nextQueuedTask().instruction, /test name does not follow/);

  const noTest = world({ files: { 'friday-contrib/result.json': JSON.stringify(RESULT), 'friday-contrib/change.patch': FIX.split('diff --git a/tests')[0] } });
  await noTest.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  await noTest.finishTask();
  assert.equal(noTest.verifies.length, 0);
  assert.match(noTest.store.nextQueuedTask().instruction, /must add or update a test/);
});

test('contrib: a tampered change is never posted', async () => {
  const w = world();
  await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  await w.finishTask();
  const card = w.approvals.list()[0];
  w.store.db.prepare('UPDATE oss_attempts SET patch=? ').run(FIX.replace('a + b', 'a * b'));
  const done = await w.approvals.decide(card.id, true);
  assert.match(JSON.parse(done.result).error, /differs from the one you approved/);
  assert.equal(w.gh.calls.filter((x) => x[0] === 'commit').length, 0);
});

test('contrib: repos that ban AI help, need a CLA, or want issues claimed first are skipped', async () => {
  for (const guide of ['We do not accept AI-generated contributions.', 'All contributors must sign our Contributor License Agreement (CLA).', 'Please comment on the issue and get assigned before you start working on it.']) {
    const w = world({ gh: new FakeGitHub({ guide }) });
    const r = await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
    assert.equal(r.not_started, true, guide);
    assert.equal(w.store.nextQueuedTask(), null);
  }
  assert.ok(AI_BAN.some((re) => re.test('Pull requests written by ChatGPT or Copilot will be closed.')));
  assert.ok(!AI_BAN.some((re) => re.test('We use an AI bot to label issues. Contributions are welcome!')));
});

test('contrib: claimed or assigned issues are skipped; the search path rotates language and label', async () => {
  const claimed = new FakeGitHub(); claimed.comments = [{ created_at: new Date().toISOString(), body: "Hi, I'd like to work on this!", user: { login: 'someone' } }];
  assert.equal((await world({ gh: claimed }).contrib.startOne({ repo: 'acme/calc', issue: 7 })).not_started, true);
  const assigned = new FakeGitHub({ issue: { assignees: [{ login: 'x' }] } });
  assert.equal((await world({ gh: assigned }).contrib.startOne({ repo: 'acme/calc', issue: 7 })).not_started, true);
  const w = world();
  const r = await w.contrib.startOne();
  assert.equal(r.started, true);
  assert.match(w.gh.calls.find((x) => x[0] === 'search')[1], /-linked:pr label:"good first issue" language:Python/);
});

test('contrib: refuses to run while the coding agent has its own GitHub token', async () => {
  const w = world({ agentGithubToken: true });
  await assert.rejects(() => w.contrib.startOne({ repo: 'acme/calc', issue: 7 }), /agent_has_github_token/);
  assert.equal((await w.contrib.connection()).connected, false);
});

test('contrib: follow-up records maintainer feedback as lessons, revise prepares an update card, merge is reported', async () => {
  const w = world();
  await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  await w.finishTask();
  await w.approvals.decide(w.approvals.list()[0].id, true);
  w.store.db.prepare("UPDATE oss_attempts SET last_seen='2000-01-01T00:00:00Z'").run();
  w.gh.comments = [{ user: { login: 'maintainer' }, created_at: new Date().toISOString(), body: 'Please also handle floats.' }, { user: { login: 'atharvb7' }, created_at: new Date().toISOString(), body: 'mine' }];
  await w.contrib.followUp();
  assert.ok(w.notes.some((n) => /Maintainer replied/.test(n.title) && /handle floats/.test(n.body) && !/mine/.test(n.body)));
  assert.match(w.contrib.lessons()[0].text, /handle floats/);
  const id = w.contrib.list()[0].id;
  assert.equal(w.contrib.revise(id).queued, true);
  const t = w.store.nextQueuedTask();
  assert.match(t.instruction, /handle floats/);
  assert.match(t.instruction, /atharvb7\/calc\.git/);
  // the revision diff applies on top of the PR head
  w.gh.files = { 'calc.py': ORIGINAL.replace('return a - b', 'return a + b') };
  const REV = 'diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a + b\n+    return float(a) + float(b)\n';
  const w2files = { 'friday-contrib/result.json': JSON.stringify({ ...RESULT, reply: 'Handled floats.', commit_message: 'Handle floats' }), 'friday-contrib/change.patch': REV };
  w.contrib.readFiles = async () => w2files;
  w.gh.branchSha = async () => 'd'.repeat(40);
  await w.finishTask();
  const card = w.approvals.list()[0];
  assert.equal(card.tool, 'oss_update');
  assert.equal(w.verifies.at(-1).testBefore, false);
  await w.approvals.decide(card.id, true);
  assert.equal(w.gh.calls.filter((x) => x[0] === 'commit').at(-1)[2].parentSha, 'd'.repeat(40));
  assert.match(w.gh.calls.find((x) => x[0] === 'comment')[3], /Handled floats/);
  w.gh.pullData = { ...w.gh.pullData, merged: true };
  await w.contrib.followUp();
  assert.equal(w.contrib.list()[0].status, 'merged');
});

test('contrib: a denied card is recorded with the note as a lesson', async () => {
  const w = world();
  await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  await w.finishTask();
  await w.approvals.decide(w.approvals.list()[0].id, false, 'owner', 'too trivial, pick meatier issues');
  assert.equal(w.contrib.list()[0].status, 'denied');
  assert.match(w.contrib.lessons()[0].text, /meatier/);
});

test('contrib: one contribution at a time and max_open_prs are respected', async () => {
  const w = world();
  await w.contrib.startOne({ repo: 'acme/calc', issue: 7 });
  const again = await w.contrib.startOne({ repo: 'acme/other', issue: 1 });
  assert.equal(again.not_started, true);
  assert.match(again.note, /one at a time/);
});

test('oss tools: only setup is gated; the group routes open-source talk', () => {
  const tools = ossTools({});
  assert.deepEqual(tools.filter((t) => t.risk !== 'safe').map((t) => t.name), ['oss_setup']);
  assert.ok(GROUPS.oss.match.test('how are my open source contributions going?'));
  assert.deepEqual(GROUPS.oss.tools.sort(), tools.map((t) => t.name).sort());
});

test('workspace names are valid task workspaces', () => {
  for (const r of ['acme/calc', 'Some-Org/a.very.long.repository-name-with-many-parts', 'x/y']) assert.match(workspaceFor(r), /^oss-[a-z0-9][a-z0-9-]{0,35}$/);
  assert.equal(sha256('a').length, 64);
  void mkdirSync;
});
