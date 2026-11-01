// Conversational brain: persona + retrieved context + tool-calling loop.
// Heavy/long work is handed to the background agent via task_create.
import { buildSystemPrompt, buildGuestPrompt, buildMemberPrompt, normalizePersonality, feminize } from '../personality.mjs';
// Approved members (other people) only get general-purpose tools — nothing that touches the owner's world.
export const MEMBER_TOOLS = new Set(['web_search', 'web_fetch', 'time_now', 'document_create', 'document_read', 'document_edit', 'files_list', 'file_share']);
import { pickRegister } from '../mood.mjs';
import { ToolRouter, GROUPS, SKILL_GROUPS, schemasFor } from './toolsets.mjs';

const MAX_STEPS = 10; // room for a few search -> read -> re-search rounds
const MAX_TOOL_CALLS = 16;
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

export const stripFileNotes = (text) => String(text ?? '').replace(/\[attached files:[^\n]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();

// Claim guard: a reply that says an action was queued/sent/created must be backed by a tool call THIS turn.
// Tools that only READ never back an "I queued/sent/created it" claim; any other tool (incl. gated ones) can.
const READ_ONLY_TOOLS = new Set(['memory_search', 'file_search', 'file_read', 'time_now', 'web_search', 'web_fetch', 'research_search', 'task_list', 'task_trace', 'laptop_status', 'laptop_screen', 'reminder_list', 'skill_load', 'briefing_now']);
const CLAIM_RE = /\b(i['’]?ve|i have|i just|i['’]?ll go ahead and|i went ahead and)\s+(queued|queue|sent|send|created|set|scheduled|started|opened|kicked off|added|submitted|requested|put in)\b|\b(queued (the|your|that|it|up)|task (is |has been )?queued|waiting (for|on) your approval|approval (request|prompt)\b|check your (inbox|notification)|sent .{0,40}for approval|(is|has been|have been) (queued|scheduled|created)|i['’]?ll remind you|reminder(['’]s| is)? (set|created|added|scheduled)|here(['’]s| is| are) (your|the|a|some) (new )?(images?|pictures?|pics?|drawings?|illustrations?)|(i['’]?ve|i have|i just) (drawn|drew|painted|generated|sketched|rendered)|\b(is|'s|are) (already |now )?(on|playing|open(ed)?)( for you| now)?(?=\s*([.!,]|$))|\balready (on|playing)\b)\b/i;
export function claimsActionWithoutTool(text, toolsUsed) {
  return CLAIM_RE.test(String(text ?? '')) && !toolsUsed.some((t) => !READ_ONLY_TOOLS.has(t.name));
}
// Describing a search/lookup that never ran ("*searches web*", "top results are...") is the same lie as claiming an action.
const LOOKUP_RE = /(\*\s*(searches|searching|googles|looks it up|checks)\b[^*]{0,40}\*|\b(top|search) results (are|show|still)|\blet['’]?s see what\b|\bthe search (isn['’]?t|is not|shows|returned)|\b(i|i['’]ve|i have|i just) (searched|googled|looked (it )?up|checked online)\b)/i;
const LOOKUP_TOOLS = new Set(['web_search', 'web_fetch', 'research_start', 'research_search']);
const ASK_SEARCH_RE = /\b(search|google|look (it |this )?up|find (out|info|details)|get (me )?(the )?details|check (online|the internet|the web)|latest (news|info))\b/i;
export function claimsLookupWithoutTool(reply, toolsUsed, userText = '') {
  if (toolsUsed.some((t) => LOOKUP_TOOLS.has(t.name))) return false;
  return LOOKUP_RE.test(String(reply ?? '')) || (!toolsUsed.length && ASK_SEARCH_RE.test(String(userText ?? ''))); // a request handled by another tool (e.g. a laptop task) is fine
}
const LOOKUP_NOTE = '[system check] The user asked you to look something up (or your message described searching), but you called NO search tool this turn — any "results" you wrote are made up. Call web_search now (several differently worded queries if needed, then web_fetch the best pages) and answer only from what the tools return.';
const TOOLS_NOTE = 'TOOLS: only the tool groups that fit this conversation are loaded. If you need a tool you do not see, call tools_load first (it lists every group); never tell him you cannot do something before checking it.';
const GUARD_NOTE = '[system check] Your last message claimed that something was queued, sent, created or scheduled, but you called NO tool this turn, so nothing actually happened. If the user wants that done, call the correct tool now (computer_task for anything on their laptop/browser, research_start, code_task, task_create, reminder_create, schedule_task, rule_create, image_create for pictures). Otherwise correct your message. Never claim an action without a tool result.';

export class Brain {
  constructor({ ai, fridayTools, settings, contextBuilder, chat, bus, audit = null, skills = null, policy = null, approvals = null, mood = null, habits = null, toolRouter = new ToolRouter() }) {
    Object.assign(this, { ai, fridayTools, settings, contextBuilder, chat, bus, audit, skills, policy, approvals, mood, habits, toolRouter });
  }

  personality() { return normalizePersonality(this.settings.get('personality', {})); }

  async respond({ conversationId, text, onDelta = null, onThinking = null, onTool = null, signal = null, speaker = 'owner', channel = 'chat', memberName = null, userId = null }) {
    if (speaker === 'guest') return this.#respondGuest({ conversationId, onDelta, signal });
    const member = speaker === 'member';
    const personality = this.personality();
    if (!member) this.mood?.touch?.();
    const moodNow = this.mood?.current({ moodiness: personality.moodiness }) ?? null;
    const ctxInfo = member ? { text: '', memoryIds: [], usedVector: false } : await this.contextBuilder.build({ text }); // members never see the owner's memories/tasks
    const history = this.chat.historyForProvider(conversationId, 20);
    const userTurns = history.filter((m) => m.role === 'user');
    const groups = member ? new Set() : this.toolRouter.select({ conversationId, text: `${text}\n${/\[attached files:[^\]]*\]/i.exec(userTurns.at(-1)?.content ?? '')?.[0] ?? ''}`, previousText: userTurns.length > 1 ? userTurns.at(-2).content : '' });
    const routed = !member && this.toolRouter.enabled;
    const skillsText = !this.skills?.index() ? '' : (!routed || [...groups].some((g) => SKILL_GROUPS.has(g)))
      ? `\n\nSkills you can load with skill_load when a request matches (do not load unless needed):\n${this.skills.index()}`
      : `\n\nSkills (playbooks) you can load with skill_load when a request matches: ${this.skills.names()}`;
    const system = member ? buildMemberPrompt({ ownerName: this.settings.get('user_name', null), memberName, channel, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) : `${buildSystemPrompt({ personality, mood: moodNow, channel, habitsNote: this.habits?.cooldownNote() ?? '', register: pickRegister({ personality, mood: moodNow?.mood }), autoMemory: this.settings.get('auto_memory', true) !== false, userName: this.settings.get('user_name', null), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}${routed ? `\n\n${TOOLS_NOTE}` : ''}${skillsText}${ctxInfo.text ? `\n\n${ctxInfo.text}` : ''}`;
    const messages = [{ role: 'system', content: system }, ...history];
    const allSchemas = this.fridayTools.schemas();
    let schemas = member ? allSchemas.filter((s) => MEMBER_TOOLS.has(s.function?.name ?? s.name)) : routed ? schemasFor(allSchemas, groups) : allSchemas.filter((s) => (s.function?.name ?? s.name) !== 'tools_load');
    const loadGroups = (names) => { for (const g of names) groups.add(g); schemas = schemasFor(allSchemas, groups); };
    const loadedByModel = new Set(); // groups the model asked for with tools_load: they stay loaded for the next turns
    const toolsUsed = [];
    const attachments = []; // files tools produced this turn (documents) — attached to the reply
    let calls = 0;
    const failures = new Map(); // "tool|error" -> count: a tool failing the same way again is not retried blindly
    const repeats = new Map(); // "tool|args" -> count: the same call a third time in one turn returns nothing new (task_list x8, 28 Oct)
    let guardTries = 0;
    let lookupTries = 0;
    let last = null;
    // Text she wrote alongside tool calls ("Ooh, drawing it now!") is streamed to him as it comes, so it is part of
    // the reply: keeping only the last step's text made it vanish when the reply (with the picture) was saved.
    const said = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      // After a tool already gave him something (her words, a picture), saying nothing more is a valid answer, and a
      // brain outage at this point must not throw away what was already shown.
      const shown = said.length > 0 || attachments.length > 0;
      try { last = await this.ai.execute(messages, { tools: schemas, stream: Boolean(onDelta), onDelta, onThinking, signal, maxTokens: 4096, allowEmpty: shown }); }
      catch (error) { if (!shown || signal?.aborted) throw error; last = { content: '', toolCalls: [], model: last?.model ?? null, provider: last?.provider ?? null }; break; }
      if (!last.toolCalls.length) {
        if (guardTries < 1 && claimsActionWithoutTool(last.content, toolsUsed)) { // she said she did it, but no tool ran: make her actually do it (or retract)
          guardTries += 1;
          if (routed) loadGroups(Object.keys(GROUPS)); // the fix may need any tool (computer_task, research_start, image_create...)
          messages.push({ role: 'assistant', content: last.content }, { role: 'user', content: GUARD_NOTE });
          this.bus?.publish('brain.claim_guard', { conversationId });
          continue;
        }
        if (lookupTries < 1 && claimsLookupWithoutTool(last.content, toolsUsed, text)) {
          lookupTries += 1;
          messages.push({ role: 'assistant', content: last.content }, { role: 'user', content: LOOKUP_NOTE });
          this.bus?.publish('brain.lookup_guard', { conversationId });
          continue;
        }
        break;
      }
      if (last.content?.trim()) said.push(last.content.trim());
      messages.push({ role: 'assistant', content: last.content || null, tool_calls: last.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argumentsText || '{}' }, ...(c.extra ? { extra_content: c.extra } : {}) })) });
      for (const call of last.toolCalls) {
        calls += 1;
        const sig = `${call.name}|${call.argumentsText ?? ''}`; repeats.set(sig, (repeats.get(sig) ?? 0) + 1);
        const result = calls > MAX_TOOL_CALLS ? { error: 'tool_call_limit_reached' } : repeats.get(sig) > 2 ? { error: 'repeated_call', note: 'You already made this exact call twice this turn; the answer will not change right now. Stop and answer him with what you know (say plainly if something is still running or waiting).' } : member && !MEMBER_TOOLS.has(call.name) ? { error: 'not_available' } : await this.#runTool(call, conversationId, member ? { member: true, userId } : {});
        if (result?.error) {
          const k = `${call.name}|${String(result.error).slice(0, 120)}`;
          const n = (failures.get(k) ?? 0) + 1; failures.set(k, n);
          if (n >= 2) result.stop_retrying = 'Same error as your previous attempt: do not call this tool again this turn. Tell him plainly what failed (and what would fix it, e.g. connecting the account).';
        }
        if (Array.isArray(result?._attach)) { attachments.push(...result._attach); delete result._attach; result.attached_to_your_reply = true; }
        if (routed && call.name === 'tools_load' && Array.isArray(result?.loaded)) { loadGroups(result.loaded); for (const g of result.loaded) loadedByModel.add(g); }
        toolsUsed.push({ name: call.name, ok: !result.error });
        onTool?.({ name: call.name, ok: !result.error });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, RESULT_CHARS) });
      }
    }
    if (last.toolCalls.length) {
      // Step budget exhausted mid-tool-use (even if that step also said something): the last tools' results still need
      // reporting. Like the loop, a failure here keeps what was already shown.
      const shown = said.length > 0 || attachments.length > 0;
      try { last = await this.ai.chat([...messages, { role: 'user', content: 'Wrap up now in plain language using only what the tools returned.' }], { signal, onDelta, stream: Boolean(onDelta), allowEmpty: shown }); }
      catch (error) { if (!shown || signal?.aborted) throw error; last = { ...last, content: '', toolCalls: [] }; }
    }
    if (claimsActionWithoutTool(last.content, toolsUsed)) { // still claiming without a tool after the retry: be honest instead
      last = { ...last, content: 'Hold on — I said I’d do that, but I didn’t actually run anything, so nothing is queued and no approval was sent. Tell me again and I’ll do it properly, or say what you want changed.' };
    }
    const final = String(last.content ?? '').trim();
    if (final && said.at(-1) !== final) said.push(final);
    const spoken = feminize(stripFileNotes(said.join('\n\n'))); // she is a woman in Hinglish too ("dungi", never "dunga") // the history's "[attached files: …]" notes are bookkeeping; she sometimes copies the format
    const reply = channel === 'voice' ? spoken : stripStageDirections(spoken);
    if (!member) this.habits?.record(reply);
    if (routed) this.toolRouter.remember(conversationId, [...toolsUsed.map((t) => t.name), ...[...loadedByModel].map((g) => GROUPS[g].tools[0])]);
    return { reply, model: last.model, provider: last.provider, toolsUsed, attachments: [...new Set(attachments)], usage: last.usage, usedVector: ctxInfo.usedVector, memoryIds: ctxInfo.memoryIds };
  }

  // Guests get persona only: no memory, no context, no tools, and a separate conversation.
  async #respondGuest({ conversationId, onDelta, signal }) {
    const moodNow = this.mood?.current({ moodiness: this.personality().moodiness }) ?? null;
    const messages = [{ role: 'system', content: buildGuestPrompt({ ownerName: this.settings.get('user_name', null), mood: moodNow }) }, ...this.chat.historyForProvider(conversationId, 12)];
    const out = await this.ai.chat(messages, { signal, stream: Boolean(onDelta), onDelta, maxTokens: 1024, temperature: 0.8 });
    return { reply: feminize(out.content.trim()), model: out.model, provider: out.provider, toolsUsed: [], usage: out.usage, usedVector: false, memoryIds: [] };
  }

  async #runTool(call, conversationId, who = {}) {
    const tool = this.fridayTools.get(call.name);
    this.bus?.publish('tool.called', { name: call.name, conversationId });
    if (!tool) return { error: 'unknown_tool' };
    if (call.args === null) return { error: 'invalid_json_arguments' };
    if (tool.risk !== 'safe') {
      // Gated tools: the policy (never the model, never the personality) decides.
      // category/riskClass may depend on the arguments (e.g. a watch that only notifies vs one that queues actions)
      const category = typeof tool.category === 'function' ? tool.category(call.args) : tool.category;
      const riskClass = (typeof tool.riskClass === 'function' ? tool.riskClass(call.args) : tool.riskClass) ?? 'consequential';
      const decision = this.policy ? this.policy.decide({ category, risk: riskClass, forbidden: tool.forbidden }) : 'ask';
      if (decision === 'deny') return { error: 'forbidden_action' };
      // A gated tool may check its arguments first (e.g. the outreach quality review), whatever the autonomy tier,
      // so nothing that would be refused or is not ready is staged for approval or run.
      if (tool.validate) { try { const v = await tool.validate(call.args); if (v?.error) return v; } catch (e) { return { error: e instanceof TypeError ? e.message : 'validation_failed' }; } }
      if (decision === 'ask') {
        if (!this.approvals) return { error: 'requires_approval', note: 'This action needs approval and no approval flow is available; it was NOT performed.' };
        const a = this.approvals.request({ category, risk: riskClass, tool: tool.name, summary: tool.summarize ? tool.summarize(call.args) : `${tool.name}`, payload: call.args, conversationId });
        return { requires_approval: true, approval_id: a.id.slice(0, 8), note: 'Staged and waiting for the user to approve in their inbox. It was NOT performed yet. Tell the user.' };
      }
    }
    try {
      const out = await tool.run(call.args, { conversationId, ...who });
      try { this.audit?.append(conversationId, 'tool.run', { tool: call.name }); } catch {}
      return out ?? { ok: true };
    } catch (error) {
      return { error: error instanceof TypeError ? error.message : 'tool_failed' };
    }
  }
}
