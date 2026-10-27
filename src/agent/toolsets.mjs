// Tool loading: send the model only the tools a turn needs.
// The 73 tool schemas are ~12k tokens, three quarters of every brain call, and they are resent
// on every step of the tool loop. A turn gets the CORE set plus the groups its words point to
// (and groups used in the last few turns of the conversation); the model can pull in any other
// group itself with tools_load. Fewer, relevant tools also make tool choice more accurate.
// FRIDAY_TOOL_ROUTING=0 sends every tool (for A/B benchmarks).

// Always loaded: small, and needed in almost any conversation.
export const CORE = new Set(['memory_save', 'memory_search', 'memory_forget', 'time_now', 'set_timezone', 'profile_set',
  'reminder_create', 'reminder_list', 'reminder_cancel', 'reminder_snooze', 'task_create', 'task_list', 'task_cancel', 'answer_task_question',
  'web_search', 'web_fetch', 'skill_load', 'files_list', 'file_share', 'tools_load', 'todo_add', 'todo_list', 'todo_update', 'reminder_update']);

// group -> { about (shown to the model in tools_load), tools, match (words in the user's message that need it) }
export const GROUPS = {
  email: { about: "his Gmail: search, open, organise, send/reply/forward", tools: ['email_search', 'email_open', 'email_organize', 'email_send'],
    match: /\b(e-?mails?|mails?|inbox|gmail|unread|reply to|forward|draft|newsletter|unsubscribe|spam)\b/i },
  business: { about: 'sales: business profile, leads pipeline, outreach emails, do-not-contact, the 24/7 client-hunting pipeline', tools: ['business_profile', 'lead_save', 'lead_find', 'lead_update', 'outreach_pause', 'outreach_cancel', 'do_not_contact', 'outreach_send', 'prospecting_setup', 'prospecting_run_now', 'prospecting_status'],
    match: /\b(leads?|prospect\w*|outreach|pipeline|clients?|customers?|pitch\w*|cold|follow[- ]?ups?|sales?|sell\w*|offers?|business profile|deals?|crm|campaign|agency|freelanc\w*|do[- ]not[- ]contact|bounce\w*)\b/i },
  laptop: { about: 'his laptop: open any app/site/file instantly, look at the screen, run shell commands, and multi-step control of the browser and whole desktop (websites, WhatsApp, bookings, forms, any app); laptop status', tools: ['computer_task', 'laptop_status', 'laptop_open', 'laptop_screen', 'laptop_shell'],
    match: /\b(laptop|computer|pc|browser|chrome|firefox|open (the |my |up )?\w+|launch|close (the |my )?\w+|website|site|whats ?app|book(ing)?|order|buy|fill|form|log ?in|sign ?up|click|download|upload|youtube|spotify|netflix|amazon|flipkart|zomato|swiggy|uber|ola|irctc|desktop|screen|tab|window|terminal|shell|volume|mute|brightness|battery|wi-?fi|bluetooth|vs ?code|calculator|clipboard|(play|pause|stop|skip) (the |some |my )?(music|song|video|track))\b/i },
  social: { about: 'his Instagram: read, act, post, ongoing DM conversations; connect apps (Composio)', tools: ['instagram_read', 'instagram_action', 'instagram_post', 'dm_chat_start', 'dm_chat_status', 'dm_chat_stop', 'dm_chat_reply_now', 'connect_app', 'app_action_schema'],
    match: /\b(insta\w*|ig|dms?|direct messages?|followers?|stor(y|ies)|post (it|this|on)|caption|connect (my |an? )?app|composio)\b/i },
  reels: { about: 'make short videos/reels (storyboard -> generated clips -> zip), edit and send them', tools: ['reel_create', 'reel_edit', 'reel_send', 'reel_zip'],
    match: /\b(reels?|shorts?|videos?|clips?|storyboard|tiktok)\b/i },
  documents: { about: 'make Word/Excel/PowerPoint/PDF files, read or edit files he sent, read files in your workspace', tools: ['document_create', 'document_read', 'document_edit', 'file_read', 'file_search'],
    match: /\b(docs?|documents?|word|excel|sheets?|spreadsheet|xlsx|csv|pptx?|powerpoint|slides?|deck|pdf|resume|cv|invoice|report|letter|file|attached|attachment|table)\b|\[attached files:/i },
  images: { about: 'draw or generate pictures (illustration, photo-style, poster, logo idea, meme, wallpaper)', tools: ['image_create'],
    match: /\b(draw|image|picture|pic|photo|illustrat\w*|poster|wallpaper|logo|meme|sketch|paint\w*|art|render|selfie|avatar)\b/i },
  research: { about: 'deep multi-source research with a saved report, and search earlier research', tools: ['research_start', 'research_search'],
    match: /\b(research|deep dive|investigate|study|analy[sz]\w*|compare|comparison|report on|market|competitors?|earlier research|you found)\b/i },
  dev: { about: 'software work: coding agent, deploy/host apps on his server, Hermes agent, parallel team of agents', tools: ['code_task', 'app_deploy', 'app_list', 'app_logs', 'app_control', 'app_remove', 'hermes_task', 'team_task'],
    match: /\b(code|coding|program\w*|script|repo\w*|github|git|bug|debug|deploy\w*|host\w*|server|app|apps|website|landing page|api|frontend|backend|build (me|a|an)|hermes|team|agents?|docker|logs?)\b/i },
  automation: { about: 'recurring/scheduled agent jobs, watches (keep an eye on something and react), standing rules', tools: ['schedule_task', 'watch_create', 'watch_list', 'watch_cancel', 'rule_create'],
    match: /\b(every (day|morning|evening|night|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour)|daily|weekly|monthly|recurring|schedule\w*|watch\w*|keep an eye|monitor\w*|track\w*|alert me|notify me|let me know when|whenever|rules?|automat\w*)\b/i },
  tasks: { about: 'what background tasks actually did, learned playbooks, the briefing', tools: ['task_trace', 'learned_skills', 'briefing_now'],
    match: /\b(what (exactly )?did you do|trace|steps|playbooks?|learned|briefing|brief me|summary of (my|the) day|what('s| is) (up|pending|on my plate))\b/i },
};

// Skill playbooks matter for sales, software, research and writing work; elsewhere their names suffice.
export const SKILL_GROUPS = new Set(['business', 'dev', 'research', 'documents']);

const STICKY_TURNS = 3; // a group used in a turn stays loaded for the next few turns ("yes do it", "send it")

export function groupOf(toolName) {
  for (const [g, def] of Object.entries(GROUPS)) if (def.tools.includes(toolName)) return g;
  return CORE.has(toolName) ? 'core' : null;
}

export class ToolRouter {
  #recent = new Map(); // conversationId -> [{ turn, groups:Set }]
  #turn = 0;

  constructor({ enabled = true } = {}) { this.enabled = enabled; }

  // Groups for this turn: matched by the user's words (current + previous message) + recently used.
  select({ conversationId = null, text = '', previousText = '' }) {
    if (!this.enabled) return new Set(Object.keys(GROUPS));
    this.#turn += 1;
    const groups = new Set();
    for (const [g, def] of Object.entries(GROUPS)) if (def.match.test(text) || def.match.test(previousText)) groups.add(g);
    for (const r of this.#recent.get(conversationId) ?? []) if (this.#turn - r.turn <= STICKY_TURNS) for (const g of r.groups) groups.add(g);
    return groups;
  }

  // Remember which groups a turn actually used, so short follow-ups ("ok send it") keep their tools.
  remember(conversationId, toolNames) {
    const groups = new Set(toolNames.map(groupOf).filter((g) => g && g !== 'core'));
    if (!groups.size) return;
    const list = (this.#recent.get(conversationId) ?? []).filter((r) => this.#turn - r.turn < STICKY_TURNS);
    list.push({ turn: this.#turn, groups });
    this.#recent.set(conversationId, list);
    if (this.#recent.size > 500) this.#recent.delete(this.#recent.keys().next().value);
  }
}

// Schemas for core + the given groups, in the registry's stable order (stable prefixes cache better).
export function schemasFor(allSchemas, groups) {
  const allowed = new Set(CORE);
  for (const g of groups) for (const t of GROUPS[g]?.tools ?? []) allowed.add(t);
  const known = new Set(Object.values(GROUPS).flatMap((d) => d.tools));
  // A tool that belongs to no group (registered later, e.g. a plugin) is always sent: never hide something unknown.
  return allSchemas.filter((s) => { const n = s.function?.name ?? s.name; return allowed.has(n) || !known.has(n); });
}

export function toolsLoadTool() {
  const names = Object.keys(GROUPS);
  return {
    name: 'tools_load', risk: 'safe',
    description: `Only some of your tools are loaded right now. Load more tool groups when the request needs a tool you do not see (they are usable from your next step). Never tell him you cannot do something before checking here. Groups: ${names.map((g) => `${g} (${GROUPS[g].about})`).join('; ')}.`,
    parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string', enum: [...names, 'all'] } } }, required: ['groups'], additionalProperties: false },
    run: (a) => {
      const want = (a.groups ?? []).includes('all') ? names : (a.groups ?? []).filter((g) => GROUPS[g]);
      if (!want.length) return { error: `unknown group; choose from ${names.join(', ')}` };
      return { loaded: want, tools: want.flatMap((g) => GROUPS[g].tools), note: 'These tools are now available. Call the one you need.' };
    },
  };
}
