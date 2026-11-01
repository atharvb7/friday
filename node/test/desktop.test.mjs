import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDesktopEntry, loadApps, findApps, scoreApp, runShell, catastrophic, homePath, InputDevice, launchDetached, makeDesktop } from '../desktop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const entry = (name, extra = '') => `[Desktop Entry]\nType=Application\nName=${name}\nExec=/usr/bin/${name.toLowerCase().replace(/ /g, '-')} %U\n${extra}\n[Desktop Action new]\nName=Ignored`;

function appsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-apps-'));
  const user = join(dir, 'user'); const sys = join(dir, 'sys'); const snap = join(dir, 'snapd', 'applications');
  for (const d of [user, sys, snap]) mkdirSync(d, { recursive: true });
  writeFileSync(join(sys, 'org.gnome.Calculator.desktop'), entry('Calculator', 'Keywords=calculation;arithmetic;'));
  writeFileSync(join(sys, 'org.gnome.Nautilus.desktop'), entry('Files', 'GenericName=File Manager'));
  writeFileSync(join(sys, 'org.gnome.Settings.desktop'), entry('Settings'));
  writeFileSync(join(sys, 'nvidia-settings.desktop'), entry('NVIDIA X Server Settings'));
  writeFileSync(join(sys, 'hidden.desktop'), entry('Ghost', 'Hidden=true'));
  writeFileSync(join(sys, 'link.desktop'), '[Desktop Entry]\nType=Link\nName=Some link\n');
  writeFileSync(join(snap, 'code_code.desktop'), entry('Visual Studio Code').replace('/usr/bin/visual-studio-code', 'env BAMF=1 /snap/bin/code'));
  writeFileSync(join(sys, 'code-url-handler.desktop'), entry('Visual Studio Code - URL Handler', 'NoDisplay=true'));
  writeFileSync(join(user, 'org.gnome.Calculator.desktop'), entry('Calculator', 'Comment=user override wins\nKeywords=arithmetic;'));
  return { dir, dirs: [user, sys, snap] };
}

