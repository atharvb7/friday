import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMoves, categoryOf, cleanTarget, organizableDir, scanFolder, undoMoves } from '../organize.mjs';

const OLD = new Date(Date.now() - 3600_000);
function home() {
  const h = mkdtempSync(join(tmpdir(), 'friday-org-'));
  const dl = join(h, 'Downloads'); mkdirSync(dl);
  const put = (name, body = 'x') => { const p = join(dl, name); writeFileSync(p, body); utimesSync(p, OLD, OLD); return p; };
  put('Lab_Experiment_5.txt', 'LAB EXPERIMENT NO.: 5 Aim: file handling');
  put('Resume.pdf', 'same bytes'); put('Resume (1).pdf', 'same bytes');
  put('photo.JPG', 'img'); put('song.mp3', 'aud'); put('setup.deb', 'deb'); put('.hidden', 'h'); put('movie.mp4.crdownload', 'partial');
  put('aadhaar.txt', 'secret id number');
  mkdirSync(join(dl, 'proj')); writeFileSync(join(dl, 'proj', 'package.json'), '{}'); utimesSync(join(dl, 'proj'), OLD, OLD);
  mkdirSync(join(dl, 'MyApp')); writeFileSync(join(dl, 'MyApp', 'run'), 'x'); utimesSync(join(dl, 'MyApp'), OLD, OLD);
  mkdirSync(join(dl, 'friday-media')); utimesSync(join(dl, 'friday-media'), OLD, OLD);
  mkdirSync(join(h, '.local/share/applications'), { recursive: true });
  writeFileSync(join(h, '.local/share/applications/myapp.desktop'), `[Desktop Entry]\nExec=${join(dl, 'MyApp')}/run %F\n`);
  utimesSync(dl, OLD, OLD);
  return { h, dl, conf: join(h, '.friday-node') };
}
const noProc = (h) => ({ texts: [`Exec=${join(h, 'Downloads', 'MyApp')}/run %F`], paths: [] });

test('categories by extension, incl. .tar.gz and upper case', () => {
  assert.equal(categoryOf('a.PDF'), 'document'); assert.equal(categoryOf('x.tar.gz'), 'archive'); assert.equal(categoryOf('k.AppImage'), 'installer'); assert.equal(categoryOf('noext'), 'other');
});

