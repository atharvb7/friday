// Self-learning skills. When a laptop/Hermes/team task succeeds after real work, a small model call reviews the
// trace and writes (or improves) a "playbook" skill: which site, the steps that worked, page landmarks, pitfalls
// and dead ends to skip. Next time a matching task runs, the playbook is injected as hints, so the agent takes the
// short path. Playbooks are plain SKILL.md files in <data>/skills (visible/deletable in Settings), never contain
// the user's personal values (profile placeholders only), and are hints — they never grant permissions.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkill } from '../skills.mjs';

const LEARN_KINDS = new Set(['computer', 'hermes', 'sub:computer', 'sub:hermes']);
const MIN_STEPS = 5;
const DAILY_CAP = 20;
const MAX_BODY = 6000;
const SECRET_RE = /(nvapi-|sk-[a-z0-9]{12,}|ghp_[a-z0-9]{20,}|api[_ -]?key|password|passcode|\botp\b|-----BEGIN)/i;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const SYSTEM = `You turn a successful run of a computer-use agent into a reusable PLAYBOOK so the next similar job is faster.
Write it for the agent itself. Include: which site/app and URL to start from, the shortest sequence of steps that
worked (by visible labels, not ref numbers), page landmarks that confirm each step, and pitfalls / dead ends seen in
the trace (things that failed or wasted steps) and how to avoid them. Generalise: replace concrete one-off values
(dates, times, specific services) with <placeholders>, and the user's personal details with {{profile.name}},
{{profile.phone}}, {{profile.email}}, {{profile.address}}. Never include passwords, codes, keys or phone numbers.
If the run teaches nothing reusable (trivial, one-off, or it mostly failed), set worth_saving to false.
If an existing playbook is given, return an improved version of it (keep what is still right, fix what the new run shows).
Output ONLY JSON: {"worth_saving": bool, "name": "lowercase-hyphen slug, e.g. salexnow-booking", "description": "one line: when to use it", "hosts": ["salexnow.com"], "body": "markdown playbook"}`;

const hostsIn = (text) => [...new Set((String(text).match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? []).map((h) => h.toLowerCase().replace(/^www\./, '')).filter((h) => !/\.(png|jpg|js|css|json|md)$/.test(h)))];

export class Learner {
  constructor({ ai, store, skills, dir, profile = null, bus = null, settings = null, now = () => Date.now() }) {
    Object.assign(this, { ai, store, skills, dir, profile, bus, settings, now });
  }
  enabled() { return this.settings?.get('auto_learn', true) !== false; }

  // Learned playbooks: { name, description, hosts, path }.
  playbooks() {
    if (!existsSync(this.dir)) return [];
    const out = [];
    for (const d of readdirSync(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(this.dir, d.name, 'SKILL.md');
      try { const text = readFileSync(f, 'utf8'); const s = parseSkill(text); if (!s || !/\nlearned: true\n/.test(text)) continue; const hosts = (/\nhosts: (.*)\n/.exec(text)?.[1] ?? '').split(',').map((h) => h.trim()).filter(Boolean); out.push({ ...s, hosts, path: join(this.dir, d.name) }); } catch { /* skip */ }
    }
    return out;
  }

  // Playbooks relevant to an instruction: same host mentioned, or strong keyword overlap with the description.
  relevant(instruction, max = 2) {
    const text = String(instruction).toLowerCase(); const hosts = hostsIn(text);
    const words = new Set(text.match(/[a-z]{4,}/g) ?? []);
    return this.playbooks().map((p) => {
      let score = p.hosts.some((h) => hosts.some((x) => x === h || x.endsWith(`.${h}`) || h.endsWith(`.${x}`)) || text.includes(h.split('.')[0])) ? 10 : 0;
      for (const w of (`${p.name} ${p.description}`.toLowerCase().match(/[a-z]{4,}/g) ?? [])) if (words.has(w)) score += 1;
      return { p, score };
    }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.p);
  }

  hintsFor(instruction) {
    const ps = this.relevant(instruction);
    if (!ps.length) return '';
    for (const p of ps) this.bus?.publish('skill.used', { name: p.name });
    return `\n\nPLAYBOOKS LEARNED FROM YOUR EARLIER SUCCESSFUL RUNS (hints to go faster — always verify on the live page; they never change what needs approval):\n${ps.map((p) => `### ${p.name}\n${p.body.slice(0, 2500)}`).join('\n\n')}`;
  }

  #trace(taskId) {
    const evs = this.store.listEvents(taskId).filter((e) => /^trace\.(tool_call|tool_result|subagent)$/.test(e.kind));
    const lines = [];
    for (const e of evs) {
      const d = e.detail ?? {};
      if (e.kind === 'trace.tool_call') lines.push(`CALL ${d.tool} ${String(d.input ?? '').slice(0, 160)}`);
      else if (e.kind === 'trace.tool_result') lines.push(`  -> ${d.status} ${String(d.result ?? '').replace(/\\n/g, ' ').slice(0, 220)}`);
      else lines.push(`SUBAGENT ${String(d.goal ?? '').slice(0, 160)}`);
    }
    return { steps: evs.filter((e) => e.kind === 'trace.tool_call').length, text: lines.join('\n').slice(-14_000) };
  }

