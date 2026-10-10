import test from 'node:test';
import assert from 'node:assert/strict';
import { Companion, COMPANION_STATES } from '../src/companion.mjs';
import { EventBus } from '../src/events.mjs';

function rig(over = {}) {
  const bus = new EventBus();
  let t = 1_000_000;
  const world = { hasProvider: true, dshReady: true, stopped: false, running: [], approvals: 0, unread: 0, node: false };
  const ctx = {
    bus,
    ai: { get hasProvider() { return world.hasProvider; } },
    dshAdapter: { status: () => ({ ready: world.dshReady }) },
    state: { get emergencyStopped() { return world.stopped; } },
    governor: { getSnapshot: () => ({}) },
    worker: { running: { get size() { return world.running.length; }, keys: () => world.running.map((r) => r.id)[Symbol.iterator]() } },
    store: { getTask: (id) => world.running.find((r) => r.id === id) },
    approvals: { list: () => Array.from({ length: world.approvals }) },
    notifications: { unreadCount: () => world.unread },
    nodes: { get online() { return world.node; } },
  };
  Object.assign(world, over);
  const comp = new Companion({ ctx, now: () => t });
  const seen = [];
  bus.subscribe((e) => e.type === 'companion.state_changed' && seen.push(e.data.state));
  return { comp, bus, world, seen, tick: (ms) => { t += ms; } };
}

test('companion state is derived from real activity with a clear priority order', () => {
  const r = rig();
  assert.equal(r.comp.compute().state, 'idle');
  r.world.running = [{ id: 'a', kind: 'research', title: 'R' }];
  assert.equal(r.comp.compute().state, 'researching');
  r.world.running = [{ id: 'a', kind: 'coding', title: 'C' }]; assert.equal(r.comp.compute().state, 'coding');
  r.world.running = [{ id: 'a', kind: 'computer', title: 'L' }]; assert.equal(r.comp.compute().state, 'computer_use');
  r.world.approvals = 2; assert.equal(r.comp.compute().state, 'waiting', 'a pending approval outranks background work');
  r.comp.chatStart(); assert.equal(r.comp.compute().state, 'thinking', 'live conversation outranks waiting');
  r.comp.chatEnd();
  r.world.stopped = true; assert.equal(r.comp.compute().state, 'error');
  r.world.hasProvider = false; r.world.dshReady = false; assert.equal(r.comp.compute().state, 'offline');
  for (const s of ['idle', 'researching', 'waiting', 'thinking', 'error', 'offline']) assert.ok(COMPANION_STATES.includes(s));
});

test('companion: success/error flash then settle; transitions are emitted once each', () => {
  const r = rig();
  r.bus.publish('task.completed', { taskId: 'x' });
  assert.equal(r.comp.compute().state, 'success');
  assert.equal(r.comp.compute().pet, 'done');
  r.tick(7000);
  assert.equal(r.comp.compute().state, 'idle');
  r.bus.publish('task.failed', {});
  assert.equal(r.comp.compute().state, 'error');
  r.tick(7000);
  r.comp.chatStart(); r.comp.chatStart(); r.comp.chatEnd();
  assert.deepEqual(r.seen.filter((s, i, a) => s !== a[i - 1]), r.seen, 'no duplicate consecutive emissions');
  assert.ok(r.seen.includes('success') && r.seen.includes('error') && r.seen.includes('thinking'));
});

test('companion payload is compact for tiny devices', () => {
  const r = rig({ unread: 3, node: true });
  const c = r.comp.compute();
  assert.deepEqual(Object.keys(c).sort(), ['approvals', 'at', 'detail', 'nodeOnline', 'pet', 'state', 'unread']);
  assert.ok(JSON.stringify(c).length < 200);
});
