// Conversational brain: persona + retrieved context + tool-calling loop.
// Heavy/long work is handed to the background agent via task_create.
import { buildSystemPrompt, normalizePersonality } from '../personality.mjs';

const MAX_STEPS = 6;
const MAX_TOOL_CALLS = 12;
const RESULT_CHARS = 4000;

export class Brain {
  constructor({ ai, fridayTools, settings, contextBuilder, chat, bus, audit = null }) {
    Object.assign(this, { ai, fridayTools, settings, contextBuilder, chat, bus, audit });
  }

  personality() { return normalizePersonality(this.settings.get('personality', {})); }

  async respond({ conversationId, text, onDelta = null, onThinking = null, onTool = null, signal = null }) {
    const personality = this.personality();
    const ctxInfo = await this.contextBuilder.build({ text });
    const system = `${buildSystemPrompt({ personality, userName: this.settings.get('user_name', null), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}${ctxInfo.text ? `\n\n${ctxInfo.text}` : ''}`;
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
    return { reply: last.content.trim(), model: last.model, provider: last.provider, toolsUsed, usage: last.usage, usedVector: ctxInfo.usedVector, memoryIds: ctxInfo.memoryIds };
  }

  async #runTool(call, conversationId) {
    const tool = this.fridayTools.get(call.name);
    this.bus?.publish('tool.called', { name: call.name, conversationId });
    if (!tool) return { error: 'unknown_tool' };
    if (call.args === null) return { error: 'invalid_json_arguments' };
    if (tool.risk !== 'safe') return { error: 'requires_approval', note: 'This action must be staged for the user to approve; it was not performed.' };
    try {
      const out = await tool.run(call.args, { conversationId });
      try { this.audit?.append(conversationId, 'tool.run', { tool: call.name }); } catch {}
      return out ?? { ok: true };
    } catch (error) {
      return { error: error instanceof TypeError ? error.message : 'tool_failed' };
    }
  }
}
