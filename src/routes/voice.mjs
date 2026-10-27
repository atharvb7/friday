// POST audio/wav -> text, text -> audio/wav, and a one-call "ask" for devices:
// wav in -> transcribe -> Friday answers -> wav out (headers carry the texts).
import { DEFAULT_VOICE, ENGINES } from '../voice-server.mjs';
import { voiceTurn } from '../voice-turn.mjs';

// Performance tags the expressive voice acts out; never shown or sent as text.
const VOICE_TAGS = /\s*\[(?:laugh|chuckle|sigh|gasp|groan|sniff|cough|clear throat|shush|whispering|happy|sarcastic|surprised|dramatic|angry|crying|fear|narration|advertisement)\]\s*/gi;
export const stripVoiceTags = (t) => String(t ?? '').replace(VOICE_TAGS, ' ').replace(/\s{2,}/g, ' ').trim();

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
    const next = { ...cfg(), ...(typeof b.voice === 'string' ? { voice: b.voice } : {}), ...(b.speed !== undefined ? { speed: Number(b.speed) } : {}), ...(b.engine !== undefined ? { engine: b.engine } : {}), ...(b.pitch !== undefined ? { pitch: Number(b.pitch) } : {}) };
    if (!/^[a-z]{2}_[a-z]+(:\d{1,3})?(,[a-z]{2}_[a-z]+(:\d{1,3})?){0,3}$/.test(next.voice) || !(next.speed >= 0.7 && next.speed <= 1.3) || !ENGINES.includes(next.engine) || !(next.pitch >= 0.8 && next.pitch <= 1.4)) return [400, { error: 'invalid voice settings' }];
    settings.set('voice', next); return [200, { settings: next }];
  });

  router.post('/v1/voice/transcribe', async ({ rawBody }) => {
    try { bus.publish('voice.started', {}); return [200, { text: await voiceServer.transcribe(await rawBody({ max: 9 * 1024 * 1024 }), { prompt: sttPrompt() }) }]; } catch (e) { return fail(e); } finally { bus.publish('voice.ended', {}); }
  });

  router.post('/v1/voice/speak', async ({ body }) => {
    const b = await body();
    try { const audio = await voiceServer.speak(b.text, { ...cfg(), ...(typeof b.voice === 'string' ? { voice: b.voice } : {}), ...(b.speed !== undefined ? { speed: b.speed } : {}), ...(ENGINES.includes(b.engine) ? { engine: b.engine } : {}), ...(b.pitch !== undefined ? { pitch: b.pitch } : {}) }); return { raw: (res) => wav(res, audio) }; } catch (e) { return fail(e); }
  });

  // The speaker was switched on: load her voice now so the first sentence is not slow.
  router.post('/v1/voice/warm', async () => {
    try { return [200, await voiceServer.warm(cfg())]; } catch (e) { return fail(e); }
  });

  // Text already transcribed on the device (laptop push-to-talk), optionally with a screenshot when the question is about
  // the screen. JSON in: { text, image?: { mime, data(base64) }, conversationId? } -> JSON out: { heard, reply (with
  // voice tags, for TTS), text (display), conversationId, screen }. The device speaks the reply itself or calls /speak.
  router.post('/v1/voice/turn', async ({ body }) => {
    let b; try { b = await body({ max: 4 * 1024 * 1024 }); } catch (e) { return e.message === 'body_too_large' ? [413, { error: 'body too large (screenshot over 2.5 MB?)' }] : [400, { error: 'invalid JSON' }]; }
    try {
      bus.publish('voice.started', {});
      return [200, await voiceTurn(b, { ai: ctx.ai, quickTurn: ctx.quickTurn, chat: ctx.chat, stripTags: stripVoiceTags })];
    } catch (e) { return e instanceof TypeError ? [400, { error: e.message }] : [502, { error: String(e.message ?? e).slice(0, 200) }]; } finally { bus.publish('voice.ended', {}); }
  });

  router.post('/v1/voice/ask', async ({ rawBody }) => {
    try {
      bus.publish('voice.started', {});
      const heard = await voiceServer.transcribe(await rawBody({ max: 9 * 1024 * 1024 }), { prompt: sttPrompt() });
      if (!heard) return [200, { heard: '', reply: '' }];
      const out = await ctx.quickTurn(heard, null, 'voice');
      bus.publish('voice.speaking', {});
      const audio = await voiceServer.speak(out.reply, cfg());
      return { raw: (res) => wav(res, audio, { 'X-Friday-Heard': enc(heard), 'X-Friday-Reply': enc(stripVoiceTags(out.reply)) }) };
    } catch (e) { return fail(e); } finally { bus.publish('voice.ended', {}); }
  });
}
