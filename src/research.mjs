// src/research.mjs — research pipeline: sources, claims, contradictions, report.
//
// Safety rules (v1):
// - No network fetch. URLs are validated syntactically only (https: required);
//   recording a source never retrieves anything.
// - In-memory Maps are primary. A Store may be passed for optional SQLite
//   persistence (tables `research_sources` / `research_claims`); rows are
//   loaded on construction and mirrored on every write.
// - Contradiction flag: claims that share one normalized topic but carry
//   different normalized claim text from different sources are flagged, and
//   every involved claim is marked `contradicted: true`.

import { randomUUID } from 'node:crypto';

export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 200;
export const MAX_CLAIM_LENGTH = 2000;
export const MAX_QUOTE_LENGTH = 2000;
export const MAX_TOPIC_LENGTH = 200;
export const MAX_TASK_ID_LENGTH = 200;

function assertRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('args must be an object');
  }
}

function assertText(value, { min = 1, max, name }) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new TypeError(`invalid ${name}`);
  }
  return value.trim();
}

function normalizeTopic(topic) {
  return topic.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeClaimText(claim) {
  return claim.trim().toLowerCase().replace(/\s+/g, ' ');
}

function assertHttpsUrl(value) {
  const trimmed = assertText(value, { max: MAX_URL_LENGTH, name: 'url' });
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError('url must be a valid URL');
  }
  if (url.protocol !== 'https:') throw new TypeError('url must use https');
  return trimmed;
}

function assertIsoDate(value, name) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`invalid ${name}`);
  }
  return new Date(value).toISOString();
}

export class ResearchStore {
  constructor({ store = null } = {}) {
    if (store !== null && store !== undefined && (typeof store !== 'object' || !store.db)) {
      throw new TypeError('invalid store');
    }
    this.sources = new Map();
    this.claims = new Map();
    // topicKey (normalized topic) -> { topic, claimIds }
    this.contradictions = new Map();
    this.db = store?.db ?? null;
    if (this.db) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS research_sources (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS research_claims (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          claim TEXT NOT NULL,
          quote TEXT,
          topic TEXT,
          contradicted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);
      for (const row of this.db.prepare('SELECT * FROM research_sources').all()) {
        this.sources.set(row.id, { id: row.id, url: row.url, title: row.title, fetchedAt: row.fetched_at });
      }
      for (const row of this.db.prepare('SELECT * FROM research_claims ORDER BY created_at ASC').all()) {
        this.claims.set(row.id, {
          id: row.id,
          sourceId: row.source_id,
          claim: row.claim,
          quote: row.quote,
          topic: row.topic,
          contradicted: row.contradicted === 1,
          createdAt: row.created_at,
        });
      }
      this.recomputeContradictions();
    }
  }

  recordSource({ url, title, fetchedAt = null } = {}) {
    assertRecord({ url, title, fetchedAt });
    const cleanUrl = assertHttpsUrl(url);
    const cleanTitle = assertText(title, { max: MAX_TITLE_LENGTH, name: 'title' });
    const cleanFetchedAt = fetchedAt === null || fetchedAt === undefined
      ? new Date().toISOString()
      : assertIsoDate(fetchedAt, 'fetchedAt');
    const record = { id: randomUUID(), url: cleanUrl, title: cleanTitle, fetchedAt: cleanFetchedAt };
    this.sources.set(record.id, record);
    if (this.db) {
      this.db.prepare('INSERT INTO research_sources (id, url, title, fetched_at) VALUES (?, ?, ?, ?)').run(
        record.id, record.url, record.title, record.fetchedAt,
      );
    }
    return { ...record };
  }

