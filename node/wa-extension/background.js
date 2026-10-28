// Relays commands between the Friday laptop node (local HTTP on 127.0.0.1, token from config.js) and the WhatsApp tab.
// Long-polls the node for the next command, hands it to the content script over its port, posts the result back.
importScripts('config.js');
const { port: PORT, token: TOKEN } = self.FRIDAY_WA ?? {};
const BASE = `http://127.0.0.1:${PORT}`;
let tabPort = null; const waiting = new Map();

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'friday-wa') return;
  tabPort = p;
  p.onMessage.addListener((m) => { if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } });
  p.onDisconnect.addListener(() => { if (tabPort === p) tabPort = null; });
  loop();
});

const ask = (cmd) => new Promise((resolve) => {
  if (!tabPort) return resolve({ error: 'no WhatsApp Web tab open in Chrome' });
  waiting.set(cmd.id, resolve);
  tabPort.postMessage(cmd);
  setTimeout(() => { if (waiting.delete(cmd.id)) resolve({ error: 'the WhatsApp tab did not answer in time' }); }, 20_000);
});

let running = false;
async function loop() {
  if (running || !PORT || !TOKEN) return;
  running = true;
  while (tabPort) {
    try {
      const r = await fetch(`${BASE}/wa/next`, { headers: { 'x-friday-wa': TOKEN }, signal: AbortSignal.timeout(28_000) });
      if (r.status === 204) continue;
      if (!r.ok) { await new Promise((s) => setTimeout(s, 2000)); continue; }
      const cmd = await r.json();
      const result = await ask(cmd);
      await fetch(`${BASE}/wa/result`, { method: 'POST', headers: { 'x-friday-wa': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ id: cmd.id, result }) });
    } catch { await new Promise((s) => setTimeout(s, 1500)); } // node restarting: try again
  }
  running = false;
}
