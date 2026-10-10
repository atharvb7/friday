import { classifyLocal } from '../intent.mjs';
import { answerLocal } from '../chat-reply.mjs';

// Only exact memory/file stores stay deterministic-local when a brain is live.
const DETERMINISTIC_LOCAL = new Set(['memory', 'file_search', 'file_read']);
const QUEUE_AS_TASK = new Set(['coding', 'research', 'browser', 'desktop', 'voice']);

export function chatRoutes(router, ctx) {
  const { chat, store, memory, tools, jev, audit, pet, env } = ctx;

  router.get('/v1/chats', () => [200, { conversations: chat.listConversations() }]);

  router.get('/v1/chat/:id([a-f0-9-]+)', ({ params }) => {
    try { return [200, { conversation: chat.getConversation(params.id), messages: chat.listMessages(params.id) }]; }
    catch (error) { return [404, { error: error.message }]; }
  });

  router.post('/v1/chat', async ({ body }) => {
    const b = await body();
    if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 20000) return [400, { error: 'invalid_message' }];
    const text = b.message.trim();
    let convo;
    if (b.conversationId !== undefined && b.conversationId !== null) {
      convo = chat.getConversation(b.conversationId);
      if (!convo) return [404, { error: 'conversation_not_found' }];
    } else {
      convo = chat.createConversation(text.slice(0, 60));
    }
    chat.addMessage(convo.id, 'user', text);

    // JEV is off unless enabled; the local classifier is the deterministic default.
    const route = env.FRIDAY_JEV_ENABLED === '1' ? await jev.routeInstruction(text) : classifyLocal(text);
    const brain = ctx.chatBrain();
    let reply = '';
    let chatModel = null;
    try {
      if (route.riskScore >= 3) {
        reply = (await answerLocal({ ...route, needsApproval: true }, text, { memory, tools })).text;
      } else if (DETERMINISTIC_LOCAL.has(route.intent)) {
        reply = (await answerLocal(route, text, { memory, tools })).text;
      } else if (!brain.adapter && QUEUE_AS_TASK.has(route.intent)) {
        const task = store.createTask({ title: text.slice(0, 200), instruction: text });
        reply = `Got it — I’ve queued that as task “${task.title}” and I’ll work through it as soon as my agent runtime is connected. Anything read-only (files, memory) I can still do right now — just ask.`;
      } else if (brain.adapter) {
        const out = await brain.adapter.run({ taskId: convo.id, instruction: text, messages: chat.historyForProvider(convo.id, 20) });
        if (out.status === 'completed') { reply = out.output; chatModel = out.model ?? null; }
        else reply = `My Nemotron brain didn’t answer (${out.error}). I can still do local things right now — memory, files, tasks — or try again in a bit.`;
      } else {
        reply = (await answerLocal(route, text, { memory, tools })).text;
      }
    } catch (error) {
      reply = `Something hiccuped on my side (${error.message}). Your message is saved — try again?`;
    }
    chat.addMessage(convo.id, 'assistant', reply.slice(0, 20000));
    try { audit.append(convo.id, 'chat.reply', { intent: route.intent, brain: brain.name, source: route.source }); } catch {}
    try { pet.transition('wake'); } catch {}
    try { pet.transition('hear'); } catch {}
    ctx.bus.publish('chat.reply', { conversationId: convo.id, brain: brain.name });
    try { ctx.bus.publish('pet.state_changed', { state: pet.state }); } catch {}
    return [200, { conversation: chat.getConversation(convo.id), route, reply, brain: brain.name, model: chatModel }];
  });
}
