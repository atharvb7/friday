// POST audio/wav -> text, text -> audio/wav, and a one-call "ask" for devices:
// wav in -> transcribe -> Friday answers -> wav out (headers carry the texts).
export function voiceRoutes(router, ctx) {
  const { voiceServer, bus } = ctx;
  const fail = (e) => (e.code === 'unavailable' ? [501, { error: e.message }] : e.code === 'busy' ? [503, { error: e.message }] : [e instanceof TypeError ? 400 : 502, { error: e.message }]);
  const wav = (res, buf, headers = {}) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers }); res.end(buf); };
  const enc = (t) => encodeURIComponent(String(t).slice(0, 400));

  router.get('/v1/voice/status', () => [200, voiceServer.status()]);

  router.post('/v1/voice/transcribe', async ({ rawBody }) => {
    try { bus.publish('voice.started', {}); return [200, { text: await voiceServer.transcribe(await rawBody()) }]; } catch (e) { return fail(e); } finally { bus.publish('voice.ended', {}); }
  });

  router.post('/v1/voice/speak', async ({ body }) => {
    const b = await body();
    try { const audio = await voiceServer.speak(b.text); return { raw: (res) => wav(res, audio) }; } catch (e) { return fail(e); }
  });

  router.post('/v1/voice/ask', async ({ rawBody }) => {
    try {
      bus.publish('voice.started', {});
      const heard = await voiceServer.transcribe(await rawBody());
      if (!heard) return [200, { heard: '', reply: '' }];
      const out = await ctx.quickTurn(heard);
      bus.publish('voice.speaking', {});
      const audio = await voiceServer.speak(out.reply);
      return { raw: (res) => wav(res, audio, { 'X-Friday-Heard': enc(heard), 'X-Friday-Reply': enc(out.reply) }) };
    } catch (e) { return fail(e); } finally { bus.publish('voice.ended', {}); }
  });
}
