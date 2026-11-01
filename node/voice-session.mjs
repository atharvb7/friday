// The push-to-talk state machine, with every side effect injected (so tests drive it with stubs):
//   idle --press--> listening --silence/max/press--> thinking --> speaking --> idle
//   press while thinking = cancel; press while speaking = stop talking and listen again.
import { explainError, needsScreen, notifyText, speechChunks, stripTags } from './voice-lib.mjs';

export class VoiceSession {
  // deps: { cue(kind), notify({title, body, transient, replace}) -> id, closeNotification(id),
  //         record({ signal }) -> { stop(), done: Promise<{ wav, reason, heard, micSilent, error }> },
  //         transcribe(wav, { signal }) -> text, screenshot() -> { mime, data } | null,
  //         turn({ text, image, conversationId }, { signal }) -> { reply, text, conversationId, screen },
  //         synth(chunk, { signal }) -> wav Buffer (local voice, falling back to the server inside),
  //         play(wav, { signal }) -> Promise, speakerMuted() -> bool (optional), conversation: { get(), set(id) }, log(...) }
  constructor(deps, cfg = {}) {
    this.d = deps; this.cfg = { screen: 'auto', tts: 'auto', debounceMs: 350, ...cfg };
    this.state = 'idle'; this.lastPress = 0; this.rec = null; this.ctrl = null; this.speakCtrl = null; this.round = null; this.notifId = null;
    this.now = deps.now ?? (() => Date.now());
  }

  // One key press (first launch or SIGUSR1 from a second launch).
  press({ screen = null } = {}) {
    const t = this.now();
    if (t - this.lastPress < this.cfg.debounceMs) return 'debounced';
    this.lastPress = t;
    switch (this.state) {
      case 'idle': this.round = this.#run({ screen }); return 'listen';
      case 'listening': this.rec?.stop(); return 'stop';
      case 'thinking': this.ctrl?.abort(); return 'cancel';
      case 'speaking': this.speakCtrl?.abort(); this.ctrl?.abort(); this.next = { screen }; return 'interrupt';
      default: return 'ignored';
    }
  }

  async #notify(title, body, { transient = true } = {}) {
    try { this.notifId = await this.d.notify({ title, body: notifyText(body), transient, replace: this.notifId }); } catch { /* notifications are a nicety */ }
  }

  async #fail(e) {
    const msg = explainError(e);
    this.d.log?.('error', e?.message ?? e);
    if (!msg) return; // cancelled by the user
    await this.d.cue('error'); await this.#notify('Friday', msg, { transient: false });
  }

  async #run({ screen }) {
    this.state = 'listening'; this.next = null;
    const ctrl = new AbortController(); this.ctrl = ctrl;
    try {
      await this.d.cue('start');
      await this.#notify('Friday is listening…', 'Speak now. Press the key again when you are done.');
      this.rec = this.d.record({ signal: ctrl.signal });
      const r = await this.rec.done; this.rec = null;
      await this.d.cue('stop');
      if (r.error) throw new Error(`mic: ${r.error}`);
      if (r.micSilent) throw new Error('mic: the microphone is sending pure silence (muted?)');
      if (!r.heard) { await this.#notify('Friday', 'I didn’t catch anything. Press the key and talk after the beep.'); return; }

      this.state = 'thinking';
      await this.#notify('Friday', 'Thinking…');
      const text = (await this.d.transcribe(r.wav, { signal: ctrl.signal }))?.trim();
      if (!text) { await this.#notify('Friday', 'I couldn’t make out any words. Try again?'); return; }
      const mode = screen ?? this.cfg.screen;
      let image = null;
      if (mode === 'always' || (mode === 'auto' && needsScreen(text))) {
        if (this.notifId) await this.d.closeNotification?.(this.notifId); // keep our own banner out of the screenshot
        this.notifId = null;
        try { image = await this.d.screenshot(); } catch (e) { this.d.log?.('screenshot failed', e.message); }
      }
      await this.#notify(`You: ${text}`, image ? 'Looking at your screen…' : 'Thinking…');
      const out = await this.d.turn({ text, image, conversationId: this.d.conversation.get() }, { signal: ctrl.signal });
      if (out.conversationId) this.d.conversation.set(out.conversationId);
      const shown = out.text || stripTags(out.reply);
      await this.#notify(`You: ${text}`, shown || '…', { transient: false });
      if (this.cfg.tts === 'off' || !out.reply?.trim()) return;
      if (await this.d.speakerMuted?.()) { await this.#notify(`You: ${text}`, `${shown}\n(Your speaker is muted, so I only wrote it.)`, { transient: false }); return; }

      this.state = 'speaking';
      await this.#speak(out.reply);
    } catch (e) {
      if (!ctrl.signal.aborted) await this.#fail(e);
      else if (!this.next) await this.d.cue('cancel'); // an interrupt goes straight to the next start beep
    } finally {
      this.rec?.stop(); this.rec = null; this.state = 'idle'; this.ctrl = null; this.speakCtrl = null;
      const again = this.next; this.next = null;
      if (again) this.round = this.#run(again); // pressed while she was talking: listen again
    }
  }

  // Sentence by sentence: the next chunk is synthesised while the current one plays.
  async #speak(reply) {
    const sc = new AbortController(); this.speakCtrl = sc;
    const chunks = speechChunks(reply);
    let pending = chunks.length ? this.d.synth(chunks[0], { signal: sc.signal }) : null;
    for (let i = 0; i < chunks.length && !sc.signal.aborted; i++) {
      const wav = await pending;
      pending = i + 1 < chunks.length ? this.d.synth(chunks[i + 1], { signal: sc.signal }) : null;
      pending?.catch(() => {}); // surfaced when awaited
      if (sc.signal.aborted) break;
      if (wav) await this.d.play(wav, { signal: sc.signal });
    }
  }
}
