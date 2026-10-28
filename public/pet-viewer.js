// public/pet-viewer.js — Friday screen-pet viewer.
// Pet model: megaman_x_divemmdortwinkle_girl.glb — CC-BY-4.0 by lucianone.
// glTF2, ~0.7MB, 80 nodes, 1 skin, ZERO animations, ZERO morph targets.
// Bones of interest: Bip L/R UpperArm/Forearm/Hand + fingers, Bip Head_031,
// Bone Eyelid_L/R, Bip Spine. No jaw/mouth bones exist, so "talk" mode is
// honestly head-bob (8 Hz small) + a subtitle line — NOT lip sync.
//
// STRUCTURE: pure logic (poseFor / blink timing / compact parsing) is at the
// top with ZERO browser/THREE dependencies so node tests can import it.
// All THREE/WebGL/DOM work lives behind `initPetViewer()` and dynamic
// relative imports (`./vendor/three.module.js`, no import map, no CDN),
// so importing this module in node never touches WebGL or the network.

export const PET_STATES = Object.freeze([
  'sleeping', 'listening', 'thinking', 'acting',
  'waiting', 'blocked', 'offline', 'done',
]);

export const BLINK_MIN_MS = 2000;
export const BLINK_MAX_MS = 5000;

/** Randomised blink gap in [BLINK_MIN_MS, BLINK_MAX_MS]. Pure + injectable. */
export function nextBlinkDelay(rand = Math.random) {
  const r = typeof rand === 'function' ? rand() : Math.random();
  const clamped = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  return Math.round(BLINK_MIN_MS + clamped * (BLINK_MAX_MS - BLINK_MIN_MS));
}

/** True when the URL search string requests compact "sit on screen" mode. */
export function isCompactMode(search = '') {
  const s = String(search ?? '');
  return /(?:\?|&)compact=1(?:&|$)/.test(s);
}