test('scan: duplicates, pins (hidden, partial, launcher target, Fridayy folder), dir kinds, peeks skip sensitive names', async () => {
  const { h } = home();
  try {
    const r = await scanFolder({ dir: '~/Downloads', home: h, deps: noProc(h) });
    const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    assert.equal(by['Resume (1).pdf'].dupOf, 'Resume.pdf'); assert.equal(by['Resume (1).pdf'].suggest, 'Duplicates');
    assert.match(by['.hidden'].pinned, /hidden/); assert.match(by['movie.mp4.crdownload'].pinned, /in progress/);
    assert.match(by.MyApp.pinned, /launcher/); assert.match(by['friday-media'].pinned, /Fridayy/);
    assert.equal(by.proj.dir.kind, 'project'); assert.equal(by.proj.suggest, 'Projects');
    assert.match(by['Lab_Experiment_5.txt'].peek, /LAB EXPERIMENT/);
    assert.equal(by['aadhaar.txt'].peek, undefined, 'sensitive names are never peeked');
    assert.equal(by['photo.JPG'].suggest, 'Images'); assert.equal(by['setup.deb'].suggest, 'Installers');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('apply: moves inside the folder only, never overwrites, refuses pinned/escapes; undo restores and removes created folders', async () => {
  const { h, dl, conf } = home();
  try {
    mkdirSync(join(dl, 'Images')); writeFileSync(join(dl, 'Images', 'photo.JPG'), 'older'); utimesSync(join(dl, 'Images'), OLD, OLD);
    const r = await applyMoves({ dir: dl, home: h, confDir: conf, deps: noProc(h), moves: [
      { name: 'photo.JPG', to: 'Images' }, { name: 'song.mp3', to: 'Media/Audio' }, { name: 'Resume (1).pdf', to: 'Duplicates' },
      { name: 'setup.deb', to: '../escape' }, { name: '../Resume.pdf', to: 'X' }, { name: 'MyApp', to: 'Apps' }, { name: '.hidden', to: 'X' },
      { name: 'friday-media', to: 'Folders' }, { name: 'movie.mp4.crdownload', to: 'Videos' }, { name: 'Resume.pdf', to: 'Resume.pdf/sub' }, { name: 'gone.txt', to: 'X' },
      { name: 'Lab_Experiment_5.txt', to: 'College/Labs', size: 1 },
    ] });
    assert.equal(r.moved, 3);
    assert.ok(existsSync(join(dl, 'Images', 'photo (2).JPG')), 'renamed instead of overwriting');
    assert.equal(readdirSync(join(dl, 'Images')).length, 2);
    assert.ok(existsSync(join(dl, 'Media/Audio/song.mp3')));
    assert.ok(!existsSync(join(h, 'escape')));
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
    assert.equal(reasons['setup.deb'], 'bad target folder'); assert.equal(reasons['../Resume.pdf'], 'not an item of this folder');
    assert.match(reasons.MyApp, /launcher/); assert.equal(reasons['.hidden'], 'protected'); assert.equal(reasons['friday-media'], 'protected');
    assert.equal(reasons['Lab_Experiment_5.txt'], 'changed since the scan'); assert.equal(reasons['gone.txt'], 'no longer exists');
    assert.ok(existsSync(join(dl, 'MyApp/run')));
    const u = undoMoves({ undoId: r.undoId, confDir: conf });
    assert.equal(u.restored, 3);
    assert.ok(existsSync(join(dl, 'photo.JPG')) && existsSync(join(dl, 'song.mp3')) && existsSync(join(dl, 'Resume (1).pdf')));
    assert.ok(!existsSync(join(dl, 'Media')) && !existsSync(join(dl, 'Duplicates')), 'created folders removed');
    assert.ok(existsSync(join(dl, 'Images')), 'pre-existing folder kept');
    assert.match(undoMoves({ undoId: r.undoId, confDir: conf }).note, /already undone/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('only folders inside home, never home itself or hidden/config folders; target paths sanitized', () => {
  const { h } = home();
  try {
    assert.throws(() => organizableDir('~', { home: h }), /inside the home/);
    assert.throws(() => organizableDir('/tmp', { home: h }), /inside the home/);
    mkdirSync(join(h, '.config')); assert.throws(() => organizableDir('~/.config', { home: h }), /never reorganized/);
    assert.equal(organizableDir('~/Downloads', { home: h }), join(h, 'Downloads'));
    assert.deepEqual(cleanTarget('College / Lab: Experiments'), ['College', 'Lab Experiments']);
    assert.equal(cleanTarget('a/../b'), null); assert.equal(cleanTarget('.git'), null); assert.equal(cleanTarget('a/b/c/d'), null);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('on-screen apply: app moves are verified on disk; misses moved directly; extra items put back; name clashes never reach the app', async () => {
  const { h, dl, conf } = home();
  try {
    mkdirSync(join(dl, 'Audio')); writeFileSync(join(dl, 'Audio', 'song.mp3'), 'older'); utimesSync(join(dl, 'Audio'), OLD, OLD);
    const calls = [];
    const gui = async ({ dir, names, target, newFolder }) => {
      calls.push({ names: [...names].sort(), target, newFolder });
      if (newFolder) mkdirSync(target);
      for (const n of names) if (n !== 'setup.deb') renameSync(join(dir, n), join(target, n)); // "misses" setup.deb
      if (newFolder === 'Docs') renameSync(join(dir, 'aadhaar.txt'), join(target, 'aadhaar.txt')); // grabs an extra file
    };
    const r = await applyMoves({ dir: dl, home: h, confDir: conf, deps: noProc(h), gui, moves: [
      { name: 'Resume.pdf', to: 'Docs' }, { name: 'Resume (1).pdf', to: 'Docs' }, { name: 'setup.deb', to: 'Docs' },
      { name: 'song.mp3', to: 'Audio' }, { name: 'photo.JPG', to: 'Media/Images' },
    ] });
    assert.equal(r.moved, 5);
    assert.deepEqual(calls.find((c) => c.newFolder === 'Docs').names, ['Resume (1).pdf', 'Resume.pdf', 'setup.deb']);
    assert.ok(!calls.some((c) => c.names.includes('song.mp3')), 'same name in target: not sent to the app (it would ask "replace?")');
    assert.ok(existsSync(join(dl, 'Audio', 'song (2).mp3')));
    assert.ok(existsSync(join(dl, 'Docs', 'setup.deb')), 'what the app missed was moved directly');
    assert.ok(existsSync(join(dl, 'aadhaar.txt')) && !existsSync(join(dl, 'Docs', 'aadhaar.txt')), 'extra item put back');
    assert.equal(r.screen.putBack, 1); assert.equal(r.screen.onScreen, 3); assert.equal(r.screen.direct, 2);
    assert.equal(calls.find((c) => c.target.endsWith('Media/Images')).newFolder, undefined, 'nested target: parents made, app pastes');
    const u = undoMoves({ undoId: r.undoId, confDir: conf });
    assert.equal(u.restored, 5); assert.ok(!existsSync(join(dl, 'Docs')) && !existsSync(join(dl, 'Media')));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
