// Boots the screen pet: Friday's 2D portrait (pet-2d.js).
const attrib = document.getElementById('attrib');
const fail = (err) => {
  const fb = document.getElementById('fallback');
  if (fb) { fb.style.display = 'grid'; fb.textContent = `Pet failed to start: ${err?.message ?? err}`; }
};
document.body.classList.add('portrait');
if (attrib) attrib.textContent = 'Tap her for a heart. Her look comes from the portrait her owner picked.';
import('./pet-2d.js').then((m) => m.initPet2D()).catch(fail);