test('desktop entries: parse main group only; user dir overrides system; links/hidden skipped; snap source tagged', () => {
  const e = parseDesktopEntry(entry('Calculator', 'Keywords=a;b;'));
  assert.equal(e.Name, 'Calculator'); assert.equal(e.Keywords, 'a;b;');
  const { dir, dirs } = appsDir();
  try {
    const apps = loadApps(dirs);
    const ids = apps.map((a) => a.id).sort();
    assert.ok(!ids.includes('hidden') && !ids.includes('link'));
    assert.equal(apps.filter((a) => a.id === 'org.gnome.Calculator').length, 1);
    assert.equal(apps.find((a) => a.id === 'code_code').source, 'snap');
    assert.equal(apps.find((a) => a.id === 'code_code').bin, 'code', 'env wrappers are skipped when finding the binary');
    assert.ok(apps.find((a) => a.id === 'org.gnome.Calculator').path.startsWith(dirs[0]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('app matching: exact, typo, alias, generic name, binary; NoDisplay handlers lose; nothing for junk', () => {
  const { dir, dirs } = appsDir();
  try {
    const apps = loadApps(dirs);
    const top = (q) => findApps(apps, q)[0]?.a.id;
    assert.equal(top('calculator'), 'org.gnome.Calculator');
    assert.equal(top('calculater'), 'org.gnome.Calculator', 'one typo');
    assert.equal(top('vs code'), 'code_code', 'alias');
    assert.equal(top('code'), 'code_code', 'binary name; the hidden URL handler ranks below');
    assert.equal(top('file manager'), 'org.gnome.Nautilus');
    assert.equal(top('settings'), 'org.gnome.Settings', 'exact name beats a longer match');
    assert.equal(findApps(apps, 'zzzzqq').length, 0);
    assert.ok(scoreApp(apps.find((a) => a.id === 'org.gnome.Calculator'), 'arithmetic') > 0, 'keywords count');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shell: output, exit code, stdin closed (no hang), timeout kills the whole group, output capped, catastrophic refused', async () => {
  const ok = await runShell({ command: 'echo hi; echo err >&2; exit 3', cwd: tmpdir() });
  assert.equal(ok.stdout.trim(), 'hi'); assert.equal(ok.stderr.trim(), 'err'); assert.equal(ok.code, 3); assert.equal(ok.timedOut, false);
  const input = await runShell({ command: 'read x; echo "got:$x"', timeoutMs: 5000 });
  assert.equal(input.stdout.trim(), 'got:', 'stdin is closed, read returns at once');
  const t0 = Date.now();
  const slow = await runShell({ command: 'sleep 30 | cat', timeoutMs: 1000 });
  assert.equal(slow.timedOut, true); assert.ok(Date.now() - t0 < 6000, 'killed, not waited out');
  const big = await runShell({ command: 'head -c 200000 /dev/zero | tr "\\0" a', maxChars: 5000 });
  assert.ok(big.stdout.length < 5200 && /chars cut/.test(big.stdout));
  for (const c of ['rm -rf /', 'rm -rf ~', 'sudo rm -fr $HOME', 'rm -rf /home/someone', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/nvme0n1', ':(){ :|:& };:']) assert.ok(catastrophic(c), c);
  for (const c of ['rm -rf ./build', 'rm -rf ~/tmp/x', 'ls /', 'echo rm -rf']) assert.ok(!catastrophic(c), c);
  await assert.rejects(runShell({ command: 'rm -rf /' }), /refused/);
});

test('home paths: ~ expands; outside home and credential files are refused', () => {
  assert.equal(homePath('~', { mustExist: true }), homedir());
  assert.throws(() => homePath('/etc/passwd'), /path_not_allowed/);
  assert.throws(() => homePath('~/../../etc/hosts', { mustExist: false }), /path_not_allowed/);
  for (const p of ['~/.ssh/id_ed25519', '~/proj/.env', '~/.friday-node/config.json', '~/keys/server.pem', '~/.local/share/keyrings/login.keyring']) assert.throws(() => homePath(p, { mustExist: false }), /sensitive_file_blocked/, p);
  assert.ok(homePath('~/notes/new-file.txt', { mustExist: false }).endsWith('/notes/new-file.txt'));
});

// A fake input-helper process speaking the JSON-lines protocol.
function fakeSpawn(log, { fail = false } = {}) {
  return () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.kill = () => {};
    p.stdin = { write: (line) => { const c = JSON.parse(line); log.push(c); setImmediate(() => p.stdout.emit('data', `${JSON.stringify(c.op === 'boom' ? { id: c.id, ok: false, error: 'bad' } : { id: c.id, ok: true })}\n`)); }, end: () => {} };
    setImmediate(() => p.stdout.emit('data', `${JSON.stringify(fail ? { ready: false, error: 'uinput_unavailable: Permission denied' } : { ready: true })}\n`));
    return p;
  };
}

test('input device: lazy start, JSON-lines round trip, errors surface, lastInjectAt tracks Friday\'s own input', async () => {
  const log = [];
  const dev = new InputDevice({ spawnImpl: fakeSpawn(log) });
  assert.equal(dev.lastInjectAt, 0);
  await dev.send({ op: 'key', keys: 'ctrl+l' });
  assert.ok(dev.lastInjectAt > 0);
  await assert.rejects(dev.send({ op: 'boom' }), /bad/);
  assert.deepEqual(log.map((c) => c.op), ['key', 'boom']);
  dev.close();
  await assert.rejects(new InputDevice({ spawnImpl: fakeSpawn([], { fail: true }) }).send({ op: 'key', keys: 'a' }), /Permission denied/);
});

function rig(o = {}) {
  const log = [];
  const input = new InputDevice({ spawnImpl: fakeSpawn(log) });
  const st = { locked: false, idle: 60_000, windows: [{ app: 'gnome-calculator', index: 3, windows: [{ ref: '3.0', name: 'Calculator', active: true }] }], acts: [], launched: [], clip: 'old clip' };
  const apps = [{ id: 'org.gnome.Calculator', name: 'Calculator', generic: '', keywords: [], exec: '/usr/bin/gnome-calculator', bin: 'gnome-calculator', path: '/x/org.gnome.Calculator.desktop', source: 'desktop', hidden: false, dbus: false }];
  const d = makeDesktop({
    input, sleep: () => new Promise((r) => setTimeout(r, 1)), idle: async () => st.idle, locked: async () => st.locked, geometry: async () => ({ width: 1920, height: 1080, monitors: [] }),
    a11y: async (cmd, a) => { if (cmd === 'windows') return { apps: st.windows }; if (cmd === 'act') { st.acts.push(a); if (o.noCloseAction) throw new Error('no_such_action'); return { ok: true }; } return { elements: [] }; },
    clip: async (cmd, a) => { if (cmd === 'clip_get') return { text: st.clip }; st.clip = a.text; return { ok: true }; },
    launch: async (cmd, args) => { st.launched.push(args.at(-1)); return { pid: 1 }; }, exec: async () => '', loadAppList: () => apps,
  });
  return { d, log, st, input };
}

test('desktop input: ASCII typed in chunks, unicode pasted via clipboard (and the old clipboard restored), pointer in fractions', async () => {
  const { d, log, st } = rig();
  await d.type_text({ text: 'x'.repeat(90) });
  assert.deepEqual(log.filter((c) => c.op === 'type').map((c) => c.text.length), [40, 40, 10]);
  log.length = 0;
  assert.equal((await d.type_text({ text: 'नमस्ते 👋' })).method, 'paste');
  assert.deepEqual(log.map((c) => c.keys), ['ctrl+v']);
  await new Promise((r) => setImmediate(r));
  assert.equal(st.clip, 'old clip', 'clipboard restored after the paste');
  log.length = 0;
  await d.mouse_click({ x: 960, y: 540 });
  assert.deepEqual([log[0].op, log[0].x, log[0].y], ['click', 0.5, 0.5]);
  await assert.rejects(d.mouse_click({ x: 5000, y: 10 }), /outside the desktop/);
  await d.mouse_scroll({ dy: 999 });
  assert.equal(log.at(-1).dy, 50, 'scroll is clamped');
});

test('desktop input: refused while the screen is locked or the HUMAN is typing; Friday\'s own input does not count as the human', async () => {
  const { d, st, input } = rig();
  st.locked = true;
  await assert.rejects(d.key_press({ keys: 'ctrl+l' }), /screen_locked/);
  st.locked = false; st.idle = 200; // someone touched the machine 200 ms ago...
  input.lastInjectAt = 0;
  await assert.rejects(d.key_press({ keys: 'ctrl+l' }), /user_active/);
  input.lastInjectAt = Date.now(); // ...but it was Friday's own keystroke
  assert.deepEqual(await d.key_press({ keys: 'ctrl+l' }), { pressed: 'ctrl+l' });
});

test('apps and windows: open waits for the window; focus of a running app uses the overview (no second window); close is exact', async () => {
  const { d, st, log } = rig();
  st.windows = [];
  const opened = d.open_app({ name: 'calculater' });
  setTimeout(() => { st.windows = [{ app: 'gnome-calculator', index: 3, windows: [{ ref: '3.0', name: 'Calculator', active: true }] }]; }, 5);
  const o = await opened;
  assert.equal(o.launched, 'org.gnome.Calculator'); assert.equal(o.focused, true);
  await assert.rejects(d.open_app({ name: 'photoshop' }), /app_not_found/);
  st.launched.length = 0;
  st.windows[0].windows[0].active = false;
  await d.window_focus({ app: 'calculator' });
  assert.equal(st.launched.length, 0, 'running app is not launched again');
  assert.deepEqual(log.slice(0, 3).map((c) => c.keys ?? c.text), ['super', 'Calculator', 'Return']);
  st.windows[0].windows.push({ ref: '3.1', name: 'Calculator — 2' });
  assert.equal((await d.window_close({ app: 'calculator' })).error, 'several_windows');
  const c = await d.window_close({ app: 'calculator', all: true });
  assert.equal(c.closed, 2); assert.deepEqual(st.acts.map((a) => a.ref), ['3.1', '3.0'], 'highest ref first so refs stay valid');
});

test('window close without an accessibility action: Alt+F4 only when the target is the only focused window', async () => {
  const { d, st, log } = rig({ noCloseAction: true });
  st.windows = [{ app: 'gnome-calculator', index: 3, windows: [{ ref: '3.0', name: 'Calculator', active: true }] }, { app: 'claude-desktop', index: 4, windows: [{ ref: '4.0', name: 'Claude', active: true }] }];
  const r = await d.window_close({ app: 'calculator' });
  assert.equal(r.error, 'focus_unverified'); assert.equal(log.length, 0, 'nothing pressed');
  st.windows[1].windows[0].active = false;
  assert.equal((await d.window_close({ app: 'calculator' })).via, 'alt+F4');
  assert.equal(log.at(-1).keys, 'alt+F4');
});

test('launchDetached: fast success, failure exit code, long-running app returns after the grace period', async () => {
  assert.ok((await launchDetached('true', [], { graceMs: 2000 })).pid);
  await assert.rejects(launchDetached('false', [], { graceMs: 2000 }), /exited with 1/);
  const t0 = Date.now(); const r = await launchDetached('sleep', ['3'], { graceMs: 100 });
  assert.ok(Date.now() - t0 < 1500); process.kill(r.pid);
});

test('python helpers compile', () => {
  for (const f of ['input-helper.py', 'desktop-helper.py', 'atspi-helper.py']) execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', join(HERE, '..', f)]);
});

test('restricted mode (fullAccess=false) keeps only the old browser-era desktop actions', () => {
  const d = makeDesktop({ allowedDirs: [tmpdir()], fullAccess: false, input: new InputDevice({ spawnImpl: fakeSpawn([]) }) });
  assert.ok(d.open_app && d.file_find && d.windows_list);
  assert.equal(d.shell_run, undefined); assert.equal(d.key_press, undefined); assert.equal(d.screen_capture, undefined);
});
