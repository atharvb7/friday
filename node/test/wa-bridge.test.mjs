import test from 'node:test';
import assert from 'node:assert/strict';
import { WaBridge } from '../wa-bridge.mjs';

test('wa bridge: the extension long-polls a command and posts its result; token required; offline fails fast', async () => {
  const port = 47000 + Math.floor(Math.random() * 900);
  const b = new WaBridge({ port, token: 'tok' }).start();
  const base = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(() => b.command('status'), /wa_extension_offline/);
    assert.equal((await fetch(`${base}/wa/next`, { headers: { 'x-friday-wa': 'nope' } })).status, 403);
    // the "extension": poll, run, answer
    const ext = (async () => {
      const r = await fetch(`${base}/wa/next`, { headers: { 'x-friday-wa': 'tok' } });
      const cmd = await r.json();
      await fetch(`${base}/wa/result`, { method: 'POST', headers: { 'x-friday-wa': 'tok', 'content-type': 'application/json' }, body: JSON.stringify({ id: cmd.id, result: { chat: 'Siddhi', echo: cmd.op } }) });
    })();
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(b.connected, true);
    assert.deepEqual(await b.command('read', { chat: 'Siddhi' }), { chat: 'Siddhi', echo: 'read' });
    await ext;
  } finally { b.stop(); }
});
