// test/research.test.mjs — coverage for the research pipeline:
// https-only URLs, length validation, no network fetch, contradiction
// detection, and report export.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ResearchStore } from '../src/research.mjs';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-research-'));
  const store = new Store(join(dir, 'research-test.sqlite'));
  return { dir, store, cleanup: () => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test('recordSource requires https and validates lengths', () => {
  const rs = new ResearchStore();
  assert.throws(() => rs.recordSource({ url: 'http://example.com/x', title: 'T' }), TypeError);
  assert.throws(() => rs.recordSource({ url: 'ftp://example.com/x', title: 'T' }), TypeError);
  assert.throws(() => rs.recordSource({ url: 'not a url', title: 'T' }), TypeError);
  assert.throws(() => rs.recordSource({ url: 'https://example.com/x', title: '' }), TypeError);
  assert.throws(() => rs.recordSource({ url: 'https://example.com/x', title: 't'.repeat(201) }), TypeError);
  assert.throws(() => rs.recordSource({ url: 'https://example.com/x', title: 'T', fetchedAt: 'not-a-date' }), TypeError);
  const ok = rs.recordSource({ url: 'https://example.com/x', title: 'Valid' });
  assert.ok(ok.id);
  assert.equal(ok.url, 'https://example.com/x');
  assert.ok(Date.parse(ok.fetchedAt));
});

test('recordSource performs no network fetch (unreachable https URL records fine)', () => {
  const rs = new ResearchStore();
  const record = rs.recordSource({ url: 'https://nonexistent.invalid/does-not-exist', title: 'Offline' });
  assert.equal(record.url, 'https://nonexistent.invalid/does-not-exist');
  assert.equal(rs.listSources().length, 1);
});

test('recordClaim validates input and requires a known source', () => {
  const rs = new ResearchStore();
  assert.throws(() => rs.recordClaim({ sourceId: 'missing', claim: 'c' }), /unknown source/);
  const source = rs.recordSource({ url: 'https://example.com/a', title: 'A' });
  assert.throws(() => rs.recordClaim({ sourceId: source.id, claim: '' }), TypeError);
  assert.throws(() => rs.recordClaim({ sourceId: source.id, claim: 'c'.repeat(2001) }), TypeError);
  assert.throws(() => rs.recordClaim({ sourceId: source.id, claim: 'ok', quote: 'q'.repeat(2001) }), TypeError);
  const claim = rs.recordClaim({ sourceId: source.id, claim: 'Sky is blue.', quote: 'the sky. is blue', topic: 'Sky color' });
  assert.equal(claim.contradicted, false);
  assert.equal(claim.topic, 'Sky color');
});

test('same topic with different claims from different sources is flagged', () => {
  const rs = new ResearchStore();
  const a = rs.recordSource({ url: 'https://example.com/a', title: 'A' });
  const b = rs.recordSource({ url: 'https://example.com/b', title: 'B' });
  const c1 = rs.recordClaim({ sourceId: a.id, claim: 'The city has 1M people.', topic: 'Population' });
  assert.equal(c1.contradicted, false);
  assert.deepEqual(rs.listContradictions(), []);
  const c2 = rs.recordClaim({ sourceId: b.id, claim: 'The city has 2M people.', topic: 'population' });
  assert.equal(c2.contradicted, true);
  const contradictions = rs.listContradictions();
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].topic, 'Population');
  assert.deepEqual([...contradictions[0].claimIds].sort(), [c1.id, c2.id].sort());
  assert.equal(rs.listClaims().find((c) => c.id === c1.id).contradicted, true);
});

test('same topic with agreeing claims is not a contradiction', () => {
  const rs = new ResearchStore();
  const a = rs.recordSource({ url: 'https://example.com/a', title: 'A' });
  const b = rs.recordSource({ url: 'https://example.com/b', title: 'B' });
  rs.recordClaim({ sourceId: a.id, claim: 'Water boils at 100C at sea level.', topic: 'Boiling point' });
  rs.recordClaim({ sourceId: b.id, claim: '  water BOILS at 100C   at sea level. ', topic: 'boiling POINT' });
  assert.deepEqual(rs.listContradictions(), []);
  assert.ok(rs.listClaims().every((c) => c.contradicted === false));
});

test('different topics never contradict, even with different claims', () => {
  const rs = new ResearchStore();
  const a = rs.recordSource({ url: 'https://example.com/a', title: 'A' });
  const b = rs.recordSource({ url: 'https://example.com/b', title: 'B' });
  rs.recordClaim({ sourceId: a.id, claim: 'Cats sleep a lot.', topic: 'Cats' });
  rs.recordClaim({ sourceId: b.id, claim: 'Dogs bark loudly.', topic: 'Dogs' });
  rs.recordClaim({ sourceId: a.id, claim: 'Untagged observation.' });
  assert.deepEqual(rs.listContradictions(), []);
});

test('exportReport returns sources, claims, contradictions and markdown', () => {
  const rs = new ResearchStore();
  const a = rs.recordSource({ url: 'https://example.com/a', title: 'Source A' });
  const b = rs.recordSource({ url: 'https://example.com/b', title: 'Source B' });
  rs.recordClaim({ sourceId: a.id, claim: 'X is true.', quote: 'x!', topic: 'X' });
  rs.recordClaim({ sourceId: b.id, claim: 'X is false.', topic: 'X' });
  const report = rs.exportReport('task-123');
  assert.equal(report.taskId, 'task-123');
  assert.equal(report.sources.length, 2);
  assert.equal(report.claims.length, 2);
  assert.equal(report.contradictions.length, 1);
  assert.match(report.markdown, /# Research report — task-123/);
  assert.match(report.markdown, /Source A/);
  assert.match(report.markdown, /X is true/);
  assert.match(report.markdown, /Contradictions \(1\)/);
  assert.throws(() => rs.exportReport(''), TypeError);
});

test('SQLite persistence is optional: rows survive a reload via Store', () => {
  const { store, cleanup } = makeStore();
  try {
    const rs = new ResearchStore({ store });
    const source = rs.recordSource({ url: 'https://example.com/a', title: 'A' });
    rs.recordClaim({ sourceId: source.id, claim: 'Persisted claim.', topic: 'T' });
    const reloaded = new ResearchStore({ store });
    assert.equal(reloaded.listSources().length, 1);
    assert.equal(reloaded.listClaims().length, 1);
    assert.equal(reloaded.listClaims()[0].claim, 'Persisted claim.');
  } finally {
    cleanup();
  }
});
