// Conversational brain: persona + retrieved context + tool-calling loop.
// Heavy/long work is handed to the background agent via task_create.
import { buildSystemPrompt, buildGuestPrompt, normalizePersonality } from '../personality.mjs';
import { pickRegister } from '../mood.mjs';

const MAX_STEPS = 6;
const MAX_TOOL_CALLS = 12;
const RESULT_CHARS = 4000;

// Text chat has no stage directions: drop *actions* like "*gasps*" (keeps **bold**).
const ACTION_WORD = /^(gasps?|giggles?|sighs?|swoons?|smirks?|winks?|grins?|laughs?|blushes?|pouts?|hugs?|waves?|nods?|shrugs?|clutch\w*|bounc\w*|pok\w*|rolls?|squeals?|cackles?|snorts?|yawns?|whispers?|screams?|faints?|facepalms?|dramatic\w*|flops?|spins?|twirls?|slumps?|stares?|glares?|leans?|sips?|munches|crunches|steals?|waggles?|taps?|tilts?|peeks?|hides?|jumps?|dances?|cries|sobs?|beams?|melts?|nuzzles?|cuddles?|snuggles?|kisses|smooches|sticks?|puffs?|crosses|raises?|covers?|buries|collapses?|fans?|pretends?|ahem)\b/i;
// Text chat has no stage directions: drop *action narration* (keeps **bold** and real emphasis like *really*).
export function stripStageDirections(text) {
  return String(text).replace(/(^|[\s(])\*(?!\*)([^*\n]{2,90}?)\*(?=[\s).,!?…:;]|$)/g, (m, pre, inner) => {
    const n = inner.trim().split(/\s+/).length;
    return (ACTION_WORD.test(inner.trim()) || n >= 4) ? pre : m;
  }).replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
}

export class Brain {
  constructor({ ai, fridayTools, settings, contextBuilder, chat, bus, audit = null, skills = null, policy = null, approvals = null, mood = null, habits = null }) {
    Object.assign(this, { ai, fridayTools, settings, contextBuilder, chat, bus, audit, skills, policy, approvals, mood, habits });
  }

  personality() { return normalizePersonality(this.settings.get('personality', {})); }

  async respond({ conversationId, text, onDelta = null, onThinking = null, onTool = null, signal = null, speaker = 'owner', channel = 'chat' }) {
    if (speaker === 'guest') return this.#respondGuest({ conversationId, onDelta, signal });
    const personality = this.personality();
    this.mood?.touch?.();
    const moodNow = this.mood?.current({ moodiness: personality.moodiness }) ?? null;
    const ctxInfo = await this.contextBuilder.build({ text });
    const system = `${buildSystemPrompt({ personality, mood: moodNow, channel, habitsNote: this.habits?.cooldownNote() ?? '', register: pickRegister({ personality, mood: moodNow?.mood }), autoMemory: this.settings.get('auto_memory', true) !== false, userName: this.settings.get('user_name', null), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}${this.skills?.index() ? `\n\nSkills you can load with skill_load when a request matches (do not load unless needed):\n${this.skills.index()}` : ''}${ctxInfo.text ? `\n\n${ctxInfo.text}` : ''}`;
    const messages = [{ role: 'system', content: system }, ...this.chat.historyForProvider(conversationId, 20)];
    const schemas = this.fridayTools.schemas();
    const toolsUsed = [];
    let calls = 0;
    let last = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      last = await this.ai.execute(messages, { tools: schemas, stream: Boolean(onDelta), onDelta, onThinking, signal, maxTokens: 4096 });
      if (!last.toolCalls.length) break;
      messages.push({ role: 'assistant', content: last.content || null, tool_calls: last.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argumentsText || '{}' } })) });
      for (const call of last.toolCalls) {
        calls += 1;
        const result = calls > MAX_TOOL_CALLS ? { error: 'tool_call_limit_reached' } : await this.#runTool(call, conversationId);
        toolsUsed.push({ name: call.name, ok: !result.error });
        onTool?.({ name: call.name, ok: !result.error });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, RESULT_CHARS) });
      }
    }
    if (last.toolCalls.length && !last.content.trim()) {
      // Step budget exhausted mid-tool-use: force a plain-language wrap-up.
      last = await this.ai.chat([...messages, { role: 'user', content: 'Wrap up now in plain language using only what the tools returned.' }], { signal, onDelta, stream: Boolean(onDelta) });
    }
    const reply = channel === 'voice' ? last.content.trim() : stripStageDirections(last.content);
    this.habits?.record(reply);
    return { reply, model: last.model, provider: last.provider, toolsUsed, usage: last.usage, usedVector: ctxInfo.usedVector, memoryIds: ctxInfo.memoryIds };
  }

  // Guests get persona only: no memory, no context, no tools, and a separate conversation.
  async #respondGuest({ conversationId, onDelta, signal }) {
    const moodNow = this.mood?.current({ moodiness: this.personality().moodiness }) ?? null;
    const messages = [{ role: 'system', content: buildGuestPrompt({ ownerName: this.settings.get('user_name', null), mood: moodNow }) }, ...this.chat.historyForProvider(conversationId, 12)];
    const out = await this.ai.chat(messages, { signal, stream: Boolean(onDelta), onDelta, maxTokens: 1024, temperature: 0.8 });
    return { reply: out.content.trim(), model: out.model, provider: out.provider, toolsUsed: [], usage: out.usage, usedVector: false, memoryIds: [] };
  }

  async #runTool(call, conversationId) {
    const tool = this.fridayTools.get(call.name);
    this.bus?.publish('tool.called', { name: call.name, conversationId });
    if (!tool) return { error: 'unknown_tool' };
    if (call.args === null) return { error: 'invalid_json_arguments' };
    if (tool.risk !== 'safe') {
      // Gated tools: the policy (never the model, never the personality) decides.
      const decision = this.policy ? this.policy.decide({ category: tool.category, risk: tool.riskClass ?? 'consequential', forbidden: tool.forbidden }) : 'ask';
      if (decision === 'deny') return { error: 'forbidden_action' };
      if (decision === 'ask') {
        if (!this.approvals) return { error: 'requires_approval', note: 'This action needs approval and no approval flow is available; it was NOT performed.' };
        const a = this.approvals.request({ category: tool.category, risk: tool.riskClass ?? 'consequential', tool: tool.name, summary: tool.summarize ? tool.summarize(call.args) : `${tool.name}`, payload: call.args, conversationId });
        return { requires_approval: true, approval_id: a.id.slice(0, 8), note: 'Staged and waiting for the user to approve in their inbox. It was NOT performed yet. Tell the user.' };
      }
    }
    try {
      const out = await tool.run(call.args, { conversationId });
      try { this.audit?.append(conversationId, 'tool.run', { tool: call.name }); } catch {}
      return out ?? { ok: true };
    } catch (error) {
      return { error: error instanceof TypeError ? error.message : 'tool_failed' };
    }
  }
}
