// src/chat-reply.mjs — local (no-model) chat answers for safe intents.
// Runs entirely on Friday's own stores: memory CRUD, confined file tools,
// conversation context. Anything consequential or unclear becomes words, never
// an action: the reply explains the approval path instead of acting.
const REMEMBER_RE = /^(please\s+)?remember(\s+that)?\s+/i;
const RECALL_RE = /what do you remember|what('s| is) my|recall|forget/i;

export async function answerLocal(route, text, { memory = null, tools = null } = {}) {
  const t = String(text ?? '').trim();
  const intent = route?.intent ?? 'unknown';

  if (RECALL_RE.test(t) && memory) {
    const q = t.replace(/what do you remember about|what do you remember|recall|remember/gi, '').trim() || t;
    let hits = [];
    try { hits = memory.search(q.slice(0, 200)); } catch { hits = []; }
    if (!hits.length) return { text: 'I don’t have anything saved about that yet. Tell me with “remember …” and I’ll keep it on this laptop.', acted: false };
    const lines = hits.slice(0, 5).map((m) => `• ${m.content}${m.project ? ` (${m.project})` : ''}`);
    return { text: `Here’s what I’ve got saved:\n${lines.join('\n')}`, acted: true };
  }

  if (intent === 'memory' && memory) {
    const content = t.replace(REMEMBER_RE, '').trim();
    if (!content || RECALL_RE.test(t)) {
      return { text: 'What should I remember? Say “remember …” followed by the fact or preference.', acted: false };
    }
    try {
      memory.create({ content: content.slice(0, 10000), source: 'chat' });
      return { text: `Saved. I’ll remember: “${content.slice(0, 200)}${content.length > 200 ? '…' : ''}”`, acted: true };
    } catch (error) {
      return { text: `I couldn’t save that (${error.message}). Try shorter text without secrets.`, acted: false };
    }
  }

  if ((intent === 'file_search' || intent === 'file_read') && tools) {
    try {
      if (intent === 'file_search') {
        const query = t.replace(/find|search|locate|where is|list files|files?/gi, '').trim() || t;
        const out = await tools.run({ taskId: 'ad-hoc-local', tool: 'file.search', args: { query: query.slice(0, 200), root: '.', limit: 10 } });
        if (!out.result.length) return { text: `No files matching “${query.slice(0, 100)}” in my workspace.`, acted: true };
        const lines = out.result.map((r) => `• ${r.path} (${r.size} bytes)`);
        return { text: `Found:\n${lines.join('\n')}`, acted: true };
      }
      const candidate = (t.match(/[\w.-]+\.[a-z0-9]{1,5}\b/i) || [])[0];
      if (intent === 'file_read' && candidate) {
        const out = await tools.run({ taskId: 'ad-hoc-local', tool: 'file.read', args: { path: candidate, maxBytes: 8192 } });
        const preview = out.result.bytes.slice(0, 1500);
        return { text: `${out.result.path}${out.result.truncated ? ' (truncated)' : ''}:\n${preview}`, acted: true };
      }
      if (intent === 'file_read') {
        return { text: 'Tell me the exact file name to read (inside my workspace) and I’ll show you a preview.', acted: false };
      }
      return { text: 'Tell me the exact file path to read (inside my workspace) and I’ll show you a preview.', acted: false };
    } catch (error) {
      return { text: `File lookup failed: ${error.message}`, acted: false };
    }
  }

  if (route?.needsApproval && (route?.riskScore ?? 0) >= 3) {
    return {
      text: 'That one is consequential, so I won’t act on words alone. Tell me the exact recipient/file/content and I’ll stage it for your one-tap approval — nothing sends without it.',
      acted: false,
    };
  }

  if (intent === 'chitchat') {
    const low = t.toLowerCase();
    if (/\b(bye|good ?night|see you)\b/.test(low)) {
      return { text: 'See you! I’ll be right here whenever you need me.', acted: false };
    }
    if (/\b(thanks|thank you)\b/.test(low)) {
      return { text: 'Anytime! What else can I do for you?', acted: false };
    }
    if (/\b(who are you|what can you do)\b/.test(low)) {
      return {
        text: 'I’m Friday, your laptop companion. Right now I can chat, remember things for you, find and read files in my workspace, track tasks, and take reminders. My full reasoning brain connects later — until then, talk to me like a friend.',
        acted: false,
      };
    }
    if (/\b(how are you|how('s| is) it going)\b/.test(low)) {
      return { text: 'Running smooth — memory’s cool, tasks are quiet, and I’ve got you. How are you doing?', acted: false };
    }
    return {
      text: 'Hey! Good to hear from you. What’s on your mind — a question, something to remember, a file to find, or work to get done?',
      acted: false,
    };
  }

  if (intent === 'schedule' || intent === 'automation') {
    return { text: 'I can schedule that. Give me a when (date + time), and I’ll queue it durably — I’ll confirm before anything runs.', acted: false };
  }

  // No-model small talk: stay conversational, echo briefly, invite more.
  // Never the robotic "I don't understand" for short human messages.
  if (t.length <= 60) {
    return {
      text: `“${t}” — gotcha, I’m listening. Tell me a little more — ask me anything, or put me to work with things like “find X”, “remember Y”, or “remind me …”.`,
      acted: false,
    };
  }
  return {
    text: 'Hmm, I want to get this right — could you say that a little differently? I’m best with things like “find X”, “remember Y”, “read <file>”, or “remind me …”.',
    acted: false,
  };
}
