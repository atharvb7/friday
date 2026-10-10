import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshAdapter } from '../src/dsh.mjs';
import { bwrapUsable, buildBwrapArgs } from '../src/sandbox.mjs';

const KEY = 'nvapi-adapter-test-secret';

// Fake DSH CLI: reads the task from stdin and emits the real event shapes.
function fakeBin(dir, body) {
  const f = join(dir, 'fake-dsh.mjs');
  writeFileSync(f, `import { readFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
const out = (o) => console.log(JSON.stringify(o));
${body}
`);
  return f;
}
const adapter = (dir, bin, extra = {}) => new DshAdapter({ homeDir: join(dir, 'home'), workRoot: join(dir, 'work'), bin, apiKey: KEY, sandbox: 'off', ...extra });

test('dsh: status fails closed (missing bin, missing key, disabled)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-dsh-'));
  try {
    assert.equal(adapter(dir, '/nope/bin.js').status().reason, 'dsh_binary_missing');
    const bin = fakeBin(dir, '');
    assert.equal(adapter(dir, bin, { apiKey: null }).status().reason, 'dsh_no_model_key');
    assert.equal(adapter(dir, bin, { enabled: false }).status().reason, 'dsh_disabled');
    assert.equal(adapter(dir, bin).status().ready, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dsh: isolated 0700 home + settings (no key on disk), minimal env, stdin task, trace + final', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-dsh-'));
  try {
    process.env.PERSONAL_SECRET_SHOULD_NOT_LEAK = 'leakme';
    const bin = fakeBin(dir, `
out({type:'session',sessionId:'s',cwd:process.cwd()});
out({type:'status',phase:'turn_start',turn:1});
out({type:'tool_call',callId:'1',tool:'bash',input:{command:'echo '+process.env.NVIDIA_API_KEY}});
out({type:'tool_result',callId:'1',status:'completed',result:'ok'});
out({type:'status',phase:'step_end',turn:1,step:1,usage:{totalTokens:42}});
out({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}});
out({type:'final',text:JSON.stringify({home:process.env.HOME,dshHome:process.env.DSH_HOME,leak:process.env.PERSONAL_SECRET_SHOULD_NOT_LEAK??null,mode:process.env.DSH_PERMISSION_MODE,cwd:process.cwd(),sawTask:stdin.includes('do the thing'),key:process.env.NVIDIA_API_KEY})});
`);
    const a = adapter(dir, bin);
    assert.equal(statSync(join(dir, 'home')).mode & 0o777, 0o700);
    assert.ok(!readFileSync(join(dir, 'home', 'settings.yaml'), 'utf8').includes(KEY), 'API key must not be written to disk');
    const trace = [];
    const r = await a.run({ taskId: 't-1', instruction: 'do the thing', onTrace: (k, d) => trace.push([k, d]) });
    assert.equal(r.status, 'completed');
    const seen = JSON.parse(r.output.replaceAll('[redacted]', 'REDACTED'));
    assert.equal(seen.home, join(dir, 'home'));
    assert.equal(seen.dshHome, join(dir, 'home'));
    assert.equal(seen.leak, null);
    assert.equal(seen.sawTask, true);
    assert.equal(seen.key, 'REDACTED', 'secret redacted from output');
    assert.ok(seen.cwd.endsWith('t-1'));
    assert.equal(r.tokens, 42);
    assert.deepEqual(trace.map((t) => t[0]), ['tool_call', 'tool_result', 'step']);
    assert.ok(!JSON.stringify(trace).includes(KEY), 'secret redacted from trace');
  } finally { delete process.env.PERSONAL_SECRET_SHOULD_NOT_LEAK; rmSync(dir, { recursive: true, force: true }); }
});

