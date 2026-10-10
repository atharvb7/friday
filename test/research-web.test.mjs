import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivateAddress, safeFetch, htmlToText, serpSearch } from '../src/web.mjs';
import { ResearchMemory } from '../src/research-memory.mjs';
import { Store } from '../src/store.mjs';
import { withDefaults, renderOverlay, validateMcpConfig, envToForward } from '../src/mcp-config.mjs';

test('web: private/loopback/metadata addresses are refused (v4, v6, mapped)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'garbage']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('web: safeFetch blocks internal targets, bad schemes, credentials; fetches text with allowPrivate (tests only)', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: '/page' }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('x'.repeat(5000)); }
    if (req.url === '/bin') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end('abc'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><script>evil()</script><h1>Title</h1><p>Hello &amp; welcome</p><style>p{}</style></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(() => safeFetch(`${base}/page`), /blocked_address/);
    await assert.rejects(() => safeFetch('http://169.254.169.254/latest/meta-data'), /blocked_address/);
    await assert.rejects(() => safeFetch('file:///etc/passwd'), /only http/);
    await assert.rejects(() => safeFetch('https://user:pw@example.com/'), /credentials/);
    const ok = await safeFetch(`${base}/redir`, { allowPrivate: true });
    assert.match(ok.text, /Title/);
    assert.match(ok.text, /Hello & welcome/);
    assert.ok(!/evil|p\{\}/.test(ok.text), 'script/style stripped');
    const big = await safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 1000 });
    assert.equal(big.truncated, true);
    await assert.rejects(() => safeFetch(`${base}/bin`, { allowPrivate: true }), /unsupported_content_type/);
  } finally { srv.close(); }
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\n\nb');
});

test('web: serpSearch validates input, compacts results, never leaks the key', async () => {
  const key = 'serp-secret-key-123';
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); return { ok: true, json: async () => ({ organic_results: [{ title: 'T', link: 'https://a.example', snippet: 'S', date: '2026-01-01', junk: 'x' }] }) }; };
  const r = await serpSearch({ apiKey: key, query: 'nemotron', fetchImpl });
  assert.deepEqual(r.results[0], { title: 'T', link: 'https://a.example', snippet: 'S', date: '2026-01-01', source: null });
  assert.match(calls[0], /engine=google/);
  await assert.rejects(() => serpSearch({ apiKey: key, query: 'x', engine: 'evil', fetchImpl }), /engine must be/);
  await assert.rejects(() => serpSearch({ apiKey: null, query: 'x' }), /serpapi_not_configured/);
  const failing = async () => ({ ok: true, json: async () => ({ error: `bad key ${key}` }) });
  await assert.rejects(() => serpSearch({ apiKey: key, query: 'x', fetchImpl: failing }), (e) => !e.message.includes(key));
});

test('research memory: ingest findings, detect contradictions, search with citations, reject junk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-rm-'));
  try {
    const store = new Store(join(dir, 'db.sqlite'));
    const rm = new ResearchMemory({ store });
    const out = rm.ingest({ taskId: 't1', reportMd: '# R', findings: {
      topic: 'AI coding agents 2026', summary: 'Claude Code and Codex lead; pricing varies.', confidence: 'medium',
      sources: [{ url: 'https://a.example/post', title: 'A', date: '2026-09-01' }, { url: 'https://b.example/post', title: 'B' }, { url: 'ftp://bad', title: 'skip' }],
      claims: [
        { topic: 'agent pricing', claim: 'Tool X costs $20/month', sourceUrl: 'https://a.example/post', confidence: 'high' },
        { topic: 'Agent Pricing', claim: 'Tool X costs $30/month', sourceUrl: 'https://b.example/post' },
        { topic: 'market share', claim: 'Codex leads', sourceUrl: 'https://a.example/post' },
      ],
    } });
    assert.equal(out.sources, 2); assert.equal(out.claims, 3); assert.equal(out.contradictions, 2);
    const hits = rm.search('what did we learn about coding agents');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].claims.find((c) => c.claim.includes('$20')).source.url, 'https://a.example/post');
    assert.ok(hits[0].claims.some((c) => c.contradicted));
    assert.equal(rm.report(out.id), '# R');
    assert.equal(rm.search('zzzzqqq').length, 0);
    assert.throws(() => rm.ingest({ findings: { topic: '', summary: '' } }), /need topic and summary/);
    assert.throws(() => rm.ingest({ findings: null }), /must be an object/);
    // ingestFromDir
    writeFileSync(join(dir, 'findings.json'), JSON.stringify({ topic: 'T2', summary: 'S2', sources: [], claims: [] }));
    assert.equal(rm.ingestFromDir({ taskId: 't2', dir }).topic, 'T2');
    assert.throws(() => rm.ingestFromDir({ taskId: 't3', dir: join(dir, 'missing') }), /missing/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mcp defaults: serpapi + github auto-enabled from env creds via headers-from-env, never inline secrets', () => {
  const cfg = withDefaults({ servers: {} }, { SERPAPI_API_KEY: 'sk-serp', GITHUB_TOKEN: 'ghp_tok' });
  validateMcpConfig(cfg);
  const y = renderOverlay(cfg);
  assert.match(y, /serverName: serpapi/); assert.match(y, /mcp\.serpapi\.com\/mcp/);
  assert.match(y, /process\.env\.SERPAPI_API_KEY/); assert.match(y, /Bearer /);
  assert.ok(!y.includes('sk-serp') && !y.includes('ghp_tok'));
  assert.deepEqual(envToForward(cfg).sort(), ['GITHUB_TOKEN', 'SERPAPI_API_KEY']);
  assert.deepEqual(Object.keys(withDefaults({ servers: {} }, {}).servers), []);
  const custom = withDefaults({ servers: { serpapi: { transport: 'stdio', command: 'mine' } } }, { SERPAPI_API_KEY: 'k' });
  assert.equal(custom.servers.serpapi.command, 'mine', 'user config wins');
});