  recordClaim({ sourceId, claim, quote = null, topic = null } = {}) {
    assertRecord({ sourceId, claim, quote, topic });
    if (typeof sourceId !== 'string' || !sourceId.trim()) throw new TypeError('invalid sourceId');
    if (!this.sources.has(sourceId)) throw new Error('unknown source');
    const cleanClaim = assertText(claim, { max: MAX_CLAIM_LENGTH, name: 'claim' });
    let cleanQuote = null;
    if (quote !== null && quote !== undefined) {
      cleanQuote = assertText(quote, { max: MAX_QUOTE_LENGTH, name: 'quote' });
    }
    let cleanTopic = null;
    if (topic !== null && topic !== undefined) {
      cleanTopic = assertText(topic, { max: MAX_TOPIC_LENGTH, name: 'topic' });
    }
    const record = {
      id: randomUUID(),
      sourceId,
      claim: cleanClaim,
      quote: cleanQuote,
      topic: cleanTopic,
      contradicted: false,
      createdAt: new Date().toISOString(),
    };
    this.claims.set(record.id, record);
    this.recomputeContradictions();
    if (this.db) {
      this.db.prepare('INSERT INTO research_claims (id, source_id, claim, quote, topic, contradicted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        record.id, record.sourceId, record.claim, record.quote, record.topic,
        this.claims.get(record.id).contradicted ? 1 : 0, record.createdAt,
      );
      this.persistContradictionFlags();
    }
    return { ...this.claims.get(record.id) };
  }

  recomputeContradictions() {
    for (const claim of this.claims.values()) claim.contradicted = false;
    this.contradictions.clear();
    const byTopic = new Map();
    for (const claim of this.claims.values()) {
      if (!claim.topic) continue;
      const key = normalizeTopic(claim.topic);
      if (!byTopic.has(key)) byTopic.set(key, []);
      byTopic.get(key).push(claim);
    }
    for (const [key, group] of byTopic) {
      const texts = new Set(group.map((claim) => normalizeClaimText(claim.claim)));
      const sources = new Set(group.map((claim) => claim.sourceId));
      // Same topic, different claims, from different sources: flag it.
      if (texts.size > 1 && sources.size > 1) {
        const claimIds = group.map((claim) => claim.id).sort();
        for (const claim of group) claim.contradicted = true;
        this.contradictions.set(key, { topic: group[0].topic, claimIds });
      }
    }
    return this.listContradictions();
  }

  persistContradictionFlags() {
    if (!this.db) return;
    const stmt = this.db.prepare('UPDATE research_claims SET contradicted=? WHERE id=?');
    for (const claim of this.claims.values()) stmt.run(claim.contradicted ? 1 : 0, claim.id);
  }

  listSources() {
    return [...this.sources.values()]
      .sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : 1))
      .map((record) => ({ ...record }));
  }

  listClaims() {
    return [...this.claims.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((record) => ({ ...record }));
  }

  listContradictions() {
    return [...this.contradictions.values()]
      .sort((a, b) => (a.topic < b.topic ? -1 : 1))
      .map((entry) => ({ topic: entry.topic, claimIds: [...entry.claimIds] }));
  }

  exportReport(taskId) {
    const cleanTaskId = assertText(taskId, { max: MAX_TASK_ID_LENGTH, name: 'taskId' });
    const sources = this.listSources();
    const claims = this.listClaims();
    const contradictions = this.listContradictions();
    const short = (id) => String(id).slice(0, 8);
    const lines = [
      `# Research report — ${cleanTaskId}`,
      `Exported: ${new Date().toISOString()}`,
      '',
      `## Sources (${sources.length})`,
    ];
    if (sources.length === 0) lines.push('None.');
    for (const source of sources) {
      lines.push(`- ${source.title} — ${source.url} (fetched ${source.fetchedAt})`);
    }
    lines.push('', `## Claims (${claims.length})`);
    if (claims.length === 0) lines.push('None.');
    for (const claim of claims) {
      const source = this.sources.get(claim.sourceId);
      const label = source ? `${source.title} (${short(source.id)})` : short(claim.sourceId);
      const flag = claim.contradicted ? ' [contradicted]' : '';
      lines.push(`- [${short(claim.id)}] (${claim.topic ?? 'no topic'})${flag} ${claim.claim} — source: ${label}`);
      if (claim.quote) lines.push(`  > ${claim.quote}`);
    }
    lines.push('', `## Contradictions (${contradictions.length})`);
    if (contradictions.length === 0) lines.push('None.');
    for (const entry of contradictions) {
      lines.push(`- Topic "${entry.topic}": claims ${entry.claimIds.map(short).join(', ')} disagree.`);
    }
    return {
      taskId: cleanTaskId,
      exportedAt: new Date().toISOString(),
      sources,
      claims,
      contradictions,
      markdown: lines.join('\n') + '\n',
    };
  }
}