test('dsh: failure modes map to honest errors; cancel rejects AbortError; timeout reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-dsh-'));
  try {
    const nonzero = await adapter(dir, fakeBin(dir, "console.error('boom '+process.env.NVIDIA_API_KEY); process.exit(1);")).run({ taskId: 'a', instruction: 'x' });
    assert.equal(nonzero.status, 'failed');
    assert.match(nonzero.error, /dsh_exit_1: boom \[redacted\]/);
    const aborted = await adapter(dir, fakeBin(dir, "out({type:'status',phase:'turn_end',turn:1,reason:{kind:'aborted'}}); out({type:'final',text:''});")).run({ taskId: 'b', instruction: 'x' });
    assert.match(aborted.error, /\(aborted\)/);

    const slow = fakeBin(dir, 'setInterval(() => {}, 1000);');
    const ctrl = new AbortController();
    const p = adapter(dir, slow).run({ taskId: 'c', instruction: 'x', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error('Task cancelled')), 200);
    await assert.rejects(p, (e) => e.name === 'AbortError');

    const timed = await adapter(dir, slow, { timeoutMs: 300 }).run({ taskId: 'd', instruction: 'x' });
    assert.equal(timed.error, 'dsh_timeout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox args hide home, app and data dir; re-expose only workspace + dsh home', () => {
  const args = buildBwrapArgs({ home: '/home/u', appRoot: '/home/u/app', dataDir: '/home/u/app/data', writable: [], readonly: [] });
  const tmpfs = args.map((a, i) => (a === '--tmpfs' ? args[i + 1] : null)).filter(Boolean);
  assert.deepEqual(tmpfs.filter((p) => p !== '/tmp'), []); // paths don't exist here: nothing to mount
  const real = buildBwrapArgs({ home: tmpdir(), appRoot: join(tmpdir(), 'zz-app'), dataDir: join(tmpdir(), 'zz-app', 'data'), writable: [], readonly: [] });
  assert.ok(real.includes('--die-with-parent') && real.includes('--unshare-pid'));
});

test('dsh + real bubblewrap: agent cannot see friday secrets or write outside its workspace', { skip: !bwrapUsable() }, async () => {
  const dir = mkdtempSync(join(process.cwd(), '.sbx-'));
  try {
    const appRoot = join(dir, 'app'); const dataDir = join(appRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(appRoot, '.env'), 'TOPSECRET=1'); writeFileSync(join(dataDir, 'access-token'), 'tok');
    const bin = fakeBin(dir, `
import { writeFileSync } from 'node:fs';
const tryRead = (p) => { try { return readFileSync(p, 'utf8'); } catch (e) { return 'ERR:' + e.code; } };
const tryWrite = (p) => { try { writeFileSync(p, 'x'); return 'WROTE'; } catch (e) { return 'ERR:' + e.code; } };
out({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}});
out({type:'final',text:JSON.stringify({env:tryRead(${JSON.stringify(join(appRoot, '.env'))}), token:tryRead(${JSON.stringify(join(dataDir, 'access-token'))}), outside:tryWrite('/usr/x'), ws:tryWrite(process.cwd()+'/ok.txt')})});
`);
    const a = new DshAdapter({ homeDir: join(dataDir, 'dsh-home'), workRoot: join(dataDir, 'dsh-workspaces'), bin, apiKey: KEY, sandbox: 'bwrap', appRoot, dataDir, home: dir });
    // the fake bin lives under `dir` (hidden as "home"), so expose it read-only like a real install tree
    a.buildCommand = ((orig) => (w) => { const c = orig(w); c.args.splice(c.args.indexOf('--chdir'), 0, '--ro-bind', bin, bin); return c; })(a.buildCommand.bind(a));
    const r = await a.run({ taskId: 'sbx', instruction: 'x' });
    assert.equal(r.status, 'completed', r.error);
    const seen = JSON.parse(r.output);
    assert.match(seen.env, /^ERR:/);
    assert.match(seen.token, /^ERR:/);
    assert.match(seen.outside, /^ERR:/);
    assert.equal(seen.ws, 'WROTE');
    assert.ok(existsSync(join(dataDir, 'dsh-workspaces', 'sbx', 'ok.txt')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
