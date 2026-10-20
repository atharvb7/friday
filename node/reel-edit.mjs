// Runs ONE headless Claude Code session on the laptop to edit a reel with SynthCut (the ai-video-editor MCP server).
// Deliberately narrow: only folders under Downloads/friday-media, only the SynthCut MCP + read-only file tools,
// every other tool denied (no shell, no file writes, no web), one job at a time, hard time limit.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const TIME_LIMIT_MS = 40 * 60_000;
let running = false;

function claudeBin() {
  for (const p of [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude']) if (existsSync(p)) return p;
  return null;
}
function synthcutServer() {
  try { const c = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')); return c.mcpServers?.['ai-video-editor'] ?? null; } catch { return null; }
}

export async function reelEdit({ folder, brief = '', aspect = '9:16', seconds = null }, { downloadsRoot }) {
  if (running) throw new Error('another reel edit is already running');
  mkdirSync(join(downloadsRoot, 'friday-media'), { recursive: true });
  const root = realpathSync(join(downloadsRoot, 'friday-media'));
  const f = String(folder ?? '').replace(/^~(?=\/)/, homedir());
  let dir; try { dir = realpathSync(f.startsWith('/') ? f : join(root, f)); } catch { throw new Error('folder not found'); } // a bare name means Downloads/friday-media/<name>
  if (!dir.startsWith(root + sep) || !statSync(dir).isDirectory()) throw new Error('folder must be inside Downloads/friday-media');
  const bin = claudeBin(); if (!bin) throw new Error('Claude Code (claude) is not installed on this laptop');
  const mcp = synthcutServer(); if (!mcp) throw new Error('SynthCut (ai-video-editor) is not configured in Claude Code');
  if (!['9:16', '16:9', '1:1'].includes(aspect)) throw new Error('aspect must be 9:16, 16:9 or 1:1');
  const out = join(dir, 'final.mp4');
  const tmp = mkdtempSync(join(tmpdir(), 'friday-reel-'));
  const mcpFile = join(tmp, 'mcp.json'); writeFileSync(mcpFile, JSON.stringify({ mcpServers: { 'ai-video-editor': mcp } }), { mode: 0o600 });
  const prompt = `You are the video editor for a social media reel. Use the ai-video-editor (SynthCut) tools and the video-editor-pro skill.
Project folder: ${dir}
It contains AI-generated clips (Gemini images + ~8 s Veo videos). Make one polished ${aspect} reel${seconds ? ` of about ${Number(seconds)} s` : ''}:
- import all the videos (use the images only if a video is missing), order them to tell the story, cut a strong hook into the first 2 seconds, trim dead frames, vary pacing, smooth transitions, one tasteful colour grade, captions/text only if they help, land the ending deliberately;
- keep audio levels sensible (use the clips' own sound; add music only if SynthCut provides it);
- export the final video to exactly: ${out}
Brief from the owner: ${String(brief).slice(0, 1500) || '(none — use your editorial judgement)'}
Rules: only edit inside this folder; do not delete or overwrite the source clips; when done, reply with a short summary (length, structure, what you did).`;
  running = true;
  try {
    const result = await new Promise((resolve, reject) => {
      const p = spawn(bin, ['-p', prompt, '--output-format', 'json', '--strict-mcp-config', '--mcp-config', mcpFile,
        '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__ai-video-editor', 'Read', 'Glob', 'Grep', 'LS', 'Skill',
        '--disallowedTools', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'],
      { cwd: dir, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; if (so.length > 4_000_000) so = so.slice(-1_000_000); });
      p.stderr.on('data', (d) => { se += d; if (se.length > 200_000) se = se.slice(-50_000); });
      const t = setTimeout(() => { p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 5000); }, TIME_LIMIT_MS);
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => {
        clearTimeout(t);
        let j = null; try { j = JSON.parse(so.trim().split('\n').pop()); } catch { /* not json */ }
        resolve({ code, summary: String(j?.result ?? so).slice(-3000), isError: j?.is_error === true || code !== 0, stderr: se.slice(-1500), cost: j?.total_cost_usd ?? null, turns: j?.num_turns ?? null });
      });
    });
    if (/authenticate|OAuth|not logged in|login/i.test(`${result.summary} ${result.stderr}`) && !existsSync(out)) return { done: false, path: null, size: 0, summary: '', error: 'Claude Code on the laptop is signed out — open a terminal, run `claude`, type /login and sign in once; then ask me to edit the reel again.' };
    const done = existsSync(out) && statSync(out).size > 10_000;
    return { done, path: done ? out : null, size: done ? statSync(out).size : 0, summary: result.summary, error: done ? null : (result.isError ? `editor stopped: ${result.stderr || result.summary}`.slice(0, 800) : 'no final.mp4 was exported'), turns: result.turns };
  } finally { running = false; rmSync(tmp, { recursive: true, force: true }); }
}
