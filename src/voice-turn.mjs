// A spoken turn from a device that already has the transcript (the laptop push-to-talk key), optionally with a
// screenshot. The image never reaches the main brain: one call to the 'vision' model chain turns it into a short,
// question-focused note (~1k prompt tokens per image), and the brain answers from that note as plain text. Devices
// only attach a screenshot when the request is about the screen, so ordinary questions cost nothing extra.

const IMAGE_TYPES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
export const MAX_IMAGE_BYTES = 2_500_000;
export const MAX_TEXT = 2000;

// { mime, data: base64 } -> { mime, base64 } or throws TypeError (checked by size and magic bytes, not by trust).
export function parseImage(img) {
  if (img === undefined || img === null) return null;
  if (typeof img !== 'object' || !IMAGE_TYPES[img.mime] || typeof img.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) throw new TypeError('image must be { mime: image/jpeg|png|webp, data: base64 }');
  const buf = Buffer.from(img.data, 'base64');
  if (buf.length < 16 || buf.length > MAX_IMAGE_BYTES) throw new TypeError(`image must be under ${Math.round(MAX_IMAGE_BYTES / 1e6 * 10) / 10} MB`);
  if (!IMAGE_TYPES[img.mime].every((b, i) => buf[i] === b)) throw new TypeError('image bytes do not match its type');
  return { mime: img.mime, base64: img.data };
}

export const screenQuestionPrompt = (question) => `This is a screenshot of my laptop screen, taken the moment I asked: "${String(question).slice(0, 500)}"
Write the facts needed to answer me, nothing else:
- which app/window/page it is;
- quote exactly the text that matters (error messages, headings, numbers, names, code lines);
- if I asked you to read something, transcribe that text faithfully (up to 250 words).
Do not give advice or explanations and never guess text you cannot read. Plain text, no markdown, at most 180 words unless transcribing.`;

// Uses the router's 'vision' chain (Gemini Flash-Lite -> Nemotron Omni -> Super-VL by default). Thinking off: this is
// reading, not reasoning, and it halves the latency.
export async function describeScreen(ai, question, image, { signal = null } = {}) {
  const out = await ai.run('vision', {
    signal, thinking: false, temperature: 0, maxTokens: 700,
    messages: [{ role: 'user', content: [{ type: 'text', text: screenQuestionPrompt(question) }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }] }],
  });
  const notes = String(out.content ?? '').replace(/\*\*|__|`{1,3}/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2500);
  if (!notes) throw new Error('vision_empty');
  return { notes, model: `${out.provider}:${out.model ?? ''}`.replace(/:$/, '') };
}

// What the brain sees. Worded without the bare word "screen" so the note itself does not pull in the computer-control
// tools (toolsets.mjs matches /\bscreen\b/); she answers from the note instead of trying to look again.
// The note travels separately from his words (quickTurn's `note`): text on his screen ("search", "deploy", ...) must
// not trip the brain's look-it-up guard or load tool groups — that made one screen question run 3 web searches.
export const screenNote = (notes) => `(Screenshot of my laptop, sent with this question and read by your vision model: ${notes}\nAnswer from this; you do not need to look again.)`;
export const SCREEN_FAILURE_NOTE = '(A screenshot of my laptop was sent with this question but your vision model could not read it right now. Say so briefly.)';
export const withScreenNote = (heard, notes) => `${heard}\n\n${screenNote(notes)}`;
export const withScreenFailure = (heard) => `${heard}\n\n${SCREEN_FAILURE_NOTE}`;

// One device turn: optional screenshot -> note -> brain on the 'voice' channel. Returns the raw reply (with voice tags,
// for TTS) and the display text (tags stripped) plus the conversation to continue with.
export async function voiceTurn(body, { ai, quickTurn, chat, stripTags, signal = null }) {
  const heard = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  if (!heard || heard.length > MAX_TEXT) throw new TypeError(`text required (max ${MAX_TEXT} chars)`);
  const image = parseImage(body.image);
  const convo = typeof body.conversationId === 'string' && chat?.owns(body.conversationId, null) ? body.conversationId : null;
  let note = ''; let screen = null;
  if (image) {
    try { const d = await describeScreen(ai, heard, image, { signal }); note = screenNote(d.notes); screen = { used: true, model: d.model }; }
    catch (e) { note = SCREEN_FAILURE_NOTE; screen = { used: false, error: String(e.message ?? e).slice(0, 160) }; }
  }
  const out = await quickTurn(heard, convo, 'voice', note);
  const reply = String(out.reply ?? '');
  return { heard, reply, text: stripTags(reply), conversationId: out.conversation?.id ?? convo, screen };
}
