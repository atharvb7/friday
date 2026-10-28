// public/pet-2d.js — Friday's 2D pet: her portrait (/assets/friday.webp) animated on a canvas.
// It is one flat image, so motion is whole-figure (breathing, sway, a lean toward the pointer,
// hop, shake) plus a speech bubble by her face for her state (the heart is from her artwork).
// Drawing on a canvas keeps "Float on screen" (Picture-in-Picture via captureStream) working.
//
// STRUCTURE: pure helpers first (node-testable, no DOM); the browser part is initPet2D().
import { PET_STATES, poseFor, isCompactMode, lineFor } from './pet-shared.js';

export const PET_IMAGE = '/assets/friday.webp';
const SESSION_TOKEN_KEY = 'friday.token'; // where the web app keeps it (js/api.js): local when "remember me", else session
const PRESENCE_POLL_MS = 5000;
const FIG_ASPECT = 720 / 1158; // width / height of friday.webp
// Where her face is in the artwork (fractions of the figure), for the bubble.
const BUBBLE_ANCHOR = Object.freeze({ x: 0.03, y: 0.34, size: 0.17 });

/** The bubble by her face for a state, or null for none. */
export function bubbleFor(state) {
  switch (state) {
    case 'done': return { kind: 'heart' };
    case 'thinking': return { kind: 'dots' };
    case 'sleeping': case 'offline': return { kind: 'zzz' };
    case 'waiting': return { kind: 'text', text: '?' };
    case 'blocked': return { kind: 'text', text: '!' };
    case 'acting': return { kind: 'text', text: '♪' };
    default: return null; // listening: attentive, no bubble
  }
}

/**
 * Whole-figure motion at time t (seconds). Offsets are fractions of the figure height, rot in radians,
 * sy is the vertical breathing scale (anchored at her base).
 */
export function motionAt(state, t, { now = 0, hopUntil = 0, shakeUntil = 0, lookX = 0 } = {}) {
  const pose = poseFor(state);
  const sy = 1 + Math.sin(t * Math.PI * 2 * (pose.breathHz || 0.2)) * (pose.grey ? 0.002 : 0.006);
  let rot = pose.grey ? 0 : Math.sin(t * 0.45) * 0.012 + lookX * 0.02;
  let dx = 0;
  let dy = 0;
  if (state === 'sleeping') { rot += 0.025; dy += 0.01; }
  if (pose.nod) rot += Math.sin(t * 2.2) * 0.01;
  if (state === 'acting') dy -= Math.abs(Math.sin(t * 3)) * 0.008;
  if (pose.jump || now < hopUntil) dy -= Math.abs(Math.sin(t * 7)) * 0.025;
  if (pose.shake || now < shakeUntil) dx += Math.sin(t * 28) * 0.006;
  return { dx, dy, rot, sy, grey: Boolean(pose.grey) };
}

// ---------------------------------------------------------------------------
// Browser-only below.
// ---------------------------------------------------------------------------

function heartPath(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.35);
  ctx.bezierCurveTo(cx - s * 0.55, cy - s * 0.05, cx - s * 0.35, cy - s * 0.5, cx, cy - s * 0.2);
  ctx.bezierCurveTo(cx + s * 0.35, cy - s * 0.5, cx + s * 0.55, cy - s * 0.05, cx, cy + s * 0.35);
  ctx.closePath();
}