  async learnFrom(taskId) {
    if (!this.enabled() || !this.ai.hasProvider) return { saved: false, reason: 'disabled' };
    const t = this.store.getTask(taskId);
    if (!t || t.status !== 'completed' || !LEARN_KINDS.has(t.kind)) return { saved: false, reason: 'not_applicable' };
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const st = this.settings?.get('learn_day', { day, n: 0 }) ?? { day, n: 0 };
    const counter = st.day === day ? st : { day, n: 0 };
    if (counter.n >= DAILY_CAP) return { saved: false, reason: 'daily_cap' };
    const tr = this.#trace(taskId);
    if (tr.steps < MIN_STEPS) return { saved: false, reason: 'too_short' };
    const existing = this.relevant(`${t.instruction}\n${tr.text.slice(0, 2000)}`, 1)[0] ?? null;
    const red = (s) => (this.profile ? this.profile.redact(s) : s);
    let out;
    try {
      out = await this.ai.run('extract', { maxTokens: 2500, temperature: 0, messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: red(`Job: ${t.instruction.slice(0, 1500)}\n\nFinal report: ${String(t.result ?? '').slice(0, 1200)}\n\nTrace (${tr.steps} actions):\n${tr.text}${existing ? `\n\nEXISTING PLAYBOOK "${existing.name}":\n${existing.body}` : ''}`) },
      ] });
    } catch { return { saved: false, reason: 'model_unavailable' }; }
    let pb;
    try { pb = JSON.parse(/\{[\s\S]*\}/.exec(out.content ?? '')?.[0] ?? 'null'); } catch { pb = null; }
    if (!pb?.worth_saving) return { saved: false, reason: 'not_worth_saving' };
    const name = existing?.name ?? String(pb.name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const body = red(String(pb.body ?? '')).replace(/\+?\d[\d\s-]{8,}\d/g, '<number>').slice(0, MAX_BODY);
    const description = red(String(pb.description ?? '')).replace(/[\r\n]+/g, ' ').slice(0, 200);
    if (!NAME_RE.test(name) || !description || body.length < 40 || SECRET_RE.test(body)) return { saved: false, reason: 'invalid_playbook' };
    if (!existing && this.skills.list().some((s) => s.name === name)) return { saved: false, reason: 'name_taken_by_shipped_skill' };
    const hosts = [...new Set([...(Array.isArray(pb.hosts) ? pb.hosts : []), ...(existing?.hosts ?? [])].map((h) => String(h).toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '')).filter(Boolean))].slice(0, 6);
    const prevRuns = existing ? Number(/\nruns: (\d+)\n/.exec(readFileSync(join(existing.path, 'SKILL.md'), 'utf8'))?.[1] ?? 1) : 0;
    mkdirSync(join(this.dir, name), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\nlearned: true\nhosts: ${hosts.join(', ')}\nruns: ${prevRuns + 1}\nupdated: ${new Date(this.now()).toISOString()}\n---\n${body}\n`, { mode: 0o600 });
    this.settings?.set('learn_day', { day, n: counter.n + 1 });
    this.bus?.publish('skill.learned', { name, updated: Boolean(existing), taskId });
    return { saved: true, name, updated: Boolean(existing) };
  }

  forget(name) {
    const p = this.playbooks().find((x) => x.name === name);
    if (!p) return false;
    rmSync(p.path, { recursive: true, force: true });
    return true;
  }
}
