// Preloaded into the DSH process (NODE_OPTIONS=--require ...) inside the agent container, whose only way to the
// internet is the filtering proxy. Makes every Node HTTP client path proxy-aware: global fetch/undici,
// https/http module users (node-fetch, openai SDK, MCP clients).
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxy) {
  try {
    const { createRequire } = require('node:module');
    const dsh = process.env.DSH_MODULES || '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/';
    const req = createRequire(dsh);
    try { const u = req('undici'); u.setGlobalDispatcher(new u.EnvHttpProxyAgent({ httpProxy: proxy, httpsProxy: proxy, noProxy: process.env.NO_PROXY || 'localhost,127.0.0.1' })); } catch (e) { console.error('proxy-preload: undici', e.message); }
    try { const { HttpsProxyAgent } = req('https-proxy-agent'); require('node:https').globalAgent = new HttpsProxyAgent(proxy); } catch (e) { console.error('proxy-preload: https-proxy-agent', e.message); }
    try { const { HttpProxyAgent } = req('http-proxy-agent'); require('node:http').globalAgent = new HttpProxyAgent(proxy); } catch (e) { console.error('proxy-preload: http-proxy-agent', e.message); }
  } catch (e) { console.error('proxy-preload failed:', e.message); }
}
