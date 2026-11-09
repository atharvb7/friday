// GitHub REST client for open-source contributions. Lives ONLY in Friday core: the token
// (FRIDAY_GITHUB_CONTRIB_TOKEN) is never given to the coding agent, whose container reads untrusted repository text.
// Every write here runs only from an approved approval card (src/contrib.mjs).
const API = 'https://api.github.com';
// A classic token needs just `public_repo`. Anything broader is refused: a leaked or misused token must not be able to
// touch private repos, delete repos, edit workflows or administer orgs.
const TOO_BROAD = /^(repo|delete_repo|workflow|write:packages|delete:packages|admin:[a-z_:]+|user|write:org|codespace|project)$/;

export class GitHubError extends Error {
  constructor(status, message, body = null) { super(message); this.status = status; this.body = body; }
}

export class GitHub {
  #token;
  constructor({ token = null, fetchImpl = globalThis.fetch, userAgent = 'friday-oss-contrib' } = {}) {
    this.#token = token || null;
    Object.assign(this, { fetchImpl, userAgent });
    this.login = null; this.scopes = null;
  }
  get configured() { return Boolean(this.#token); }

  async request(method, path, { body = null, accept = 'application/vnd.github+json', raw = false, okStatuses = [] } = {}) {
    if (!this.#token) throw new GitHubError(0, 'github_not_configured');
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    if (!url.startsWith(`${API}/`)) throw new GitHubError(0, 'github_bad_url');
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': this.userAgent, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 && okStatuses.includes(404)) return null;
    if (!res.ok && !okStatuses.includes(res.status)) {
      let msg = ''; try { const j = await res.json(); msg = j.message ?? ''; if (j.errors) msg += ` ${JSON.stringify(j.errors).slice(0, 300)}`; } catch {}
      const remaining = res.headers?.get?.('x-ratelimit-remaining');
      throw new GitHubError(res.status, `github_${res.status}${remaining === '0' ? ' (rate limited)' : ''}: ${String(msg).slice(0, 400)}`);
    }
    if (res.status === 204) return null;
    if (raw) return res.text();
    return { data: await res.json(), headers: res.headers };
  }
  async get(path, opts) { return (await this.request('GET', path, opts))?.data ?? null; }
  async post(path, body, opts) { return (await this.request('POST', path, { ...opts, body }))?.data ?? null; }
  async patch(path, body) { return (await this.request('PATCH', path, { body }))?.data ?? null; }

  // Who the token belongs to + whether its scopes are narrow enough.
  async whoami() {
    const r = await this.request('GET', '/user');
    const header = r.headers?.get?.('x-oauth-scopes');
    this.scopes = header === null || header === undefined ? null : header.split(',').map((s) => s.trim()).filter(Boolean);
    this.login = r.data.login;
    const broad = (this.scopes ?? []).filter((s) => TOO_BROAD.test(s));
    return { login: this.login, name: r.data.name ?? null, scopes: this.scopes, fine_grained: this.scopes === null, too_broad: broad };
  }

  repo(full) { return this.get(`/repos/${full}`); }
  issue(full, n) { return this.get(`/repos/${full}/issues/${n}`); }
  issueComments(full, n) { return this.get(`/repos/${full}/issues/${n}/comments?per_page=50`); }
  timeline(full, n) { return this.get(`/repos/${full}/issues/${n}/timeline?per_page=100`); }
  searchIssues(q, { sort = 'updated', perPage = 30 } = {}) { return this.get(`/search/issues?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${perPage}`); }
  // A file's text at a commit, or null when it does not exist there.
  async fileAt(full, path, ref) {
    const out = await this.request('GET', `/repos/${full}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.raw+json', raw: true, okStatuses: [404] });
    return out ?? null;
  }
  branchSha(full, branch) { return this.get(`/repos/${full}/commits/${encodeURIComponent(branch)}`).then((c) => c.sha); }

  // ---- writes (approval-gated by the caller) ----
  async ensureFork(full) {
    const [, name] = full.split('/');
    const mine = await this.request('GET', `/repos/${this.login}/${name}`, { okStatuses: [404] });
    if (mine?.data?.fork && mine.data.parent?.full_name?.toLowerCase() === full.toLowerCase()) return mine.data.full_name;
    if (mine?.data) throw new GitHubError(409, `you already have a repo named ${this.login}/${name} that is not a fork of ${full}`);
    const fork = await this.post(`/repos/${full}/forks`, { default_branch_only: true });
    for (let i = 0; i < 20; i++) { // forks are created asynchronously
      const r = await this.request('GET', `/repos/${fork.full_name}`, { okStatuses: [404] });
      if (r?.data) return fork.full_name;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    throw new GitHubError(504, 'fork_not_ready');
  }
  // Bring the fork's branch up to date with upstream so upstream commits exist there (best effort: a diverged fork stays as it is).
  async syncFork(forkFull, branch) {
    try { await this.post(`/repos/${forkFull}/merge-upstream`, { branch }); return true; } catch { return false; }
  }
  // Commit new file contents on top of `parentSha` and point `branch` of `repoFull` at it (creating or fast-forwarding).
  async commitFiles(repoFull, { parentSha, branch, message, files }) {
    const parent = await this.get(`/repos/${repoFull}/git/commits/${parentSha}`);
    const tree = [];
    for (const f of files) {
      if (f.content === null) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const blob = await this.post(`/repos/${repoFull}/git/blobs`, { content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' });
      tree.push({ path: f.path, mode: f.mode ?? '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await this.post(`/repos/${repoFull}/git/trees`, { base_tree: parent.tree.sha, tree });
    const commit = await this.post(`/repos/${repoFull}/git/commits`, { message, tree: newTree.sha, parents: [parentSha] });
    const ref = await this.request('GET', `/repos/${repoFull}/git/ref/heads/${branch}`, { okStatuses: [404] });
    if (ref?.data) await this.patch(`/repos/${repoFull}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    else await this.post(`/repos/${repoFull}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    return commit.sha;
  }
  openPull(full, { title, body, head, base }) { return this.post(`/repos/${full}/pulls`, { title, body, head, base, maintainer_can_modify: true }); }
  pull(full, n) { return this.get(`/repos/${full}/pulls/${n}`); }
  pullReviews(full, n) { return this.get(`/repos/${full}/pulls/${n}/reviews?per_page=50`); }
  pullReviewComments(full, n) { return this.get(`/repos/${full}/pulls/${n}/comments?per_page=100`); }
  checkRuns(full, sha) { return this.get(`/repos/${full}/commits/${sha}/check-runs?per_page=50`); }
  comment(full, n, body) { return this.post(`/repos/${full}/issues/${n}/comments`, { body }); }
  openIssue(full, { title, body }) { return this.post(`/repos/${full}/issues`, { title, body }); }
}
