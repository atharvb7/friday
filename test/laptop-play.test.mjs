import test from 'node:test';
import assert from 'node:assert/strict';
import { findYouTube, buildFridayTools } from '../src/agent/friday-tools.mjs';

const page = (items) => `<script>var ytInitialData = {"contents":[${items.map(([id, t, ch]) => `{"videoRenderer":{"videoId":"${id}","title":{"runs":[{"text":"${t}"}]},"ownerText":{"runs":[{"text":"${ch}"}]}}}`).join(',')}]};</script>`;
const res = (body, ok = true) => ({ ok, text: async () => body });

test('findYouTube: first videoRenderer wins; escaped titles decode; no result -> null', async () => {
  const r = await findYouTube('starboy', { fetchImpl: async (url) => { assert.match(url, /search_query=starboy/); return res(page([['34Na4j8AVgA', 'The Weeknd - Starboy \\u0026 Daft Punk', 'The Weeknd'], ['xxxxxxxxxxx', 'cover', 'x']])); } });
  assert.deepEqual(r, { id: '34Na4j8AVgA', title: 'The Weeknd - Starboy & Daft Punk', channel: 'The Weeknd' });
  assert.equal(await findYouTube('zzz', { fetchImpl: async () => res('<html>no data</html>') }), null);
  assert.equal(await findYouTube('zzz', { fetchImpl: async () => res('', false) }), null);
});

test('laptop_play: pauses other media, opens the video in Brave, reports what plays; offline is honest', async () => {
  const sent = [];
  const nodes = { online: true, list: () => [], dispatch: async (m) => { sent.push(m); return m.action === 'shell_run' ? { code: 0, stdout: /brave-browser/.test(m.args.command) ? 'ok\n' : '' } : { ok: true }; } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => res(page([['34Na4j8AVgA', 'The Weeknd - Starboy', 'The Weeknd']]));
  try {
    const tool = buildFridayTools({ nodes, store: {}, memory: {} }).get('laptop_play');
    const out = await tool.run({ query: 'Starboy The Weeknd' });
    assert.equal(out.playing, 'The Weeknd - Starboy'); assert.equal(out.browser, 'brave');
    assert.match(sent[0].args.command, /org\.mpris\.MediaPlayer2\.Player\.Pause/, 'pauses whatever plays first');
    assert.match(sent[1].args.command, /brave-browser 'https:\/\/www\.youtube\.com\/watch\?v=34Na4j8AVgA'/);
    assert.match(sent[2].args.command, /Player\.Play/, 'then presses play once Brave shows the video (unseen tabs never autoplay)');
    assert.match(sent[2].args.command, /N='Starboy'/, 'recognises the tab by a key word of the title');
    nodes.online = false;
    assert.equal((await tool.run({ query: 'x' })).error, 'laptop_offline');
  } finally { globalThis.fetch = realFetch; }
});
