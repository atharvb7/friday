// Picks the pet renderer: Friday's 2D portrait by default, the old 3D model with ?mode=3d.
const params = new URLSearchParams(globalThis.location.search);
const mode = params.get('mode') === '3d' ? '3d' : '2d';
const other = new URLSearchParams(params);
if (mode === '3d') other.delete('mode'); else other.set('mode', '3d');
const link = document.getElementById('btn-mode');
if (link) {
  link.href = `${globalThis.location.pathname}${other.toString() ? `?${other}` : ''}`;
  link.textContent = mode === '3d' ? 'Friday (2D)' : '3D model';
}
const attrib = document.getElementById('attrib');
const fail = (err) => {
  const fb = document.getElementById('fallback');
  if (fb) { fb.style.display = 'grid'; fb.textContent = `Pet failed to start: ${err?.message ?? err}`; }
};
if (mode === '3d') {
  const stage = document.createElement('div');
  stage.id = 'stage';
  stage.setAttribute('aria-label', 'Friday 3D pet stage');
  document.body.prepend(stage);
  import('./pet-viewer.js').catch(fail); // auto-boots on #stage
} else {
  document.body.classList.add('portrait');
  if (attrib) attrib.textContent = 'Tap her for a heart. Her look comes from the portrait her owner picked.';
  import('./pet-2d.js').then((m) => m.initPet2D()).catch(fail);
}
