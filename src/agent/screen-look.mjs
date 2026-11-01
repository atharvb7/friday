// "Look at the laptop screen": the node takes a downscaled whole-desktop screenshot, a vision model reads it.
// Shared by the computer agent (screen_look: answer + numbered controls with click coordinates), the laptop_screen
// tool (quick "what's on my screen?") and anything else that needs eyes on the desktop. Only TEXT comes back:
// the image goes to the vision model once and never sits in another model's context.
export const LOOK_WIDTH = 1280; // ~1-1.5k image tokens; small UI text stays readable at 1280 from a 1080p-1440p desktop

// Coordinates are asked for on a 0-1000 grid of the image: the vision models in use answer that way natively
// (Nemotron omni and Gemini both returned 0-1000 values even when asked for pixels), so it is the reliable convention.
const lookPrompt = (question, elements) => `This is a screenshot of a Linux (GNOME) desktop.${question ? `\nQuestion: ${String(question).slice(0, 600)}` : ''}
Reply with ONLY this JSON object, nothing else:
{"answer": "<direct, literal answer to the question, or 1-3 sentences on what is on screen>", "front": "<app/window in front>"${elements ? `, "elements": [{"label": "Save", "type": "button", "x": 512, "y": 304}]}
"elements": up to 25 visible clickable things most relevant to the question (buttons, fields, links, tabs, icons, list items). x,y = the CENTER of each, as integers on a 0-1000 grid of the image (0,0 = top-left, 1000,1000 = bottom-right). Put every location in "elements", not in "answer".` : '}'}
Read text exactly as shown. Never guess what is not visible.`;

// The first balanced {...} block of a reply: models wrap JSON in prose or ``` fences, or add a stray closing brace.
export function parseLooseJson(text) {
  const s = String(text ?? '');
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(s.slice(i, k + 1)); } catch { break; } }
    }
  }
  return null;
}

// -> { answer, front, screen: {width,height}, elements: [{n,label,type,x,y}] (screen coordinates) } or { error }
export async function lookAtScreen({ nodes, ai, question = '', elements = true, maxWidth = LOOK_WIDTH, signal, timeoutMs = 30_000 }) {
  let shot;
  try { shot = await nodes.dispatch({ action: 'screen_capture', args: { maxWidth }, timeoutMs }); }
  catch (e) { return { error: String(e.message ?? e).slice(0, 200) }; }
  const W = shot.screen?.width || shot.width; const H = shot.screen?.height || shot.height;
  let out;
  try {
    out = await ai.run('vision', { signal, maxTokens: elements ? 1800 : 700, temperature: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: lookPrompt(question, elements) },
      { type: 'image_url', image_url: { url: `data:${shot.mime ?? 'image/jpeg'};base64,${shot.base64}` } }] }] });
  } catch (e) { return { error: `vision_unavailable: ${String(e.message).slice(0, 160)}` }; }
  const j = parseLooseJson(out.content);
  if (!j) return { answer: String(out.content ?? '').trim().slice(0, 1200), screen: { width: W, height: H }, elements: [] };
  // 0-1000 grid -> desktop logical pixels (what the pointer actions take); drop anything off the grid.
  const els = (Array.isArray(j.elements) ? j.elements : []).slice(0, 30).map((e) => ({ label: String(e?.label ?? '').slice(0, 60), type: String(e?.type ?? '').slice(0, 12), gx: Number(e?.x), gy: Number(e?.y) }))
    .filter((e) => e.label && e.gx >= 0 && e.gy >= 0 && e.gx <= 1000 && e.gy <= 1000)
    .map((e, i) => ({ n: i + 1, label: e.label, type: e.type, x: Math.round((e.gx / 1000) * W), y: Math.round((e.gy / 1000) * H) }));
  return { answer: String(j.answer ?? '').slice(0, 1500), front: String(j.front ?? '').slice(0, 120), screen: { width: W, height: H }, elements: els, model: out.model };
}

// Compact text for an agent's context: "[3] button "Save" @812,440".
export const formatElements = (els) => els.map((e) => `[${e.n}] ${e.type ? `${e.type} ` : ''}"${e.label}" @${e.x},${e.y}`).join('\n');