// What she says per state (shared by the 3D viewer and the 2D portrait pet).
export const PET_LINES = Object.freeze({
  sleeping: ['Zzz… tap Wave to wake me up.', 'Resting… I am still watching your tasks.'],
  listening: ['Mm-hm, I am listening…', 'Go on, tell me everything.'],
  thinking: ['Hmm… let me think this through properly.', 'Give me a second, cutie… I mean, boss.'],
  acting: ['On it! Watch me work.', 'Doing the thing right now~'],
  waiting: ['I need your okay before I touch that — check the approval card?', 'This one is consequential… your call, boss.'],
  blocked: ['Stuck. Something needs you — I paused instead of guessing.', 'I hit a wall and stopped safely. Tell me how to proceed?'],
  offline: ['I lost the laptop link… still here, just sleepy.', 'Connection gone — I will wait right here.'],
  done: ['Done~! Check the receipt, all verified.', 'Finished! Was I good? …Don’t answer that.'],
});
export function lineFor(state, rand = Math.random) {
  const arr = PET_LINES[state] ?? PET_LINES.sleeping;
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

/**
 * Pure state -> pose map. No THREE, no DOM, no fetch.
 * Returns a frozen descriptor the animator interprets each frame.
 * Fields: emoji, label, breathHz, breathAmp, head{pitch,roll,yaw},
 * lean (forward +z tilt rad), wave, nod, shake, jump, grey, note.
 */
export function poseFor(state) {
  const s = String(state ?? '');
  switch (s) {
    case 'sleeping':
      return Object.freeze({ state: s, emoji: '😴', label: 'Sleeping',
        breathHz: 0.15, breathAmp: 0.02, head: Object.freeze({ pitch: 0.35, roll: 0, yaw: 0 }),
        lean: 0.12, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: 'sit pose, slow breath' });
    case 'listening':
      return Object.freeze({ state: s, emoji: '👂', label: 'Listening',
        breathHz: 0.25, breathAmp: 0.015, head: Object.freeze({ pitch: 0.1, roll: -0.15, yaw: -0.3 }),
        lean: 0.22, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: 'lean forward, head turned (hand-to-ear-ish; no IK)' });
    case 'thinking':
      return Object.freeze({ state: s, emoji: '💭', label: 'Thinking',
        breathHz: 0.2, breathAmp: 0.012, head: Object.freeze({ pitch: 0.05, roll: 0.3, yaw: 0.1 }),
        lean: 0.05, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: 'head tilt' });
    case 'acting':
      return Object.freeze({ state: s, emoji: '🐾', label: 'Acting',
        breathHz: 0.3, breathAmp: 0.02, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0.08, wave: true, nod: false, shake: false, jump: false, grey: false,
        note: 'wave (R UpperArm_035 z + Forearm_036 x, 2s sine)' });
    case 'waiting':
      return Object.freeze({ state: s, emoji: '⏳', label: 'Waiting for approval',
        breathHz: 0.22, breathAmp: 0.012, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0.1, wave: false, nod: true, shake: false, jump: false, grey: false,
        note: 'slow nod (Head_031 x)' });
    case 'blocked':
      return Object.freeze({ state: s, emoji: '⛔', label: 'Stopped',
        breathHz: 0.18, breathAmp: 0.01, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0, wave: false, nod: false, shake: true, jump: false, grey: false,
        note: 'head shake (Head_031 yaw sine)' });
    case 'offline':
      return Object.freeze({ state: s, emoji: '📴', label: 'Offline',
        breathHz: 0.1, breathAmp: 0.005, head: Object.freeze({ pitch: 0.3, roll: 0, yaw: 0 }),
        lean: 0, wave: false, nod: false, shake: false, jump: false, grey: true,
        note: 'grey out (frozen, desaturated)' });
    case 'done':
      return Object.freeze({ state: s, emoji: '✅', label: 'Done',
        breathHz: 0.3, breathAmp: 0.02, head: Object.freeze({ pitch: -0.1, roll: 0, yaw: 0 }),
        lean: -0.05, wave: true, nod: false, shake: false, jump: true, grey: false,
        note: 'jump (root y hop) + wave' });
    default:
      return Object.freeze({ state: 'unknown', emoji: '❓', label: 'Unknown',
        breathHz: 0.2, breathAmp: 0.012, head: Object.freeze({ pitch: 0, roll: 0, yaw: 0 }),
        lean: 0, wave: false, nod: false, shake: false, jump: false, grey: false,
        note: `unmapped state "${s}" -> idle` });
  }
}

// ---------------------------------------------------------------------------
// Browser-only viewer below. Never runs on import in node (no top-level DOM).
// ---------------------------------------------------------------------------

const SESSION_TOKEN_KEY = 'friday.token'; // where the web app keeps it (js/api.js): local when "remember me", else session
const PRESENCE_POLL_MS = 5000;
const MODEL_URL = '/pet.glb';

function findBone(root, ...needles) {
  let found = null;
  root.traverse((o) => {
    if (found) return;
    const n = o.name || '';
    if (needles.every((s) => n.includes(s))) found = o;
  });
  return found;
}

export async function initPetViewer(opts = {}) {
  const doc = opts.document ?? globalThis.document;
  if (!doc) throw new Error('initPetViewer requires a DOM');
  const stage = doc.getElementById('stage');
  const badge = doc.getElementById('pet-state');
  const subtitle = doc.getElementById('subtitle');
  const fallback = doc.getElementById('fallback');
  const note = doc.getElementById('note');

  if (isCompactMode(globalThis.location?.search)) {
    doc.body.classList.add('compact');
    if (note) {
      note.style.display = 'block';
      note.textContent =
        'Compact mode: keep this window on top manually — GNOME Wayland does not let pages force always-on-top.';
    }
  }

  let THREE;
  let GLTFLoader;
  try {
    // Relative paths only — no import map, no bare specifiers, no CDN.
    // (Vendored three r160: GLTFLoader's `from 'three'` was patched to a
    // relative path; see vendor note at the top of that file.)
    THREE = await import('./vendor/three.module.js');
    ({ GLTFLoader } = await import('./vendor/loaders/GLTFLoader.js'));
  } catch {
    if (fallback) {
      fallback.style.display = 'grid';
      fallback.textContent =
        '3D unavailable: local Three.js (/vendor/three.module.js) could not be loaded. Make sure the Friday server is running (it serves /vendor/*) and reload — no internet needed.';
    }
    return { ok: false, reason: 'three-local-missing' };
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, globalThis.innerWidth / globalThis.innerHeight, 0.1, 100);
  camera.position.set(0, 1.4, 3.2);
  scene.add(new THREE.HemisphereLight(0xfff2f5, 0x223322, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(2, 4, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffc4d6, 0.55);
  rim.position.set(-3, 2, -2);
  scene.add(rim);
  // Soft ground shadow (canvas blob — no assets, no lighting rig needed).
  const shadowTex = (() => {
    const cv = doc.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.42)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tx = new THREE.CanvasTexture(cv);
    return tx;
  })();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  scene.add(shadow);

  const rig = new THREE.Group();
  scene.add(rig);

  let model = null;
  const bones = {};
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL);
    model = gltf.scene;
    rig.add(model);
    // Substring bone lookup — resilient to numeric suffixes (e.g. _035).
    bones.pelvis = findBone(model, 'Pelvis');
    bones.spine = findBone(model, 'Spine_09') ?? findBone(model, 'Spine');
    bones.spine1 = findBone(model, 'Spine1');
    bones.neck = findBone(model, 'Neck');
    bones.head = findBone(model, 'Head_031') ?? findBone(model, 'Head');
    bones.eyelidL = findBone(model, 'Eyelid_L') ?? findBone(model, 'Eyelid', 'L');
    bones.eyelidR = findBone(model, 'Eyelid_R') ?? findBone(model, 'Eyelid', 'R');
    bones.clavL = findBone(model, 'Clavicle', 'L');
    bones.clavR = findBone(model, 'Clavicle', 'R');
    bones.upperArmR = findBone(model, 'UpperArm', 'R') ?? findBone(model, 'UpperArm');
    bones.forearmR = findBone(model, 'Forearm', 'R') ?? findBone(model, 'Forearm');
    bones.upperArmL = findBone(model, 'UpperArm', 'L');
    bones.forearmL = findBone(model, 'Forearm', 'L');
    // Future-proof: if a later GLB ships animation clips, play them.
    // This file has none, so the mixer stays idle and procedural motion rules.
    let mixer = null;
    try {
      if (gltf.animations && gltf.animations.length) {
        mixer = new THREE.AnimationMixer(model);
        const idle = gltf.animations[0];
        mixer.clipAction(idle).play();
      }
    } catch { mixer = null; }
    bones.mixer = mixer;
    // Centre model at origin with feet on y=0, then frame the camera to it.
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(c);
    model.position.y -= (box.min.y - c.y); // feet -> y=0
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = maxDim * 2.2;
    camera.position.set(0, maxDim * 0.75, dist);
    camera.lookAt(0, maxDim * 0.45, 0);
  } catch (err) {
    if (fallback) {
      fallback.style.display = 'grid';
      fallback.textContent = `Pet model failed to load (${MODEL_URL}): ${err?.message ?? err}. The server must map /pet.glb to the .glb file (static-map wiring is manual).`;
    }
  }

  let currentState = 'sleeping';
  let waveUntil = 0;
  let talkUntil = 0;
  let greetUntil = 0;
  let happyUntil = 0;
  let sadUntil = 0;
  let nextBlinkAt = performance.now() + nextBlinkDelay();
  let blinkUntil = 0;
  // Gaze: pointer tracked in [-1,1]; head + eyelids follow softly, with drift
  // saccades when the pointer is idle so she looks alive, not locked.
  const gaze = { x: 0, y: 0, tx: 0, ty: 0, lastMove: performance.now(), sx: 0, sy: 0, nextSaccade: performance.now() + 2500 };
  globalThis.addEventListener('pointermove', (ev) => {
    gaze.tx = Math.max(-1, Math.min(1, (ev.clientX / globalThis.innerWidth) * 2 - 1));
    gaze.ty = Math.max(-1, Math.min(1, (ev.clientY / globalThis.innerHeight) * 2 - 1));
    gaze.lastMove = performance.now();
  }, { passive: true });

  const token = () => {
    try { return localStorage.getItem(SESSION_TOKEN_KEY) || sessionStorage.getItem(SESSION_TOKEN_KEY) || ''; } catch { return ''; }
  };

  async function pollPresence() {
    const t = token();
    if (!t) {
      setState('offline', 'no session token — connect via the main panel first');
      return;
    }
    try {
      const res = await fetch('/v1/presence', {
        headers: { Authorization: `Bearer ${t}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`presence ${res.status}`);
      const data = await res.json();
      const pet = data?.presence?.pet;
      setState(PET_STATES.includes(pet) ? pet : 'sleeping');
    } catch {
      setState('offline', 'presence unreachable');
    }
  }

  let booted = false;
  function setState(s, why = '') {
    const changed = booted && s !== currentState;
    currentState = s;
    const pose = poseFor(s);
    if (badge) badge.textContent = `${pose.emoji} ${s}${why ? ` — ${why}` : ''}`;
    if (renderer?.domElement) {
      // Offline grey-out: honest cheap approach (CSS filter, no shader work).
      renderer.domElement.style.filter = pose.grey ? 'grayscale(1) brightness(0.7)' : '';
    }
    // She reacts out loud when Friday's real state changes (not on boot).
    if (changed && !why) {
      if (s === 'done') { happyUntil = performance.now() + 2500; doTalk(); }
      else if (s === 'blocked') { sadUntil = performance.now() + 4000; doTalk(); }
      else if (s === 'waiting' || s === 'acting' || s === 'offline') doTalk();
    }
    booted = true;
  }

  function doWave() {
    waveUntil = performance.now() + 2200;
    greetUntil = performance.now() + 2200;
    doTalk('Hey hey~! Friday at your service. What are we doing today?');
    if (currentState !== 'acting') setState('acting');
  }
  function doTalk(text) {
    const line = text ?? lineFor(currentState);
    talkUntil = performance.now() + 2600 + line.length * 28;
    if (subtitle) {
      subtitle.style.display = 'block';
      subtitle.textContent = '';
      // Typewriter: she "speaks" the line out while her head bobs.
      let i = 0;
      const timer = setInterval(() => {
        i += 2;
        subtitle.textContent = line.slice(0, i);
        if (i >= line.length) clearInterval(timer);
      }, 28);
      setTimeout(() => { if (subtitle && performance.now() >= talkUntil) subtitle.style.display = 'none'; }, 2600 + line.length * 28 + 400);
    }
  }
  function openCompact() {
    globalThis.open(`${globalThis.location.pathname}?compact=1&mode=3d`, 'friday-pet', 'width=360,height=480');
    if (note) {
      note.style.display = 'block';
      note.textContent =
        'Compact window opened (360×480). GNOME Wayland cannot force always-on-top — right-click the title bar → “Always on Top” (or use your compositor shortcut) to keep it visible.';
    }
  }
  async function floatOnScreen() {
    // True floating companion: pipe the live 3D canvas into a Picture-in-
    // Picture window, which the compositor keeps above other windows natively.
    // No Wayland hacks — just a video element carrying our render stream.
    try {
      const stream = renderer.domElement.captureStream(30);
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
      if (note) {
        note.style.display = 'block';
        note.textContent = 'Floating above your windows. Close the PiP window to dock me back here.';
      }
    } catch (err) {
      doTalk('Hmm, floating was blocked by the browser — I will stay in this tab instead.');
      if (note) {
        note.style.display = 'block';
        note.textContent = `Float failed (${err?.message ?? err}). Use “Sit on screen” + Always on Top instead.`;
      }
    }
  }

  doc.getElementById('btn-wave')?.addEventListener('click', doWave);
  doc.getElementById('btn-talk')?.addEventListener('click', () => doTalk());
  doc.getElementById('btn-compact')?.addEventListener('click', openCompact);
  doc.getElementById('btn-float')?.addEventListener('click', floatOnScreen);

  globalThis.addEventListener('resize', () => {
    camera.aspect = globalThis.innerWidth / globalThis.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
  });

  const clock = new THREE.Clock();
  const basePos = {};
  function snapshot(o) { if (o && !(o.name in basePos)) basePos[o.name] = { p: o.position.clone(), r: o.rotation.clone(), s: o.scale.clone() }; }

  // Ease helper: critically-damped-ish smoothing so nothing snaps robotically.
  const ease = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
  let lastT = 0;

  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    const dt = Math.min(0.05, Math.max(0.001, t - lastT));
    lastT = t;
    const now = performance.now();
    const pose = poseFor(currentState);
    const waving = now < waveUntil || pose.wave;
    const talking = now < talkUntil;
    const greeting = now < greetUntil;
    const sad = currentState === 'blocked' || now < sadUntil;

    if (bones.mixer) { try { bones.mixer.update(dt); } catch {} }

    // Gaze: ease toward pointer; idle >3s → soft saccade drift.
    if (now - gaze.lastMove > 3000 && now >= gaze.nextSaccade) {
      gaze.sx = (Math.random() - 0.5) * 0.7;
      gaze.sy = (Math.random() - 0.5) * 0.4;
      gaze.nextSaccade = now + 1800 + Math.random() * 2500;
    }
    const lookX = (now - gaze.lastMove > 3000 ? gaze.sx : gaze.tx);
    const lookY = (now - gaze.lastMove > 3000 ? gaze.sy : gaze.ty);
    gaze.x = ease(gaze.x, lookX, 4, dt);
    gaze.y = ease(gaze.y, lookY, 4, dt);

    // Hips: slow feminine weight-shift side to side; spine counter-sways.
    if (bones.pelvis) {
      snapshot(bones.pelvis);
      const b = basePos[bones.pelvis.name];
      const sway = Math.sin(t * 0.55) * 0.045;
      bones.pelvis.rotation.z = b.r.z + sway;
      bones.pelvis.position.x = b.p.x + Math.sin(t * 0.55) * 0.012;
    }
    if (bones.spine) {
      snapshot(bones.spine);
      const b = basePos[bones.spine.name];
      const br = Math.sin(t * Math.PI * 2 * pose.breathHz);
      bones.spine.scale.y = b.s.y * (1 + pose.breathAmp * br);
      bones.spine.position.y = b.p.y + pose.breathAmp * 0.4 * br;
      bones.spine.rotation.x = b.r.x + pose.lean + (currentState === 'sleeping' ? 0.08 : 0) + (sad ? 0.12 : 0);
      bones.spine.rotation.z = b.r.z - Math.sin(t * 0.55) * 0.03;
    }
    if (bones.spine1) {
      snapshot(bones.spine1);
      const b = basePos[bones.spine1.name];
      bones.spine1.rotation.z = b.r.z - Math.sin(t * 0.55 + 0.5) * 0.035;
    }
    if (bones.neck) {
      snapshot(bones.neck);
      const b = basePos[bones.neck.name];
      bones.neck.rotation.y = ease(bones.neck.rotation.y, b.r.y + gaze.x * 0.12, 5, dt);
    }
    if (bones.head) {
      snapshot(bones.head);
      const b = basePos[bones.head.name];
      let { pitch, roll, yaw } = pose.head;
      if (pose.nod) pitch += (Math.sin(t * 2.2) * 0.5 + 0.5) * 0.22;          // waiting: soft nod
      if (pose.shake) yaw += Math.sin(t * 5.0) * 0.22;                        // blocked: gentle shake
      if (talking) pitch += Math.abs(Math.sin(t * Math.PI * 2 * 3.2)) * 0.06; // talk: syllable bob
      if (greeting) roll += Math.sin(t * 5.0) * 0.08;                         // greet: playful tilt
      if (sad) pitch += 0.18;                                                 // sad: chin down
      // She looks at you: eased gaze layered under pose.
      yaw += gaze.x * 0.28;
      pitch += gaze.y * -0.14;
      const cur = bones.head.rotation;
      bones.head.rotation.set(
        ease(cur.x, b.r.x + pitch, 6, dt),
        ease(cur.y, b.r.y + yaw, 6, dt),
        ease(cur.z, b.r.z + roll, 6, dt),
      );
    }
    // Blink + saccade micro-motion on the lids.
    if (now >= nextBlinkAt) {
      blinkUntil = now + 150;
      nextBlinkAt = now + nextBlinkDelay();
      if (Math.random() < 0.12) nextBlinkAt = now + 350; // occasional double-blink
    }
    const blinking = now < blinkUntil;
    for (const k of ['eyelidL', 'eyelidR']) {
      const e = bones[k];
      if (!e) continue;
      snapshot(e);
      e.rotation.x = basePos[e.name].r.x + (blinking ? 0.55 : 0) + gaze.y * 0.05;
    }
    // Arms: resting micro-sway; greeting raises the right arm into a wave,
    // done/happy lifts both; sad lets them droop.
    const armSway = Math.sin(t * 0.9) * 0.03;
    if (bones.upperArmR) {
      snapshot(bones.upperArmR);
      const b = basePos[bones.upperArmR.name];
      if (waving) {
        const wt = (waveUntil - now) / 1000;
        const phase = Number.isFinite(wt) && wt > 0 ? (2.2 - wt) * Math.PI * 2 : t * Math.PI * 2;
        bones.upperArmR.rotation.z = ease(bones.upperArmR.rotation.z, b.r.z + 1.05 + Math.sin(phase * 2) * 0.3, 8, dt);
        if (bones.forearmR) {
          snapshot(bones.forearmR);
          const f = basePos[bones.forearmR.name];
          bones.forearmR.rotation.x = f.r.x + Math.sin(phase * 2 + 0.6) * 0.45;
        }
      } else {
        bones.upperArmR.rotation.z = ease(bones.upperArmR.rotation.z, b.r.z + (sad ? -0.06 : 0.02) + armSway, 4, dt);
      }
    }
    if (bones.upperArmL) {
      snapshot(bones.upperArmL);
      const b = basePos[bones.upperArmL.name];
      const lift = pose.jump ? 0.7 : 0;
      bones.upperArmL.rotation.z = ease(bones.upperArmL.rotation.z, b.r.z - lift + (sad ? 0.06 : -0.02) - armSway, 4, dt);
    }
    if (bones.clavR) {
      snapshot(bones.clavR);
      const b = basePos[bones.clavR.name];
      bones.clavR.rotation.z = b.r.z + (waving ? 0.12 : Math.sin(t * 0.9 + 0.4) * 0.02);
    }
    if (bones.clavL) {
      snapshot(bones.clavL);
      const b = basePos[bones.clavL.name];
      bones.clavL.rotation.z = b.r.z - (pose.jump ? 0.1 : Math.sin(t * 0.9) * 0.02);
    }
    if (pose.jump) rig.position.y = Math.abs(Math.sin(t * 4.5)) * 0.12;       // done: happy hop
    else if (currentState === 'sleeping') rig.position.y = -0.02 + Math.sin(t * 0.9) * 0.006;
    else rig.position.y = 0;
    if (!pose.grey) rig.rotation.y = Math.sin(t * 0.25) * 0.09;              // slow showcase turn
    // Shadow follows the hop.
    const shScale = 1 - rig.position.y * 1.2;
    shadow.scale.set(shScale, shScale, 1);

    renderer.render(scene, camera);
  }

  await pollPresence();
  setInterval(pollPresence, PRESENCE_POLL_MS);
  animate();
  return { ok: true, setState, doWave, doTalk };
}

// Auto-boot only in a real browser document — never under node tests.
if (typeof document !== 'undefined' && document.getElementById?.('stage')) {
  initPetViewer().catch((err) => {
    const fb = document.getElementById('fallback');
    if (fb) { fb.style.display = 'grid'; fb.textContent = `Pet viewer failed to start: ${err?.message ?? err}`; }
  });
}
