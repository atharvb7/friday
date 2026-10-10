// POST audio/wav -> text, text -> audio/wav, and a one-call "ask" for devices:
// wav in -> transcribe -> Friday answers -> wav out (headers carry the texts).
import { DEFAULT_VOICE } from '../voice-server.mjs';

export function voiceRoutes(router, ctx) {
  const { voiceServer, bus, settings } = ctx;
  const cfg = () => ({ ...DEFAULT_VOICE, ...settings.get('voice', {}) });
  // Biases Whisper toward the names/vocabulary it will hear (and Hinglish-style English).
  const sttPrompt = () => `Friday, ${settings.get('user_name', 'Atharv')}, hey Friday. Casual conversation, mixed English and Hindi words like yaar, na, accha, kya, haan, bro.`;
  const fail = (e) => (e.code === 'unavailable' ? [501, { error: e.message }] : e.code === 'busy' ? [503, { error: e.message }] : [e instanceof TypeError ? 400 : 502, { error: e.message }]);
  const wav = (res, buf, headers = {}) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers }); res.end(buf); };
  const enc = (t) => encodeURIComponent(String(t).slice(0, 400));

  router.get('/v1/voice/status', () => [200, { ...voiceServer.status(), settings: cfg() }]);
  router.post('/v1/voice/settings', async ({ body }) => {
    const b = await body();
    const next = { ...cfg(), ...(typeof b.voice === 'string' ? { voice: b.voice } : {}), ...(b.speed !== undefined ? { speed: Number(b.speed) } : {}) };
    if (!/^[a-z]{2}_[a-z]+(:\d{1,3})?(,[a-z]{2}_[a-z]+(:\d{1,3})?){0,3}$/.test(next.voice) || !(next.speed >= 0.7 && next.speed <= 1.3)) return [400, { error: 'invalid voice settings' }];
    settings.set('voice', next); return [200, { settings: next }];
  });

  router.post('/v1/voice/transcribe', async ({ rawBody }) => {
    try { bus.publish('voice.started', {}); return [200, { text: await voiceServer.transcribe(await rawBody({ max: 9 * 1024 * 1024 }), { prompt: sttPrompt() }) }]; } catch (e) { return fail(e); } finally { bus.publish('voice.ended', {}); }
  });

  router.post('/v1/voice/speak', async ({ body }) => {
    const b = await body();
    try { const audio = await voiceServer.speak(b.text, { voice: typeof b.voice === 'string' ? b.voice : cfg().voice, speed: b.speed ?? cfg().speed }); return { raw: (res) => wav(res, audio) }; } catch (e) { return fail(e); }
  });

  router.post('/v1/voice/ask', async ({ rawBody }) => {
    try {
      bus.publish('voice.started', {});
      const heard = await voiceServer.transcribe(await rawBody({ max: 9 * 1024 * 1024 }), { prompt: sttPrompt() });
      if (!heard) return [200, { heard: '', reply: '' }];
      const out = await ctx.quickTurn(heard, null, 'voice');
      bus.publish('voice.speaking', {});
      const audio = await voiceServer.speak(out.reply, cfg());
      return { raw: (res) => wav(res, audio, { 'X-Friday-Heard': enc(heard), 'X-Friday-Reply': enc(out.reply) }) };
    } catch (e) { return fail(e); } finally { bus.publish('voice.ended', {}); }
  });
}
