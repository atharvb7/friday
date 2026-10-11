import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const CHROME = '/usr/bin/google-chrome';
const util = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', 'util.js'), 'utf8');

test('markdown: command output keeps its columns, pipe tables with/without outer pipes become tables', { skip: !existsSync(CHROME) }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id=o></div>');
    await page.addScriptTag({ type: 'module', content: `${util}\nwindow.__md = md;` });
    await page.waitForFunction(() => typeof window.__md === 'function');
    const out = await page.evaluate(() => {
      const r = (s) => { const el = window.__md(s); return { pre: [...el.querySelectorAll('pre')].map((p) => p.textContent), tables: [...el.querySelectorAll('table')].map((t) => t.querySelectorAll('tr').length), text: el.textContent }; };
      return {
        df: r('Disk usage:\n\nFilesystem                Size  Used  Avail  Use%\nRoot overlay filesystem    98G   52G   42G    56%\n/opt/data                  98G   52G   42G    56%\n\nThat is fine.'),
        gfm: r('| Dir | Size |\n|---|---|\n| /opt | 2.4G |\n| /usr | 1.5G |'),
        bare: r('Dir | Size\n--- | ---\n/opt | 2.4G'),
        prose: r('Hello there  friend.\nJust text.'),
      };
    });
    assert.equal(out.df.pre.length, 1); assert.match(out.df.pre[0], /Filesystem {16}Size/); assert.match(out.df.text, /That is fine/);
    assert.deepEqual(out.gfm.tables, [3]);
    assert.deepEqual(out.bare.tables, [2]);
    assert.equal(out.prose.pre.length, 0, 'one stray double space is not a column block');
  } finally { await browser.close(); }
});
