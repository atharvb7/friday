// Pictures Friday makes: text-to-image on NVIDIA's hosted FLUX models (same key as her brain). Every image becomes a
// chat file (attached to her reply, shown inline by the web app) plus a row with its prompt, seed and model; the chat
// history shows her that prompt again, so "same one but at night" starts from what she actually wrote. Even with the
// same seed FLUX reframes the scene when the prompt changes, so a tweak is a new render, not an edit.
// Hosted editing of the user's own photos is not available on this account (the Kontext endpoint only takes NVIDIA's
// demo images), so this is generation only.
import { randomInt } from 'node:crypto';

const BASE = 'https://ai.api.nvidia.com/v1/genai';
export const MAX_PROMPT = 800; // the hosted FLUX endpoints refuse longer prompts
// Sizes both models accept (FLUX.1-dev: 768–1344 in steps of 64).
export const ASPECTS = Object.freeze({ '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344], '4:3': [1152, 896], '3:4': [896, 1152], '3:2': [1216, 832], '2:3': [832, 1216] });
export const QUALITIES = Object.freeze({
  fast: { model: 'black-forest-labs/flux.2-klein-4b', timeoutMs: 45_000, body: ({ prompt, width, height, seed }) => ({ prompt, width, height, seed, steps: 4 }) },
  best: { model: 'black-forest-labs/flux.1-dev', timeoutMs: 120_000, body: ({ prompt, width, height, seed }) => ({ prompt, mode: 'base', cfg_scale: 3.5, width, height, seed, steps: 30 }) },
});
const OTHER = { fast: 'best', best: 'fast' };

const slug = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 48) || 'image';
const extFor = (buf) => (buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0x52 && buf[8] === 0x57 ? 'webp' : 'jpg');

export class Images {
  constructor({ store, files, apiKey = null, baseUrl = BASE, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { files, apiKey, baseUrl: String(baseUrl).replace(/\/+$/, ''), fetchImpl });
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS images (
      file_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, quality TEXT NOT NULL, model TEXT NOT NULL, seed INTEGER NOT NULL,
      aspect TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, based_on TEXT, created_at TEXT NOT NULL)`);
  }

  get configured() { return Boolean(this.apiKey); }
  info(fileId) { return this.db.prepare('SELECT * FROM images WHERE file_id=?').get(fileId) ?? null; }

  // One hosted call. Retries on the other model only when the service itself failed (not for a refused prompt).
  async #render({ quality, prompt, width, height, seed, signal }) {
    const q = QUALITIES[quality];
    let r;
    try {
      r = await this.fetchImpl(`${this.baseUrl}/${q.model}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(q.body({ prompt, width, height, seed })),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(q.timeoutMs)]) : AbortSignal.timeout(q.timeoutMs),
      });
    } catch (e) { if (signal?.aborted) throw e; return { retry: true, error: `image service unreachable (${String(e.name === 'TimeoutError' ? 'timed out' : e.message).slice(0, 80)})` }; }
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const detail = Array.isArray(j?.detail) ? j.detail.map((d) => d.msg).join('; ') : j?.detail ?? j?.title ?? '';
      return { retry: r.status === 404 || r.status === 429 || r.status >= 500, error: `image service ${r.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}` };
    }
    const a = j?.artifacts?.[0];
    if (a?.finishReason && a.finishReason !== 'SUCCESS') return { refused: true, error: a.finishReason === 'CONTENT_FILTERED' ? 'the image service\'s safety filter blocked this picture' : `image service stopped: ${a.finishReason}` };
    if (!a?.base64) return { retry: true, error: 'image service returned no image' };
    return { data: Buffer.from(a.base64, 'base64'), seed: Number.isInteger(a.seed) ? a.seed : seed, model: q.model };
  }

  async create({ prompt, aspect = null, count = 1, quality = null, seed = null, based_on = null, name = null, conversationId = null, signal = null }) {
    if (!this.configured) return { error: 'image_generation_not_configured', note: 'Needs FRIDAY_NVIDIA_API_KEY on the server.' };
    const text = String(prompt ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return { error: 'prompt required' };
    if (text.length > MAX_PROMPT) return { error: `prompt is ${text.length} characters; the image service takes at most ${MAX_PROMPT}. Tighten it and call again.` };
    let base = null;
    if (based_on) {
      const f = this.files.resolve(based_on);
      base = f ? this.info(f.id) : null;
      if (!base) return { error: 'based_on must be the file id of an image you made with image_create (photos he uploaded cannot be edited yet)' };
    }
    const asp = ASPECTS[aspect] ? aspect : base?.aspect ?? '1:1';
    const [width, height] = ASPECTS[asp];
    const qual = QUALITIES[quality] ? quality : base?.quality ?? 'fast';
    const n = Math.max(1, Math.min(4, Number.parseInt(count, 10) || 1));
    // A tweak reuses the earlier seed (closest FLUX gets to the same look); extra variations get fresh seeds.
    const first = Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32 ? seed : base ? base.seed : randomInt(1, 2 ** 31);
    const seeds = Array.from({ length: n }, (_, i) => (i === 0 ? first : randomInt(1, 2 ** 31)));
    const stem = slug(name || text);
    const results = await Promise.all(seeds.map(async (s, i) => {
      let out = await this.#render({ quality: qual, prompt: text, width, height, seed: s, signal });
      if (out.retry) { const alt = await this.#render({ quality: OTHER[qual], prompt: text, width, height, seed: s, signal }); if (alt.data) out = { ...alt, fellBack: OTHER[qual] }; }
      if (!out.data) return { error: out.error };
      const usedQuality = out.fellBack ?? qual;
      const f = this.files.save({ name: `${stem}${n > 1 ? `-${i + 1}` : ''}.${extFor(out.data)}`, data: out.data, source: 'friday', conversationId });
      this.db.prepare('INSERT INTO images (file_id,prompt,quality,model,seed,aspect,width,height,based_on,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(f.id, text, usedQuality, out.model, out.seed, asp, width, height, base?.file_id ?? null, new Date().toISOString());
      return { file: f.id, name: f.name, seed: out.seed, model: out.model.split('/').pop(), ...(out.fellBack ? { note: `${qual} model was down; used ${usedQuality}` } : {}) };
    }));
    const ok = results.filter((r) => r.file);
    if (!ok.length) return { error: results[0]?.error ?? 'image generation failed' };
    return {
      images: ok.map((r) => ({ ...r, file: r.file.slice(0, 8) })), size: `${width}x${height}`, aspect: asp, quality: qual,
      ...(ok.length < results.length ? { failed: results.filter((r) => r.error).map((r) => r.error) } : {}),
      note: 'He sees the images in the chat. You have not seen them, so do not describe details beyond your prompt or promise exactly what is in them. To change one, call image_create again with based_on = its file id and its prompt with only his change; it is a fresh render, so the layout can shift.',
      _attach: ok.map((r) => r.file),
    };
  }
}
