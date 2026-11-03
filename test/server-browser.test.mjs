import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeHub, SERVER_BROWSER_ID } from '../src/nodes.mjs';
import { Auth } from '../src/auth.mjs';
import { Store } from '../src/store.mjs';
import { pickWhere } from '../src/agent/friday-tools.mjs';
import { Sources } from '../src/research/sources.mjs';

const fakeRes = () => { const r = new EventEmitter(); r.out = []; r.writeHead = () => {}; r.write = (x) => { r.out.push(x); return true; }; r.end = () => {}; return r; };
function hub({ laptop = true, server = true } = {}) {
  const h = new NodeHub();
  const res = {};
  if (laptop) { res.laptop = fakeRes(); h.attach('dev-laptop', 'laptop', res.laptop, new EventEmitter()); h.hello('dev-laptop', { caps: ['shell_run', 'browser_open', 'research_search'] }); }
  if (server) { res.server = fakeRes(); h.attach(SERVER_BROWSER_ID, 'server browser', res.server, new EventEmitter()); h.hello(SERVER_BROWSER_ID, { caps: ['browser_open', 'browser_snapshot', 'research_search', 'research_read'] }); }
  const sentTo = () => Object.entries(res).filter(([, r]) => r.out.some((x) => x.startsWith('event: command'))).map(([k]) => k);
  return { h, res, sentTo };
}

test('the server browser never stands in for the laptop: online/list/default dispatch mean the laptop only', async () => {
  const { h, sentTo } = hub({ laptop: false });
  assert.equal(h.online, false, 'laptop-only features still see "laptop offline"');
  assert.deepEqual(h.list(), []);
  await assert.rejects(h.dispatch({ action: 'shell_run', timeoutMs: 50 }), /node_offline/);
  await assert.rejects(h.dispatch({ action: 'shell_run', where: 'server', timeoutMs: 50 }), /node_lacks_capability/, 'no shell on the server browser');
  assert.deepEqual(sentTo(), []);
  assert.equal(h.listAll()[0].role, 'server');
});

test('where routing: server, laptop, auto (server first, laptop fallback); scoped view pins one side', async () => {
  const { h, res, sentTo } = hub();
  void h.dispatch({ action: 'browser_open', where: 'server', timeoutMs: 50 }).catch(() => {});
  assert.deepEqual(sentTo(), ['server']);
  res.server.out.length = 0;
  void h.dispatch({ action: 'browser_open', timeoutMs: 50 }).catch(() => {});
  assert.deepEqual(sentTo(), ['laptop'], 'default stays the laptop');
  res.laptop.out.length = 0;
  void h.dispatch({ action: 'shell_run', where: 'auto', timeoutMs: 50 }).catch(() => {});
  assert.deepEqual(sentTo(), ['laptop'], 'auto falls back to the laptop for what the server cannot do');
  const s = h.scoped('server');
  assert.equal(s.online, true); assert.equal(s.list()[0].role, 'server');
  h.detach(SERVER_BROWSER_ID);
  assert.equal(s.online, false); assert.equal(h.online, true);
});

test('computer_task routing: laptop when he says so or it needs his logins/apps/files; else the server browser', () => {
  const { h } = hub();
  assert.equal(pickWhere({ goal: 'find the cheapest flight from Mumbai to Goa on 12 Dec on makemytrip' }, h), 'server');
  assert.equal(pickWhere({ goal: 'send Siddhi the photo on WhatsApp' }, h), 'laptop');
  assert.equal(pickWhere({ goal: 'open my Gmail and archive newsletters' }, h), 'laptop');
  assert.equal(pickWhere({ goal: 'check the IRCTC status on my laptop' }, h), 'laptop');
  assert.equal(pickWhere({ goal: 'look up the opening hours', where: 'laptop' }, h), 'laptop');
  assert.equal(pickWhere({ goal: 'look up the opening hours' }, hub({ server: false }).h), 'laptop', 'no server browser: laptop');
});

test('research searches through the server browser first, the laptop when the server browser is gone', async () => {
  const { h, sentTo, res } = hub();
  const src = new Sources({ nodes: h, env: {} });
  assert.equal(src.where(), 'server');
  void src.search('qdrant'); await new Promise((r) => setImmediate(r));
  assert.deepEqual(sentTo(), ['server']);
  res.server.out.length = 0; h.detach(SERVER_BROWSER_ID);
  assert.equal(src.where(), 'laptop');
});

test('service secret: node scope only, exact match, short secrets ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-auth-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const a = new Auth(store, 'o'.repeat(40));
    a.addService('short', { kind: 'device', id: 'x', scopes: ['node'] });
    assert.equal(a.authenticate('short'), null);
    const secret = 's'.repeat(64);
    a.addService(secret, { kind: 'device', id: SERVER_BROWSER_ID, name: 'server browser', scopes: ['node'] });
    assert.deepEqual(a.authenticate(secret).scopes, ['node']); assert.equal(a.authenticate(secret).id, SERVER_BROWSER_ID);
    assert.equal(a.authenticate(`${secret}x`), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
