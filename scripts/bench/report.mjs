#!/usr/bin/env node
// Turn brain-bench result files into one markdown comparison: node scripts/bench/report.mjs a.json b.json ... > report.md
import { readFileSync } from 'node:fs';

const runs = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const cats = [...new Set(runs.flatMap((r) => r.summary.categories.map((c) => c.cat)))];
const ids = [...new Set(runs.flatMap((r) => r.rows.map((x) => x.id)))];
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));
const out = [];

out.push('| Setup | Score | ' + cats.join(' | ') + ' | Input tokens | Output tokens | LLM calls (failed) | Total time | Median per request |');
out.push('|---|---|' + cats.map(() => '---').join('|') + '|---|---|---|---|---|');
for (const { summary: s } of runs) {
  const pct = Math.round((100 * s.pass) / s.of);
  out.push(`| ${s.label} | **${s.pass}/${s.of}** (${pct}%) | ${cats.map((c) => { const x = s.categories.find((y) => y.cat === c); return x ? `${x.pass}/${x.of}` : '-'; }).join(' | ')} | ${k(s.inputTokens)} | ${k(s.outputTokens)} | ${s.llmCalls} (${s.failedCalls}) | ${s.totalSec}s | ${s.medianSec}s |`);
}

out.push('', '### Per test', '', '| Test | Category | ' + runs.map((r) => r.summary.label).join(' | ') + ' |', '|---|---|' + runs.map(() => '---').join('|') + '|');
for (const id of ids) {
  const cat = runs.flatMap((r) => r.rows).find((x) => x.id === id)?.cat;
  out.push(`| ${id} | ${cat} | ${runs.map((r) => { const x = r.rows.find((y) => y.id === id); return !x ? '-' : x.pass ? 'pass' : `FAIL: ${x.why.replace(/\|/g, '/').slice(0, 60)}`; }).join(' | ')} |`);
}
console.log(out.join('\n'));
