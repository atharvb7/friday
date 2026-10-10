// Model-facing tools. Each tool declares a risk class:
//   safe  — runs immediately (reads, the user's own memory, queueing tasks)
//   gated — never runs directly; the brain stages it for explicit approval
// Results are small JSON objects; text from external sources is data only.
const clip = (s, n) => String(s ?? '').slice(0, n);
const str = (v, name, max = 2000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new TypeError(`${name} must be a non-empty string (<=${max})`);
  return v.trim();
};
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function buildFridayTools(ctx) {
  const { memory, store, tools, indexer } = ctx;
  const list = [
    {
      name: 'memory_save', risk: 'safe',
      description: 'Save a durable fact, preference, plan or decision about the user so you can recall it later. Not for secrets.',
      parameters: obj({
        content: { type: 'string', description: 'One clear sentence in third person, e.g. "User prefers PostgreSQL for databases."' },
        kind: { type: 'string', enum: ['long_term', 'preference', 'project', 'episodic'] },
        project: { type: 'string', description: 'Project name if this belongs to one' },
        importance: { type: 'number', description: '0..1, how important to keep (default 0.5)' },
      }, ['content']),
      run: (a) => {
        const m = memory.create({ content: str(a.content, 'content', 1000), source: 'chat:model', kind: a.kind ?? 'long_term', project: a.project ?? null, importance: typeof a.importance === 'number' ? Math.min(1, Math.max(0, a.importance)) : 0.5, confidence: 0.9 });
        indexer?.kick();
        return { saved: true, id: m.id.slice(0, 8) };
      },
    },
    {
      name: 'memory_search', risk: 'safe',
      description: 'Search what you remember about the user (keyword + semantic). Use before answering questions about their past statements.',
      parameters: obj({ query: { type: 'string' }, limit: { type: 'integer' } }, ['query']),
      run: async (a) => {
        const q = str(a.query, 'query', 200);
        const qv = indexer ? await indexer.queryVector(q) : null;
        const rows = memory.searchHybrid(q, { queryVector: qv, limit: Math.min(Number(a.limit) || 6, 10) });
        memory.touch(rows.map((r) => r.id));
        return { results: rows.map((r) => ({ id: r.id.slice(0, 8), content: clip(r.content, 400), kind: r.kind, project: r.project, pinned: Boolean(r.pinned), saved: r.created_at })) };
      },
    },
    {
      name: 'memory_forget', risk: 'safe',
      description: 'Delete one memory by the id shown in search results (user explicitly asked to forget it).',
      parameters: obj({ id: { type: 'string', description: 'id prefix (8+ chars) from memory_search' } }, ['id']),
      run: (a) => {
        const prefix = str(a.id, 'id', 64);
        if (prefix.length < 8) throw new TypeError('id too short');
        const rows = memory.db.prepare('SELECT id FROM memories WHERE id LIKE ?').all(`${prefix.replace(/[%_]/g, '')}%`);
        if (rows.length !== 1) return { deleted: false, reason: rows.length ? 'ambiguous_id' : 'not_found' };
        return { deleted: memory.delete(rows[0].id) };
      },
    },
    {
      name: 'task_create', risk: 'safe',
      description: 'Queue a long or multi-step job (research, coding, browsing, reports) for the background agent. Returns immediately; the work happens later.',
      parameters: obj({ title: { type: 'string' }, instruction: { type: 'string', description: 'Complete, self-contained instructions for the background agent' } }, ['title', 'instruction']),
      run: (a) => {
        const t = store.createTask({ title: str(a.title, 'title', 200), instruction: str(a.instruction, 'instruction', 20000) });
        return { queued: true, id: t.id.slice(0, 8), status: t.status };
      },
    },
    {
      name: 'task_list', risk: 'safe',
      description: 'List recent background tasks and their status.',
      parameters: obj({ status: { type: 'string', enum: ['queued', 'planning', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'] } }),
      run: (a) => ({ tasks: store.listTasks().filter((t) => !a.status || t.status === a.status).slice(0, 12).map((t) => ({ id: t.id.slice(0, 8), title: clip(t.title, 100), status: t.status, result: t.status === 'completed' ? clip(t.result, 300) : undefined, error: t.error ? clip(t.error, 160) : undefined })) }),
    },
    {
      name: 'task_cancel', risk: 'safe',
      description: 'Cancel a background task by id prefix.',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      run: (a) => {
        const prefix = str(a.id, 'id', 64);
        const matches = store.listTasks().filter((t) => t.id.startsWith(prefix));
        if (matches.length !== 1) return { cancelled: false, reason: matches.length ? 'ambiguous_id' : 'not_found' };
        ctx.worker.cancel(matches[0].id);
        const r = store.transition(matches[0].id, 'cancelled');
        return { cancelled: !r.error, reason: r.error ?? undefined };
      },
    },
    {
      name: 'file_search', risk: 'safe',
      description: "Find files by name in Friday's own workspace (not the user's whole disk).",
      parameters: obj({ query: { type: 'string' } }, ['query']),
      run: async (a) => ({ files: (await tools.run({ taskId: 'ad-hoc-local', tool: 'file.search', args: { query: str(a.query, 'query', 200), root: '.', limit: 10 } })).result }),
    },
    {
      name: 'file_read', risk: 'safe',
      description: "Read a text file from Friday's workspace (first 8KB).",
      parameters: obj({ path: { type: 'string' } }, ['path']),
      run: async (a) => { const r = (await tools.run({ taskId: 'ad-hoc-local', tool: 'file.read', args: { path: str(a.path, 'path', 500), maxBytes: 8192 } })).result; return { path: r.path, truncated: r.truncated, text: clip(r.bytes, 6000) }; },
    },
    {
      name: 'time_now', risk: 'safe',
      description: 'Current date/time (use instead of guessing).',
      parameters: obj({}),
      run: () => ({ iso: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    },
  ];
  // Phases 4+ register more (reminders, research, browser, laptop node).
  return {
    list: () => list,
    get: (name) => list.find((t) => t.name === name),
    register: (tool) => { list.push(tool); },
    schemas: () => list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
}
