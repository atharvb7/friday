import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Settings } from '../src/settings.mjs';
import { ChatStore } from '../src/chat.mjs';
import { WaChats, pendingFromThem, sameContact } from '../src/wa-chat.mjs';

function rig({ header = 'Gauri Vardhamane (Samyak)' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-wa-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const settings = new Settings(store); settings.set('user_name', 'Atharv');
  const chat = new ChatStore(store);
  const convo = chat.createConversation('t');
  const world = { front: 'WhatsApp - Google Chrome', hash: 'h1', messages: [{ from: 'me', text: 'hey gauri, friday here' }, { from: 'them', text: 'wait, you actually talk about me?' }], header, typed: [], calls: [] };
  const nodes = { online: true, dispatch: async ({ action, args }) => {
    world.calls.push(action);
    if (action === 'windows_list') return { apps: [{ app: 'Google Chrome', windows: [{ name: world.front, active: true }] }] };
    if (action === 'screen_capture') return { mime: 'image/jpeg', base64: 'AAAA', screen: { width: 1920, height: 1080 } };
    if (action === 'screen_info') return { width: 1920, height: 1080 };
    if (action === 'screen_region') return { hash: world.hash, ...(args.image ? { mime: 'image/jpeg', base64: 'BBBB' } : {}) };
    if (action === 'type_text') world.typed.push(args.text);
    return { ok: true };
  } };
  const ai = { calls: [], run: async (role, o) => {
    ai.calls.push(role);
    const prompt = role === 'vision' ? o.messages[0].content[0].text : '';
    if (role === 'vision' && /screenshot of a laptop desktop/.test(prompt)) return { content: JSON.stringify({ whatsapp_visible: true, chat_name: world.header, messages_box: [300, 100, 990, 880], compose: [640, 940], search: [150, 120] }) };
    if (role === 'vision') return { content: JSON.stringify({ messages: world.messages }) };
    return { content: JSON.stringify({ reply: 'haha maybe 👀 only good things tho', needs_owner: null, end: false }) };
  } };
  const notes = [];
  const wa = new WaChats({ store, ai, nodes, chat, notifications: { create: (n) => notes.push(n) }, bus: null, settings, sleep: async () => {} });
  return { store, chat, convo, world, ai, wa, notes, done: () => { wa.stop_timer(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('wa helpers: a cut-off JSON read still yields every message (the newest one included)', async () => {
  const { parseMessages } = await import('../src/wa-chat.mjs');
  const cut = '{"messages": [{"from": "me", "text": "Hey Siddhi"}, {"from": "them", "text": "Heyyy fridayyy \\ud83d\\ude0a\\nthe delusion is kinda cute"}';
  const m = parseMessages(cut);
  assert.equal(m.length, 2); assert.equal(m[1].from, 'them'); assert.match(m[1].text, /delusion is kinda cute/);
  assert.equal(parseMessages('{"messages":[{"from":"them","text":"hi"}]}').length, 1);
});

test('wa helpers: answer the burst after our last message once; contact match is by first name', () => {
  assert.deepEqual(pendingFromThem([{ from: 'them', text: 'a' }, { from: 'me', text: 'b' }, { from: 'them', text: 'c' }, { from: 'them', text: 'd' }]).texts, ['c', 'd']);
  assert.equal(pendingFromThem([{ from: 'them', text: 'a' }, { from: 'me', text: 'b' }]).sig, null);
  assert.ok(sameContact('Gauri Vardhamane (Samyak)', 'gauri vardhamane'));
  assert.ok(!sameContact('Siddhi Jadhav', 'Gauri'));
});

test('wa chat: replies to her latest message in the open chat, then costs nothing until the chat changes; never answers twice', async () => {
  const r = rig();
  try {
    const started = await r.wa.start({ contact: 'Gauri Vardhamane', minutes: 30, conversationId: r.convo.id });
    assert.equal(started.contact, 'Gauri Vardhamane'); assert.ok(started.chatting_until);
    await r.wa.tick();
    assert.deepEqual(r.world.typed, ['haha maybe 👀 only good things tho'], 'typed the reply into the open chat');
    assert.ok(r.world.calls.includes('key_press'));
    const modelCalls = r.ai.calls.length;
    await r.wa.tick(); await r.wa.tick();
    assert.equal(r.ai.calls.length, modelCalls, 'same fingerprint: no vision, no chat model');
    r.world.hash = 'h2'; await r.wa.tick(); // something moved but her latest burst is the same one -> no second reply
    assert.equal(r.world.typed.length, 1);
    r.world.messages = [...r.world.messages, { from: 'me', text: 'haha maybe 👀 only good things tho' }, { from: 'them', text: 'okay byee' }]; r.world.hash = 'h3';
    await r.wa.tick();
    assert.equal(r.world.typed.length, 2, 'a new message gets a new reply');
    assert.ok(r.chat.historyForProvider(r.convo.id, 20).some((m) => /okay byee/.test(m.content)), 'he sees the exchange in his chat');
  } finally { r.done(); }
});

test('wa chat: never types when WhatsApp is not the window in front; wrong chat open -> it opens the right one first', async () => {
  const r = rig();
  try {
    await r.wa.start({ contact: 'Gauri', minutes: 10 });
    r.world.front = 'Friday - Google Chrome';
    await r.wa.tick();
    assert.equal(r.world.typed.length, 0);
    assert.match(r.wa.list()[0].last_note, /not the window in front/);
  } finally { r.done(); }
  const w = rig({ header: 'Siddhi Jadhav' });
  try {
    const out = await w.wa.start({ contact: 'Gauri', minutes: 10 });
    assert.match(out.error, /could not open the chat with Gauri/, 'searched, but the header still shows someone else: no session');
    assert.deepEqual(w.world.typed, ['Gauri'], 'only the search box was typed into');
    assert.equal(w.wa.list().length, 0);
  } finally { w.done(); }
});

test('wa chat: finds the WhatsApp tab by the window title (Ctrl+Tab), never types into another tab', async () => {
  const r = rig();
  try {
    r.world.front = 'Friday - Google Chrome';
    let tabs = 0; const dispatch = r.wa.nodes.dispatch;
    r.wa.nodes.dispatch = async (m) => { if (m.action === 'key_press' && m.args.keys === 'ctrl+Tab' && ++tabs === 2) r.world.front = '(3) WhatsApp - Google Chrome'; return dispatch(m); };
    const out = await r.wa.start({ contact: 'Gauri', minutes: 10 });
    assert.ok(out.chatting_until, JSON.stringify(out)); assert.equal(tabs, 2);
    const none = rig(); none.world.front = 'Friday - Google Chrome';
    try { assert.match((await none.wa.start({ contact: 'Gauri' })).error, /no WhatsApp Web tab/); assert.deepEqual(none.world.typed, [], 'nothing typed anywhere'); } finally { none.done(); }
  } finally { r.done(); }
});

test('wa chat: stop ends it; one session per person; time cap', async () => {
  const r = rig();
  try {
    await r.wa.start({ contact: 'Gauri', minutes: 10 });
    await r.wa.start({ contact: 'Gauri V', minutes: 10 });
    assert.equal(r.wa.list().length, 1, 'starting again replaces, never doubles');
    assert.equal(r.wa.stop('gauri'), 1);
    assert.equal(r.wa.list().length, 0);
    await r.wa.tick();
    assert.equal(r.world.typed.length, 0);
  } finally { r.done(); }
});

test('stop_everything: tasks, watches and live chats all stop in one call; counts are real; reminders stay', async () => {
  const { createContext } = await import('../src/context.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'friday-stop-'));
  const ctx = createContext({ appRoot: new URL('..', import.meta.url).pathname, env: { FRIDAY_DATA_DIR: dir } });
  try {
    ctx.store.createTask({ title: 'Laptop: reply to Gauri', kind: 'computer', instruction: 'x' });
    ctx.store.db.prepare("INSERT INTO watches (id, title, kind, target, condition, every_min, action, repeat, status, created_at, expires_at) VALUES ('a1b2c3d4-0000-0000-0000-000000000000','w','laptop','t','c',15,'{\"kind\":\"notify\"}',0,'active',?,?)").run(new Date().toISOString(), new Date(Date.now() + 7200e3).toISOString());
    ctx.store.db.prepare("INSERT INTO wa_chats (id, contact, until, created_at) VALUES ('wa1','Gauri',?,?)").run(new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString());
    ctx.jobs.create({ title: 'drink water', when: new Date(Date.now() + 3600e3).toISOString() });
    const out = ctx.fridayTools.get('stop_everything').run({});
    assert.deepEqual(out.stopped, { tasks: 1, watches: 1, chats: 1 });
    assert.equal(out.still_scheduled_reminders_and_jobs, 1);
    assert.equal(ctx.watches.list('active').length, 0); assert.equal(ctx.waChats.list().length, 0);
  } finally { ctx.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('wa chat via the Chrome extension: no screenshots or mouse; answers her newest message by id, once', async () => {
  const r = rig();
  try {
    const sent = []; let msgs = [{ id: 'true_1', from: 'me', text: 'Hey Siddhi, Friday here' }, { id: 'false_2', from: 'them', text: 'the delusion is kinda cute' }];
    r.wa.nodes.list = () => [{ caps: ['wa_status', 'wa_read', 'wa_open', 'wa_send', 'screen_region'] }];
    r.wa.nodes.dispatch = async ({ action, args }) => {
      r.world.calls.push(action);
      if (action === 'wa_status') return { connected: true, loggedIn: true, chat: 'Siddhi Jadhav UAI' };
      if (action === 'wa_open') return { chat: 'Siddhi Jadhav UAI' };
      if (action === 'wa_read') return { chat: 'Siddhi Jadhav UAI', messages: msgs };
      if (action === 'wa_send') { sent.push(args.text); msgs = [...msgs, { id: `true_${msgs.length + 1}`, from: 'me', text: args.text }]; return { sent: true }; }
      throw new Error(`unexpected ${action}`);
    };
    const out = await r.wa.start({ contact: 'Siddhi Jadhav', minutes: 10 });
    assert.equal(out.chat, 'Siddhi Jadhav UAI');
    await r.wa.tick(); await r.wa.tick();
    assert.equal(sent.length, 1, 'answered once');
    msgs = [...msgs, { id: 'false_9', from: 'them', text: 'lol okay' }];
    await r.wa.tick();
    assert.equal(sent.length, 2);
    assert.ok(!r.world.calls.some((a) => ['screen_region', 'screen_capture', 'mouse_click', 'type_text'].includes(a)), r.world.calls.join(','));
    assert.ok(!r.ai.calls.includes('vision'), 'no vision model needed');
  } finally { r.done(); }
});

test('Friday speaks as a woman in Hinglish: masculine first-person forms are fixed before sending; third person untouched', async () => {
  const { feminize, buildSystemPrompt, normalizePersonality } = await import('../src/personality.mjs');
  assert.equal(feminize('tumhe block karwa dunga main'), 'tumhe block karwa dungi main');
  assert.equal(feminize('Main abhi aa raha hoon'), 'Main abhi aa rahi hoon');
  assert.equal(feminize('main bata sakta hu, kal milunga'), 'main bata sakti hu, kal milungi');
  assert.equal(feminize('mai so gaya tha lol'), 'mai so gayi thi lol');
  assert.equal(feminize('woh gaya tha market, Atharv aa raha tha'), 'woh gaya tha market, Atharv aa raha tha', 'he/she sentences stay');
  assert.equal(feminize('I will be there at 9'), 'I will be there at 9');
  assert.match(buildSystemPrompt({ personality: normalizePersonality({}) }), /FEMININE first-person/);
  const r = rig();
  try {
    r.wa.ai.run = async (role) => (role === 'vision' ? { content: JSON.stringify({ whatsapp_visible: true, chat_name: 'Gauri', messages_box: [300, 100, 990, 880], compose: [640, 940], search: [150, 120] }) } : { content: '{"reply":"haan haan, main bata dunga use","end":false}' });
    r.world.messages = [{ from: 'them', text: 'tell him' }];
    await r.wa.start({ contact: 'Gauri', minutes: 5 });
    // the read call goes through the same stub: make it return messages
    const run = r.wa.ai.run; r.wa.ai.run = async (role, o) => (role === 'vision' && !/laptop desktop/.test(o.messages[0].content[0].text) ? { content: JSON.stringify({ messages: r.world.messages }) } : run(role, o));
    await r.wa.tick();
    assert.deepEqual(r.world.typed, ['haan haan, main bata dungi use']);
  } finally { r.done(); }
});
