// Small dependency-free emoji picker (category tabs, search by name, recents). Inserts at the cursor.
import { h, clear } from './util.js';

const CATS = {
  '😀': ['😀 grin', '😁 beam', '😂 joy lol', '🤣 rofl', '😊 smile', '😍 love eyes', '🥰 hearts', '😘 kiss', '😉 wink', '😏 smirk', '😎 cool', '🤩 starstruck', '🥳 party', '😜 tongue', '🤪 zany', '😋 yum', '🤔 think', '🙄 eyeroll', '😴 sleepy', '🥺 pleading', '😭 cry', '😢 sad', '😤 huff', '😡 angry', '🤯 mindblown', '😱 scream', '😅 sweat', '🫠 melt', '😇 angel', '😈 devil', '🤭 oops', '🫣 peek', '🥹 touched', '🤗 hug', '😬 grimace', '😳 flushed'],
  '👍': ['👍 thumbs up', '👎 thumbs down', '👏 clap', '🙌 raised hands', '🙏 pray thanks', '🤝 handshake', '💪 strong', '👀 eyes', '🫶 heart hands', '✌️ peace', '🤞 fingers crossed', '👋 wave', '🤟 love you', '🫡 salute', '🤌 chef kiss', '👌 ok'],
  '❤️': ['❤️ heart', '🧡 orange heart', '💛 yellow heart', '💚 green heart', '💙 blue heart', '💜 purple heart', '🖤 black heart', '🤍 white heart', '💖 sparkle heart', '💕 two hearts', '💞 revolving', '💘 arrow heart', '💔 broken heart', '🔥 fire', '✨ sparkles', '⭐ star', '💯 hundred', '💥 boom', '💫 dizzy', '🌈 rainbow'],
  '🍕': ['🍕 pizza', '🍔 burger', '🍟 fries', '🌮 taco', '🍜 noodles', '🍣 sushi', '🍩 donut', '🍪 cookie', '🍫 chocolate', '🍰 cake', '🍦 ice cream', '☕ coffee', '🧋 bubble tea', '🍺 beer', '🥂 cheers', '🍿 popcorn', '🍎 apple', '🍓 strawberry', '🥑 avocado', '🍳 egg'],
  '🐶': ['🐶 dog', '🐱 cat', '🦊 fox', '🐼 panda', '🐨 koala', '🦄 unicorn', '🐙 octopus', '🦋 butterfly', '🌸 blossom', '🌹 rose', '🌞 sun', '🌙 moon', '⚡ lightning', '❄️ snow', '🌊 wave', '🌍 earth', '🚀 rocket', '🎮 game', '🎧 headphones', '🎵 music', '📚 books', '💻 laptop', '📱 phone', '🎉 tada', '🎂 birthday', '🎁 gift', '🏆 trophy', '✅ check', '❌ cross', '⚠️ warning'],
};
const KEY = 'friday.emoji.recent';
const recents = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const remember = (e) => { try { localStorage.setItem(KEY, JSON.stringify([e, ...recents().filter((x) => x !== e)].slice(0, 16))); } catch { /* ignore */ } };

export function emojiPicker({ onPick, anchorLabel = 'Emoji' }) {
  let open = false, cat = Object.keys(CATS)[0];
  const search = h('input', { type: 'search', placeholder: 'Search emoji…', 'aria-label': 'Search emoji' });
  const tabs = h('div', { class: 'emoji-tabs', role: 'tablist' });
  const grid = h('div', { class: 'emoji-grid', role: 'listbox', 'aria-label': 'Emoji' });
  const pop = h('div', { class: 'emoji-pop', hidden: true, role: 'dialog', 'aria-label': 'Emoji picker' }, search, tabs, grid);
  const btn = h('button', { class: 'btn icon quiet', type: 'button', title: 'Emoji', 'aria-label': anchorLabel, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: toggle }, '😊');
  const wrap = h('div', { class: 'emoji-wrap' }, btn, pop);

  const pick = (e) => { onPick(e); remember(e); };
  function paint() {
    clear(tabs); clear(grid);
    const q = search.value.trim().toLowerCase();
    const cats = [['🕘', recents().map((e) => `${e} `)], ...Object.entries(CATS)];
    for (const [k] of cats) tabs.append(h('button', { class: `emoji-tab${!q && cat === k ? ' on' : ''}`, type: 'button', role: 'tab', onclick: () => { cat = k; search.value = ''; paint(); } }, k));
    const list = q ? Object.values(CATS).flat().filter((x) => x.toLowerCase().includes(q)) : (cats.find(([k]) => k === cat)?.[1] ?? []);
    if (!list.length) grid.append(h('div', { class: 'faint' }, q ? 'No match' : 'Nothing yet — pick some!'));
    for (const item of list) { const e = item.split(' ')[0]; grid.append(h('button', { class: 'emoji-btn', type: 'button', role: 'option', title: item.slice(e.length).trim(), onclick: () => pick(e) }, e)); }
  }
  function close() { open = false; pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); }
  const outside = (ev) => { if (!wrap.contains(ev.target)) close(); };
  const esc = (ev) => { if (ev.key === 'Escape') { close(); btn.focus(); } };
  function toggle() {
    if (open) return close();
    open = true; pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); if (!recents().length && cat === '🕘') cat = Object.keys(CATS)[0];
    paint(); search.focus();
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true);
  }
  search.addEventListener('input', paint);
  return { el: wrap, close };
}

// Insert text at the caret of a textarea/input and fire an input event so auto-resize runs.
export function insertAtCursor(el, text) {
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + text + el.value.slice(e);
  el.selectionStart = el.selectionEnd = s + text.length;
  el.dispatchEvent(new Event('input'));
  el.focus();
}
