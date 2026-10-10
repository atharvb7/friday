import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const CHROME = '/usr/bin/google-chrome';
const PORT = 43471;
const server = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'server.mjs');

test('UI smoke (real Chrome): every view renders without errors; emoji picker inserts at the caret; chat pins to bottom', { skip: !existsSync(CHROME) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-ui-'));
  const child = spawn(process.execPath, [server], { env: { ...process.env, FRIDAY_DATA_DIR: dir, FRIDAY_NO_DOTENV: '1', FRIDAY_PORT: String(PORT), FRIDAY_NVIDIA_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.addInitScript((t) => localStorage.setItem('friday.token', t), token);
    await page.goto(base + '/#chat');
    await page.waitForSelector('.composer textarea', { timeout: 8000 });
    for (const v of ['inbox', 'tasks', 'research', 'memory', 'reminders', 'settings', 'chat']) {
      await page.evaluate((x) => { location.hash = x; }, v);
      await page.waitForFunction((x) => document.querySelector(`.nav.active`)?.dataset.view === x && document.getElementById('main').innerText.length > 20, v, { timeout: 8000 });
    }
    // emoji picker
    const ta = page.locator('.composer textarea');
    await ta.fill('hi  there'); await ta.evaluate((el) => { el.selectionStart = el.selectionEnd = 3; });
    await page.locator('.emoji-wrap > button').click();
    await page.locator('.emoji-pop:not([hidden])').waitFor();
    await page.locator('.emoji-btn').first().click();
    const val = await ta.inputValue();
    assert.match(val, /^hi 😀 there$|^hi .\u{FE0F}? there$/u, `emoji inserted at caret, got ${JSON.stringify(val)}`);
    await page.locator('.emoji-pop input').fill('fire');
    assert.ok(await page.locator('.emoji-btn', { hasText: '🔥' }).count() >= 1, 'search finds 🔥');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.emoji-pop').isHidden(), true, 'Escape closes the picker');
    // auto-scroll: many messages -> pinned to bottom
    await page.evaluate(() => { const m = document.getElementById('msgs'); m.replaceChildren(); for (let i = 0; i < 60; i++) { const d = document.createElement('div'); d.className = 'msg'; d.textContent = `m${i} `.repeat(30); m.append(d); } });
    await page.waitForTimeout(200);
    const atBottom = await page.evaluate(() => { const m = document.getElementById('msgs'); return m.scrollHeight - m.scrollTop - m.clientHeight < 5; });
    assert.equal(atBottom, true, 'new content keeps the chat scrolled to the bottom');
    assert.deepEqual(errors, [], `no console/page errors: ${errors.join(' | ')}`);
  } finally { await browser?.close(); child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); }); rmSync(dir, { recursive: true, force: true }); }
});