function drawBubble(ctx, b, x, y, size, t, pop) {
  if (!b || pop <= 0) return;
  const s = size * (0.6 + 0.4 * Math.min(1, pop)) ;
  const bob = Math.sin(t * 2) * size * 0.03;
  ctx.save();
  ctx.translate(x + size / 2, y + size / 2 + bob);
  ctx.globalAlpha = Math.min(1, pop);
  const r = s * 0.18;
  const w = s;
  const h = s * 0.92;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + r, -h / 2);
  ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
  ctx.lineTo(w / 2, h * 0.12);
  ctx.lineTo(w / 2 + s * 0.16, h * 0.2); // tail toward her face
  ctx.lineTo(w / 2, h * 0.3);
  ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
  ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
  ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = Math.max(2, s * 0.035);
  ctx.strokeStyle = '#ff6b9a';
  ctx.stroke();
  ctx.fillStyle = '#ff5c8a';
  if (b.kind === 'heart') {
    const beat = 1 + Math.max(0, Math.sin(t * 6)) * 0.08;
    heartPath(ctx, 0, s * 0.02, s * 0.62 * beat);
    ctx.fill();
  } else if (b.kind === 'dots') {
    for (let i = 0; i < 3; i++) {
      const up = Math.max(0, Math.sin(t * 5 - i * 0.8)) * s * 0.06;
      ctx.beginPath();
      ctx.arc((i - 1) * s * 0.24, -up, s * 0.075, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const text = b.kind === 'zzz' ? ['z', 'Z', 'z'][Math.floor(t * 1.2) % 3] : b.text;
    ctx.font = `700 ${Math.round(s * 0.55)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, s * 0.03);
  }
  ctx.restore();
}

export async function initPet2D(opts = {}) {
  const doc = opts.document ?? globalThis.document;
  const stage = doc.getElementById('stage2d');
  const badge = doc.getElementById('pet-state');
  const subtitle = doc.getElementById('subtitle');
  const fallback = doc.getElementById('fallback');
  const note = doc.getElementById('note');
  const compact = isCompactMode(globalThis.location?.search);
  if (compact) doc.body.classList.add('compact');

  const img = new Image();
  img.decoding = 'async';
  img.src = PET_IMAGE;
  try { await img.decode(); } catch {
    if (fallback) { fallback.style.display = 'grid'; fallback.textContent = `Friday's portrait failed to load (${PET_IMAGE}).`; }
    return { ok: false, reason: 'image' };
  }
  // Pre-render the figure once with a soft fade at the bottom (the artwork is a bust, cut flat).
  const fig = doc.createElement('canvas');
  fig.width = img.naturalWidth;
  fig.height = img.naturalHeight;
  {
    const g = fig.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createLinearGradient(0, 0, 0, fig.height);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.8, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, fig.width, fig.height);
  }

  const canvas = doc.createElement('canvas');
  stage.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let vw = 0;
  let vh = 0;
  function resize() {
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    vw = globalThis.innerWidth;
    vh = globalThis.innerHeight;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
  }
  resize();
  globalThis.addEventListener('resize', resize);

  let currentState = 'sleeping';
  let booted = false;
  let hopUntil = 0;
  let shakeUntil = 0;
  let talkUntil = 0;
  let bubble = bubbleFor(currentState);
  let bubbleAt = performance.now();
  let lookX = 0;
  let lookTarget = 0;
  let lastMove = 0;
  globalThis.addEventListener('pointermove', (ev) => {
    lookTarget = Math.max(-1, Math.min(1, (ev.clientX / vw) * 2 - 1));
    lastMove = performance.now();
  }, { passive: true });

  function showBubble(b) { bubble = b; bubbleAt = performance.now(); }

  function doTalk(text) {
    const line = text ?? lineFor(currentState);
    talkUntil = performance.now() + 2600 + line.length * 28;
    if (!subtitle) return;
    subtitle.style.display = 'block';
    subtitle.textContent = '';
    let i = 0;
    const timer = setInterval(() => {
      i += 2;
      subtitle.textContent = line.slice(0, i);
      if (i >= line.length) clearInterval(timer);
    }, 28);
    setTimeout(() => { if (performance.now() >= talkUntil) subtitle.style.display = 'none'; }, 2600 + line.length * 28 + 400);
  }

  function setState(s, why = '') {
    const changed = booted && s !== currentState;
    currentState = s;
    const pose = poseFor(s);
    if (badge) badge.textContent = `${pose.emoji} ${s}${why ? ` — ${why}` : ''}`;
    if (changed || !booted) showBubble(bubbleFor(s));
    if (changed && !why) {
      if (s === 'done') { hopUntil = performance.now() + 1500; doTalk(); }
      else if (s === 'blocked') { shakeUntil = performance.now() + 900; doTalk(); }
      else if (s === 'waiting' || s === 'acting' || s === 'offline') doTalk();
    }
    booted = true;
  }

  function doWave() {
    hopUntil = performance.now() + 1200;
    showBubble({ kind: 'heart' });
    doTalk('Hey hey~! Friday at your service. What are we doing today?');
  }

  // Tap her: a little hop and a heart.
  canvas.addEventListener('click', () => { hopUntil = performance.now() + 900; showBubble({ kind: 'heart' }); });

  const token = () => { try { return localStorage.getItem(SESSION_TOKEN_KEY) || sessionStorage.getItem(SESSION_TOKEN_KEY) || ''; } catch { return ''; } };
  async function pollPresence() {
    const t = token();
    if (!t) { setState('offline', 'no session token — connect via the main panel first'); return; }
    try {
      const res = await fetch('/v1/presence', { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' });
      if (!res.ok) throw new Error(`presence ${res.status}`);
      const data = await res.json();
      const pet = data?.presence?.pet;
      setState(PET_STATES.includes(pet) ? pet : 'sleeping');
    } catch {
      setState('offline', 'presence unreachable');
    }
  }

  function openCompact() {
    globalThis.open(`${globalThis.location.pathname}?compact=1`, 'friday-pet', 'width=360,height=520');
    if (note) {
      note.style.display = 'block';
      note.textContent = 'Compact window opened. GNOME Wayland cannot force always-on-top — right-click the title bar → “Always on Top”.';
    }
  }
  async function floatOnScreen() {
    try {
      const stream = canvas.captureStream(30);
      let video = doc.getElementById('pet-pip-video');
      if (!video) {
        video = doc.createElement('video');
        video.id = 'pet-pip-video';
        video.muted = true;
        video.playsInline = true;
        video.style.display = 'none';
        doc.body.appendChild(video);
      }
      video.srcObject = stream;
      await video.play();
      await video.requestPictureInPicture();
      doTalk('Floating now~ I will stay on your screen while you work.');
    } catch (err) {
      doTalk('Hmm, floating was blocked by the browser — I will stay in this tab instead.');
      if (note) { note.style.display = 'block'; note.textContent = `Float failed (${err?.message ?? err}). Use “Sit on screen” + Always on Top instead.`; }
    }
  }
  doc.getElementById('btn-wave')?.addEventListener('click', doWave);
  doc.getElementById('btn-talk')?.addEventListener('click', () => doTalk());
  doc.getElementById('btn-compact')?.addEventListener('click', openCompact);
  doc.getElementById('btn-float')?.addEventListener('click', floatOnScreen);

  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const t0 = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const t = reduceMotion ? 0 : (now - t0) / 1000;
    // Lean toward the pointer while it moves; drift back to centre when idle.
    const target = now - lastMove > 3000 ? 0 : lookTarget;
    lookX += (target - lookX) * 0.06;
    const m = motionAt(currentState, t, { now, hopUntil, shakeUntil, lookX });

    const bottomGap = compact ? 0 : 30;
    const H = Math.min(vh * (compact ? 0.94 : 0.88), (vw * 0.94) / FIG_ASPECT);
    const W = H * FIG_ASPECT;
    const baseX = vw / 2;
    const baseY = vh - bottomGap;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(baseX + m.dx * H, baseY + m.dy * H);
    ctx.rotate(m.rot);
    ctx.scale(1, m.sy);
    if (m.grey) ctx.filter = 'grayscale(1) brightness(0.75)';
    ctx.drawImage(fig, -W / 2, -H, W, H);
    ctx.restore();

    // Bubble beside her face, clamped on screen; pops in over 250 ms.
    const size = Math.max(36, W * BUBBLE_ANCHOR.size);
    const bx = Math.max(8, baseX - W / 2 + W * BUBBLE_ANCHOR.x + m.dx * H);
    const by = Math.max(8, baseY - H + H * BUBBLE_ANCHOR.y + m.dy * H);
    drawBubble(ctx, bubble, bx, by, size, t, (now - bubbleAt) / 250);
  }

  await pollPresence();
  setInterval(pollPresence, PRESENCE_POLL_MS);
  frame();
  return { ok: true, setState, doWave, doTalk };
}
