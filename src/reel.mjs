// Reel pipeline glue: when a reel_create job (Gemini clips on the laptop) finishes, Friday continues on her own —
// a headless Claude Code + SynthCut edit on the laptop (node action reel_edit), then delivery of final.mp4 to the
// owner's own WhatsApp (a reel_send laptop task). The reel_create approval covers the whole chain.
export class ReelPipeline {
  constructor({ store, nodes, chat, notifications, bus, createSendTask }) { Object.assign(this, { store, nodes, chat, notifications, bus, createSendTask }); this.busy = new Set(); }
  #tell(t, text) { if (t.conversation_id && this.chat.getConversation(t.conversation_id)) this.chat.addMessage(t.conversation_id, 'assistant', text); }

  async onTaskCompleted(taskId) {
    const t = this.store.getTask(taskId); if (!t) return;
    let meta = {}; try { meta = JSON.parse(t.meta ?? '{}'); } catch { return; }
    const r = meta.reel; if (!r?.autoEdit || this.busy.has(taskId)) return;
    this.busy.add(taskId);
    try { await this.edit({ conversationId: t.conversation_id, folder: r.folder, brief: r.brief, aspect: r.aspect, seconds: r.seconds, autoSend: r.autoSend !== false, title: r.slug }); }
    finally { this.busy.delete(taskId); }
  }

  async edit({ conversationId = null, folder, brief = '', aspect = '9:16', seconds = null, autoSend = true, title = 'reel' }) {
    const t = { conversation_id: conversationId };
    if (!this.nodes.online) { this.#tell(t, `🎬 The clips for “${title}” are ready, but your laptop is offline, so I can't edit yet. Say “edit the reel” when it's back.`); return { error: 'laptop_offline' }; }
    this.#tell(t, `🎬 Clips for “${title}” are in. Opening Claude Code + SynthCut on your laptop to edit the reel — this takes a few minutes.`);
    let out;
    try { out = await this.nodes.dispatch({ action: 'reel_edit', args: { folder, brief, aspect, seconds }, timeoutMs: 45 * 60_000 }); }
    catch (e) { this.#tell(t, `⚠️ The reel edit didn't run: ${String(e.message).slice(0, 200)}`); return { error: e.message }; }
    if (!out?.done) { this.#tell(t, `⚠️ Claude Code couldn't finish the reel: ${String(out?.error ?? 'unknown').slice(0, 400)}`); return { error: out?.error ?? 'edit_failed' }; }
    this.#tell(t, `✅ Reel edited (${Math.round(out.size / 1024 / 1024 * 10) / 10} MB) → ${out.path}\n\n${String(out.summary ?? '').slice(0, 1200)}`);
    this.bus?.publish('reel.edited', { path: out.path });
    if (autoSend) { const task = this.createSendTask({ path: out.path, caption: `🎬 ${title}`, conversationId }); this.#tell(t, `📲 Sending it to your WhatsApp now (task ${task.id.slice(0, 8)}).`); }
    return { edited: true, path: out.path, summary: out.summary };
  }
}
