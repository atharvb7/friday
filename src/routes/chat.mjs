import { classifyLocal } from '../intent.mjs';
import { answerLocal } from '../chat-reply.mjs';

// Fallback mode (no live brain): only exact memory/file stores stay deterministic.
const DETERMINISTIC_LOCAL = new Set(['memory', 'file_search', 'file_read']);
const QUEUE_AS_TASK = new Set(['coding', 'research', 'browser', 'desktop', 'voice']);

export function chatRoutes(router, ctx) {
  const { chat, store, memory, tools, jev, audit, pet, env, bus } = ctx;

  router.get('/v1/chats', () => [200, { conversations: chat.listConversations() }]);

  router.get('/v1/chat/:id([a-f0-9-]+)', ({ params }) => {
    try { return [200, { conversation: chat.getConversation(params.id), messages: chat.listMessages(params.id) }]; }
    catch (error) { return [404, { error: error.message }]; }
  });

  // Shared turn logic. `hooks` carries streaming callbacks when the caller wants them.
  async function turn(args) {
    ctx.companion.chatStart();
    try { return await turnInner(args); } finally { ctx.companion.chatEnd(); }
  }
  async function turnInner({ convo, text, hooks = {}, signal = null }) {
    chat.addMessage(convo.id, 'user', text);
    const brain = ctx.chatBrain();
    // JEV is off unless enabled; the local classifier is the deterministic default.
    const route = env.FRIDAY_JEV_ENABLED === '1' ? await jev.routeInstruction(text) : classifyLocal(text);
    let reply = '';
    let model = null;
    let toolsUsed = [];
    try {
      if (brain.name === 'friday-brain') {
        const out = await brain.adapter.respond({ conversationId: convo.id, text, signal, ...hooks });
        reply = out.reply; model = out.model; toolsUsed = out.toolsUsed;
      } else if (route.riskScore >= 3) {
        reply = (await answerLocal({ ...route, needsApproval: true }, text, { memory, tools })).text;
      } else if (DETERMINISTIC_LOCAL.has(route.intent)) {
        reply = (await answerLocal(route, text, { memory, tools })).text;
      } else if (!brain.adapter && QUEUE_AS_TASK.has(route.intent)) {
        const task = store.createTask({ title: text.slice(0, 200), instruction: text });
        reply = `Got it — I’ve queued that as task “${task.title}” and I’ll work through it as soon as my agent runtime is connected. Anything read-only (files, memory) I can still do right now — just ask.`;
      } else if (brain.adapter) {
        const out = await brain.adapter.run({ taskId: convo.id, instruction: text, messages: chat.historyForProvider(convo.id, 20) });
        if (out.status === 'completed') { reply = out.output; model = out.model ?? null; }
        else reply = `My brain didn’t answer (${out.error}). I can still do local things right now — memory, files, tasks — or try again in a bit.`;
      } else {
        reply = (await answerLocal(route, text, { memory, tools })).text;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (brain.name === 'friday-brain' && DETERMINISTIC_LOCAL.has(route.intent) && route.riskScore < 3) {
        reply = `(My cloud brain is unreachable, so this is the offline answer.)\n${(await answerLocal(route, text, { memory, tools })).text}`;
      } else {
        reply = `My brain providers aren’t answering right now (${String(error.message).slice(0, 160)}). Your message is saved. Memory, files and tasks still work — try again in a moment.`;
      }
    }
    reply = (reply || '…').slice(0, 20000);
    chat.addMessage(convo.id, 'assistant', reply);
    try { audit.append(convo.id, 'chat.reply', { intent: route.intent, brain: brain.name, source: route.source, tools: toolsUsed.map((t) => t.name) }); } catch {}
    try { pet.transition('wake'); } catch {}
    try { pet.transition('hear'); } catch {}
    bus.publish('chat.reply', { conversationId: convo.id, brain: brain.name });
    try { bus.publish('pet.state_changed', { state: pet.state }); } catch {}
    return { conversation: chat.getConversation(convo.id), route, reply, brain: brain.name, model, toolsUsed };
  }

  function openConversation(b) {
    if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 20000) return { error: [400, { error: 'invalid_message' }] };
    const text = b.message.trim();
    if (b.conversationId !== undefined && b.conversationId !== null) {
      const convo = chat.getConversation(b.conversationId);
      return convo ? { convo, text } : { error: [404, { error: 'conversation_not_found' }] };
    }
    return { convo: chat.createConversation(text.slice(0, 60)), text };
  }

  // One-shot text turn for non-browser clients (voice devices): returns just the reply.
  ctx.quickTurn = async (text, conversationId = null) => {
    const convo = (conversationId && chat.getConversation(conversationId)) || chat.createConversation(text.slice(0, 60));
    return turn({ convo, text });
  };

  router.post('/v1/chat', async ({ body }) => {
    const b = await body();
    const opened = openConversation(b);
    if (opened.error) return opened.error;
    if (b.stream !== true) return [200, await turn(opened)];

    // Streaming: SSE frames {meta|delta|thinking|tool|done|error}.
    return {
      raw: async (res) => {
        const ctrl = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ctrl.abort(new Error('client_closed')); });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('meta', { conversationId: opened.convo.id });
        let thinking = false; // one frame per burst of reasoning, not one per token
        try {
          const out = await turn({
            ...opened, signal: ctrl.signal,
            hooks: { onDelta: (t) => { thinking = false; send('delta', { text: t }); }, onThinking: () => { if (!thinking) { thinking = true; send('thinking', {}); } }, onTool: (t) => { thinking = false; send('tool', t); } },
          });
          send('done', { reply: out.reply, brain: out.brain, model: out.model, toolsUsed: out.toolsUsed, conversationId: out.conversation.id });
        } catch (error) { send('error', { error: ctrl.signal.aborted ? 'cancelled' : 'internal_error' }); }
        res.end();
      },
    };
  });

  // Personality (style only) + the user's name.
  router.get('/v1/personality', () => [200, { personality: ctx.brain.personality(), userName: ctx.settings.get('user_name', null) }]);
  router.post('/v1/personality', async ({ body }) => {
    const b = await body();
    try {
      const { normalizePersonality } = await import('../personality.mjs');
      const next = normalizePersonality({ ...ctx.brain.personality(), ...(b.personality ?? {}) });
      ctx.settings.set('personality', next);
      if (typeof b.userName === 'string') ctx.settings.set('user_name', b.userName.trim().slice(0, 60) || null);
      bus.publish('personality.changed', {});
      return [200, { personality: next, userName: ctx.settings.get('user_name', null) }];
    } catch (error) { return [400, { error: error.message }]; }
  });

  router.get('/v1/models', () => [200, { router: ctx.ai.status(), stats24h: ctx.ai.stats(), embeddings: { embedded: memory.countEmbedded(), model: ctx.indexer.model, lastError: ctx.indexer.lastError } }]);
}
