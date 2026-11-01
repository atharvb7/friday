import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteDshAdapter } from '../src/dsh-remote.mjs';
import { makeProxy, resolvePublic } from '../egress-proxy/proxy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-secret-test-secret-test-secret';

const FAKE_DSH = `
import { readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8'); const out = (o) => console.log(JSON.stringify(o));
if (stdin.includes('SLOW')) { setInterval(() => {}, 1000); }
else {
  out({type:'tool_call',callId:'1',tool:'bash',input:{command:'echo hi'}});
  out({type:'tool_result',callId:'1',status:'completed',result:'hi'});
  out({type:'status',phase:'step_end',turn:1,step:1,usage:{totalTokens:7}});
  if (stdin.includes('RESEARCH')) { writeFileSync('findings.json', JSON.stringify({topic:'T',summary:'S',sources:[],claims:[]})); writeFileSync('report.md', '# R'); }
  out({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}}); out({type:'final',text:'done:' + process.env.NVIDIA_API_KEY.length + ':' + (process.env.GITHUB_TOKEN ?? 'no-gh')});
}`;

async function startRunner(dir, port, extraEnv = {}) {
  const bin = join(dir, 'fake-dsh.mjs'); writeFileSync(bin, FAKE_DSH);
  const child = spawn(process.execPath, [join(ROOT, 'agent-runner', 'server.mjs')], { env: { PATH: process.env.PATH, FRIDAY_AGENT_SECRET: SECRET, AGENT_PORT: String(port), AGENT_HOME: join(dir, 'home'), AGENT_WORK: join(dir, 'work'), AGENT_STATE: join(dir, 'state'), DSH_BIN: bin, FRIDAY_NVIDIA_API_KEY: 'nvapi-runner-secret-key', AGENT_MAX_CONCURRENT: '1', ...extraEnv }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${SECRET}` } }); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  return child;
}

test('agent runner + remote adapter: auth, streamed traces, secrets stay in the runner, research files returned, busy 429, cancel kills the agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-run-'));
  const port = 43501;
  const child = await startRunner(dir, port, { GITHUB_TOKEN: 'ghp_runner_only_token' });
  try {
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal((await fetch(`${url}/run`, { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status, 401);
    const ad = new RemoteDshAdapter({ url, secret: SECRET, prepare: () => ({ overlay: '# none\n[]\n', skills: { 'demo/SKILL.md': Buffer.from('---\nname: demo\ndescription: d\n---\nx').toString('base64'), '../evil/x': 'eA==' } }) });
    assert.equal(ad.status().ready, false, 'not ready before the first poll');
    const trace = [];
    const r = await ad.run({ taskId: 't1', instruction: 'hello', onTrace: (k, d) => trace.push(k) });
    assert.equal(r.status, 'completed', r.error);
    assert.match(r.output, /^done:\d+:no-gh$/, 'runner env secrets are not passed to the agent unless an MCP overlay references them');
    assert.deepEqual(trace, ['tool_call', 'tool_result', 'step']);
    assert.equal(r.tokens, 7);
    assert.equal(ad.takeFiles('t1'), null);
    const rr = await ad.run({ taskId: 't2', instruction: 'RESEARCH please', kind: 'research' });
    assert.equal(rr.status, 'completed');
    const files = ad.takeFiles('t2'); assert.equal(JSON.parse(files['findings.json']).topic, 'T'); assert.equal(files['report.md'], '# R');
    assert.equal(ad.takeFiles('t2'), null, 'files are handed over once');
    assert.equal(ad.status().ready, true);

    // busy + cancel: one slot only
    const ctrl = new AbortController();
    const slow = ad.run({ taskId: 't3', instruction: 'SLOW', signal: ctrl.signal });
    await new Promise((res) => setTimeout(res, 400));
    const busy = await ad.run({ taskId: 't4', instruction: 'x' });
    assert.equal(busy.status, 'failed'); assert.match(busy.error, /runner_http_429/);
    ctrl.abort(new Error('Task cancelled'));
    await assert.rejects(slow, (e) => e.name === 'AbortError');
    await new Promise((res) => setTimeout(res, 800));
    const again = await ad.run({ taskId: 't5', instruction: 'ok now' });
    assert.equal(again.status, 'completed', 'slot freed after cancel');
    // bad input
    const bad = await fetch(`${url}/run`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: '../x', instruction: 'y' }) });
    assert.equal(bad.status, 400);
    ad.stop();
  } finally { child.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); }
});

test('egress proxy: public destinations pass, private/loopback/tailnet/docker/metadata and odd ports are refused (HTTP + CONNECT)', async () => {
  for (const host of ['127.0.0.1', '10.0.0.5', '100.100.171.9', '172.18.0.2', '169.254.169.254', '[::ffff:7f00:1]', 'localhost']) await assert.rejects(() => resolvePublic(host), /blocked_address/, host);
  const origin = http.createServer((q, s) => { s.writeHead(200); s.end('ORIGIN-OK'); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const oport = origin.address().port;
  // allowPrivate only so the test origin on loopback is reachable; port policy still enforced
  const proxy = makeProxy({ allowPrivate: true, ports: new Set([oport]) });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const pport = proxy.address().port;
  try {
    const viaProxy = (target) => new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: pport, method: 'GET', path: target, headers: { Host: new URL(target).host } }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b })); }); q.on('error', reject); q.end(); });
    assert.deepEqual(await viaProxy(`http://127.0.0.1:${oport}/x`), { status: 200, body: 'ORIGIN-OK' });
    assert.equal((await viaProxy('http://127.0.0.1:9/x')).status, 403, 'port not allowed');
    const connect = (hostport) => new Promise((resolve) => { const s = net.connect(pport, '127.0.0.1', () => s.write(`CONNECT ${hostport} HTTP/1.1\r\nHost: ${hostport}\r\n\r\n`)); s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); }); s.on('error', () => resolve('error')); });
    assert.match(await connect(`127.0.0.1:${oport}`), /200/);
    assert.match(await connect('127.0.0.1:22'), /403/);
  } finally { proxy.close(); origin.close(); }
  const strict = makeProxy();
  await new Promise((r) => strict.listen(0, '127.0.0.1', r));
  try {
    const s = net.connect(strict.address().port, '127.0.0.1');
    const line = await new Promise((resolve) => { s.on('connect', () => s.write('CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: x\r\n\r\n')); s.once('data', (d) => resolve(d.toString().split('\r\n')[0])); });
    assert.match(line, /403/, 'cloud metadata is unreachable through the proxy'); s.destroy();
  } finally { strict.close(); }
});
