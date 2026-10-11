import test from 'node:test';
import assert from 'node:assert/strict';
import { Composio, classify } from '../src/composio.mjs';

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { const u = new URL(url); calls.push({ method: opts.method, path: u.pathname.replace('/api/v3.1', ''), q: u.search, body: opts.body ? JSON.parse(opts.body) : null, key: opts.headers['x-api-key'] });
    const h = routes[`${opts.method} ${u.pathname.replace('/api/v3.1', '')}`]; const [status, json] = h ? h(calls.at(-1)) : [404, { error: { message: 'nope' } }];
    return { ok: status < 300, status, json: async () => json }; };
  return { calls, fetchImpl };
}
const settingsMem = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };

test('composio: actions are classified; unknown actions refused; reads vs approval-needing actions', () => {
  assert.equal(classify('instagram', 'GET_USER_INFO').kind, 'read');
  assert.equal(classify('instagram', 'INSTAGRAM_SEND_TEXT_MESSAGE').kind, 'act');
  assert.equal(classify('instagram', 'delete_comment').kind, 'delete');
  assert.match(classify('instagram', 'DELETE_EVERYTHING').error, /action_not_allowed/);
  assert.equal(classify('tiktok', 'x').error, 'unknown_toolkit');
});

test('composio: managed auth config created once, connect link, status, execute, key never leaks', async () => {
  const f = fake({
    'GET /auth_configs': () => [200, { items: [] }],
    'POST /auth_configs': () => [201, { auth_config: { id: 'ac_1' } }],
    'POST /connected_accounts/link': (c) => [201, { redirect_url: 'https://connect.composio.dev/x', expires_at: 'soon', connected_account_id: 'ca_1', echo: c.body }],
    'GET /connected_accounts': () => [200, { items: [{ id: 'ca_1', toolkit: { slug: 'instagram' }, status: 'ACTIVE' }] }],
    'POST /tools/execute/INSTAGRAM_GET_USER_INFO': (c) => [200, { successful: true, data: { id: '178', username: 'atharv', user: c.body.user_id } }],
    'POST /tools/execute/INSTAGRAM_SEND_TEXT_MESSAGE': () => [400, { error: { message: 'bad key sk_secret123 outside window' } }],
  });
  const c = new Composio({ apiKey: 'sk_secret123', settings: settingsMem(), fetchImpl: f.fetchImpl });
  const l = await c.connectLink('instagram');
  assert.equal(l.url, 'https://connect.composio.dev/x');
  await c.connectLink('instagram');
  assert.equal(f.calls.filter((x) => x.method === 'POST' && x.path === '/auth_configs').length, 1, 'auth config remembered');
  assert.equal(f.calls.find((x) => x.path === '/connected_accounts/link').body.user_id, 'friday-owner');
  assert.equal((await c.status()).apps[0].connected, true);
  assert.deepEqual(await c.execute('instagram', 'GET_USER_INFO'), { data: { id: '178', username: 'atharv', user: 'friday-owner' } });
  await assert.rejects(() => c.execute('instagram', 'SEND_TEXT_MESSAGE', { text: 'hi', recipient_id: '1' }), (e) => !e.message.includes('sk_secret123') && /composio_400/.test(e.message));
  assert.ok(f.calls.every((x) => x.key === 'sk_secret123'));
  assert.equal(new Composio({ settings: settingsMem() }).configured, false);
});

test('composio: instagram publish = container, wait for processing, publish', async () => {
  let polls = 0;
  const f = fake({
    'POST /tools/execute/INSTAGRAM_GET_USER_INFO': () => [200, { successful: true, data: { id: '178' } }],
    'POST /tools/execute/INSTAGRAM_POST_IG_USER_MEDIA': (c) => [200, { successful: true, data: { id: 'cont_1', got: c.body.arguments } }],
    'POST /tools/execute/INSTAGRAM_GET_IG_MEDIA': () => [200, { successful: true, data: { status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' } }],
    'POST /tools/execute/INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH': (c) => [200, { successful: true, data: { id: 'media_9', creation: c.body.arguments.creation_id } }],
  });
  const c = new Composio({ apiKey: 'k', settings: settingsMem(), fetchImpl: f.fetchImpl, sleep: async () => {} });
  assert.deepEqual(await c.instagramPublish({ image_url: 'https://x/a.jpg', caption: 'hello' }), { published: true, media_id: 'media_9' });
  const cont = f.calls.find((x) => x.path.endsWith('POST_IG_USER_MEDIA'));
  assert.deepEqual(cont.body.arguments, { ig_user_id: '178', caption: 'hello', image_url: 'https://x/a.jpg' });
  assert.equal(f.calls.find((x) => x.path.endsWith('PUBLISH')).body.arguments.creation_id, 'cont_1');
  assert.match((await c.instagramPublish({ caption: 'x' })).error, /image_url or video_url/);
});

test('composio: Instagram 24h-window error is explained with a fallback instead of a raw 403', async () => {
  const f = fake({ 'POST /tools/execute/INSTAGRAM_SEND_TEXT_MESSAGE': () => [200, { successful: false, error: 'Failed to send message (status 403). Response: {"error":{"message":"This message is sent outside of allowed window.","code":10,"error_subcode":2534022}}' }] });
  const c = new Composio({ apiKey: 'k', settings: settingsMem(), fetchImpl: f.fetchImpl });
  const r = await c.execute('instagram', 'SEND_TEXT_MESSAGE', { recipient_id: '1', text: 'hi' });
  assert.equal(r.error, 'instagram_24h_window'); assert.match(r.explain, /24 hours[\s\S]*Allow access to messages/); assert.match(r.fallback, /computer_task/);
});
