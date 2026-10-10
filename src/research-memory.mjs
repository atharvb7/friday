// Persistent research memory. A research task's agent writes findings.json (+
// report.md) in its workspace; Friday ingests it into SQLite so "what did we
// learn about X last month?" is answerable with sources, dates and confidence.
//
// findings.json: { topic, summary, confidence?, sources:[{url,title,date?,quote?}],
//   claims:[{topic,claim,sourceUrl,confidence?}], contradictions?:[{topic,note}] }
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE = 2 * 1024 * 1024;
const clip = (s, n) => String(s ?? '').slice(0, n);
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const CONF = ['high', 'medium', 'low'];

export class ResearchMemory {
  constructor({ store, bus = null }) {
    this.db = store.db; this.bus = bus;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rm_projects (id TEXT PRIMARY KEY, task_id TEXT, topic TEXT NOT NULL, summary TEXT NOT NULL, confidence TEXT, report_md TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rm_sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, published TEXT, quote TEXT, collected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rm_claims (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT, topic TEXT, claim TEXT NOT NULL, confidence TEXT, contradicted INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS rm_fts USING fts5(text, project_id UNINDEXED, kind UNINDEXED);
    `);
  }

  // Validate + persist. Throws TypeError on malformed findings.
  ingest({ taskId = null, findings, reportMd = null }) {
    if (!findings || typeof findings !== 'object') throw new TypeError('findings must be an object');
    const topic = clip(findings.topic, 200).trim();
    const summary = clip(findings.summary, 4000).trim();
    if (!topic || !summary) throw new TypeError('findings need topic and summary');
    const sources = Array.isArray(findings.sources) ? findings.sources.slice(0, 200) : [];
    const claims = Array.isArray(findings.claims) ? findings.claims.slice(0, 500) : [];
    const pid = randomUUID(); const now = new Date().toISOString();
    const conf = CONF.includes(findings.confidence) ? findings.confidence : null;
    const urlToId = new Map();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO rm_projects VALUES (?,?,?,?,?,?,?)').run(pid, taskId, topic, summary, conf, reportMd ? clip(reportMd, 200_000) : null, now);
      this.db.prepare('INSERT INTO rm_fts (text, project_id, kind) VALUES (?,?,?)').run(`${topic}\n${summary}`, pid, 'project');
      for (const s of sources) {
        let url; try { url = new URL(String(s.url)); } catch { continue; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        const id = randomUUID(); urlToId.set(url.toString(), id);
        const published = s.date && !Number.isNaN(Date.parse(s.date)) ? new Date(s.date).toISOString().slice(0, 10) : null;
        this.db.prepare('INSERT INTO rm_sources VALUES (?,?,?,?,?,?,?)').run(id, pid, url.toString(), clip(s.title || url.hostname, 300), published, s.quote ? clip(s.quote, 1000) : null, now);
      }
      // contradiction detection: same normalized topic, different claim text, different sources
      const byTopic = new Map();
      const rows = [];
      for (const c of claims) {
        const text = clip(c.claim, 2000).trim(); if (!text) continue;
        let sid = null; try { sid = urlToId.get(new URL(String(c.sourceUrl)).toString()) ?? null; } catch {}
        const row = { id: randomUUID(), sid, topic: c.topic ? clip(c.topic, 200) : null, text, conf: CONF.includes(c.confidence) ? c.confidence : null, contradicted: 0, note: null };
        rows.push(row);
        if (row.topic) { const k = norm(row.topic); byTopic.set(k, [...(byTopic.get(k) ?? []), row]); }
      }
      for (const g of byTopic.values()) {
        if (new Set(g.map((r) => norm(r.text))).size > 1 && new Set(g.map((r) => r.sid ?? r.id)).size > 1) g.forEach((r) => { r.contradicted = 1; });
      }
      for (const c of findings.contradictions ?? []) {
        const t = norm(c.topic ?? ''); for (const r of rows) if (t && r.topic && norm(r.topic) === t) { r.contradicted = 1; r.note = clip(c.note, 500); }
      }
      for (const r of rows) {
        this.db.prepare('INSERT INTO rm_claims VALUES (?,?,?,?,?,?,?,?,?)').run(r.id, pid, r.sid, r.topic, r.text, r.conf, r.contradicted, r.note, now);
        this.db.prepare('INSERT INTO rm_fts (text, project_id, kind) VALUES (?,?,?)').run(`${r.topic ?? ''}\n${r.text}`, pid, 'claim');
      }
      this.db.exec('COMMIT');
      this.bus?.publish('research.saved', { id: pid, topic });
      return { id: pid, topic, sources: urlToId.size, claims: rows.length, contradictions: rows.filter((r) => r.contradicted).length };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // Read findings.json / report.md the agent left in its workspace.
  ingestFromDir({ taskId, dir }) {
    const f = join(dir, 'findings.json');
    if (!existsSync(f) || statSync(f).size > MAX_FILE) throw new TypeError('findings.json missing or too large');
    const findings = JSON.parse(readFileSync(f, 'utf8'));
    const r = join(dir, 'report.md');
    return this.ingest({ taskId, findings, reportMd: existsSync(r) && statSync(r).size <= MAX_FILE ? readFileSync(r, 'utf8') : null });
  }

  search(query, { limit = 6 } = {}) {
    const terms = String(query).match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const q = terms.slice(0, 10).map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const hits = this.db.prepare('SELECT project_id, kind, text FROM rm_fts WHERE rm_fts MATCH ? ORDER BY bm25(rm_fts) LIMIT 40').all(q);
    const order = []; const seen = new Set();
    for (const h of hits) if (!seen.has(h.project_id)) { seen.add(h.project_id); order.push(h.project_id); }
    return order.slice(0, limit).map((id) => this.project(id, { claimsLimit: 5 }));
  }

  project(id, { claimsLimit = 50 } = {}) {
    const p = this.db.prepare('SELECT id, task_id, topic, summary, confidence, created_at FROM rm_projects WHERE id=?').get(id);
    if (!p) return null;
    const srcs = this.db.prepare('SELECT id, url, title, published, collected_at FROM rm_sources WHERE project_id=?').all(id);
    const byId = new Map(srcs.map((s) => [s.id, s]));
    const claims = this.db.prepare('SELECT * FROM rm_claims WHERE project_id=? ORDER BY contradicted DESC, created_at ASC LIMIT ?').all(id, claimsLimit)
      .map((c) => ({ topic: c.topic, claim: c.claim, confidence: c.confidence, contradicted: Boolean(c.contradicted), note: c.note, source: byId.get(c.source_id) ? { title: byId.get(c.source_id).title, url: byId.get(c.source_id).url, published: byId.get(c.source_id).published } : null }));
    return { ...p, sourceCount: srcs.length, claims };
  }

  list(limit = 20) { return this.db.prepare('SELECT id, topic, summary, confidence, created_at FROM rm_projects ORDER BY created_at DESC LIMIT ?').all(limit); }
  report(id) { return this.db.prepare('SELECT report_md FROM rm_projects WHERE id=?').get(id)?.report_md ?? null; }
}

export const RESEARCH_CONTRACT = `
OUTPUT CONTRACT (mandatory): when finished, write two files in your working directory:
1. report.md — the full report with inline citations [1], [2] and a numbered Sources list.
2. findings.json — {"topic": str, "summary": str (<=1500 chars), "confidence": "high|medium|low",
   "sources": [{"url": str, "title": str, "date": "YYYY-MM-DD"|null, "quote": str|null}],
   "claims": [{"topic": str, "claim": str, "sourceUrl": str (must appear in sources), "confidence": "high|medium|low"}],
   "contradictions": [{"topic": str, "note": str}]}
Use the same claim "topic" string when two sources speak about the same fact so contradictions can be detected. Then give a short final answer.`;
