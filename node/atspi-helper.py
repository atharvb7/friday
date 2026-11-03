#!/usr/bin/env python3
"""AT-SPI accessibility helper for the Friday node (read UI trees, press buttons,
set text). Works on Wayland because it talks to the accessibility bus, not the
compositor. Usage: atspi-helper.py <cmd> '<json args>'   -> JSON on stdout."""
import json, os, subprocess, sys, time, warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

MAX_NODES = 150
INTERACTIVE = {'push button', 'toggle button', 'check box', 'radio button', 'menu item', 'link', 'text', 'entry',
               'password text', 'combo box', 'page tab', 'list item', 'tool bar', 'paragraph', 'terminal', 'spin button', 'table cell'}

def apps():
    desktop = Atspi.get_desktop(0)
    return [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]

def name_of(a):
    try: return (a.get_name() or '').strip()
    except Exception: return ''

def role_of(a):
    try: return a.get_role_name()
    except Exception: return ''

def states(a):
    try:
        s = a.get_state_set()
        return {k: s.contains(getattr(Atspi.StateType, k)) for k in ('SHOWING', 'ENABLED', 'FOCUSED', 'EDITABLE') if hasattr(Atspi.StateType, k)}
    except Exception:
        return {}

TEXTUAL = {'text', 'entry', 'paragraph', 'terminal', 'spin button', 'password text', 'label', 'heading', 'static'}

def text_of(a, role):
    if role not in TEXTUAL or role == 'password text': return ''
    try:  # call the Text interface explicitly: on new libatspi a.get_text() resolves to Accessible, not Text
        if 'Text' not in a.get_interfaces(): return ''
        return (Atspi.Text.get_text(a, 0, min(Atspi.Text.get_character_count(a), 300)) or '').strip()
    except Exception: return ''

def walk(node, path, out, depth=0, parent_name=None):
    if len(out) >= MAX_NODES or depth > 34: return  # GTK4 apps nest content ~25 deep (Files' file list)
    role = role_of(node); nm = name_of(node); st = states(node)
    # A button's inner label repeats the button's name: skip it (halves the tree for toolbars/keypads).
    dup = role == 'label' and nm and nm == parent_name
    if st.get('SHOWING', True) and not dup and (role in INTERACTIVE or nm):
        acts = []
        try:
            ai = node.get_action_iface()
            if ai: acts = [ai.get_action_name(i) for i in range(ai.get_n_actions())]
        except Exception: pass
        el = {'ref': '.'.join(map(str, path)), 'role': role, 'name': nm[:80], 'actions': acts[:6], 'editable': bool(st.get('EDITABLE'))}
        val = text_of(node, role)
        if val and val != nm: el['value'] = val[:300]
        if st.get('FOCUSED'): el['focused'] = True
        out.append(el)
    try: n = node.get_child_count()
    except Exception: n = 0
    for i in range(min(n, 80)):
        try: walk(node.get_child_at_index(i), path + [i], out, depth + 1, nm)
        except Exception: pass

def resolve(ref):
    parts = [int(x) for x in ref.split('.')]
    node = apps()[parts[0]]
    for i in parts[1:]: node = node.get_child_at_index(i)
    return node

def cmd_windows(_):
    res = []
    for ai, app in enumerate(apps()):
        wins = []
        try:
            for j in range(app.get_child_count()):
                w = app.get_child_at_index(j)
                try: active = w.get_state_set().contains(Atspi.StateType.ACTIVE)  # the focused window
                except Exception: active = False
                wins.append({'ref': f'{ai}.{j}', 'name': name_of(w), **({'active': True} if active else {})})
        except Exception: pass
        if wins: res.append({'app': name_of(app), 'index': ai, 'windows': wins})  # skip window-less services (daemons, portals)
    return {'apps': res}

def cmd_tree(a):
    node = resolve(a['ref'])
    out = []; walk(node, [int(x) for x in a['ref'].split('.')], out)
    return {'elements': out}

def cmd_act(a):
    node = resolve(a['ref']); ai = node.get_action_iface()
    if not ai: return {'ok': False, 'error': 'no_actions'}
    names = [ai.get_action_name(i) for i in range(ai.get_n_actions())]
    if a.get('action') and a['action'] not in names:  # never fall back to another action (index 0 could be "paste")
        return {'ok': False, 'error': 'no_such_action', 'available': names[:12]}
    idx = names.index(a['action']) if a.get('action') else 0
    return {'ok': bool(ai.do_action(idx)), 'action': names[idx]}

def cmd_set_text(a):
    node = resolve(a['ref'])
    et = node.get_editable_text_iface()
    if not et: return {'ok': False, 'error': 'not_editable'}
    return {'ok': bool(et.set_text_contents(a['text']))}

# ---------- Files (Nautilus): move items the way a person would, through the app's own commands ----------
# Select the files in the folder's window (scrolling so lazily-loaded rows appear), then either "New Folder with
# Selection" (target is a new folder right here) or Cut -> open the target folder's window -> Paste. Everything goes
# through accessibility actions: no pointer, no keyboard, so it never types into the wrong window or fights the user.
NAUTILUS = 'org.gnome.Nautilus'

def find_node(n, pred, dep=0, limit=40):
    try:
        if pred(n): return n
    except Exception: return None
    if dep > limit: return None
    try: k = n.get_child_count()
    except Exception: return None
    for i in range(min(k, 200)):
        try: r = find_node(n.get_child_at_index(i), pred, dep + 1, limit)
        except Exception: r = None
        if r is not None: return r
    return None

def files_windows():
    out = []
    for a in apps():
        if name_of(a) != NAUTILUS: continue
        for j in range(a.get_child_count()):
            w = a.get_child_at_index(j)
            if role_of(w) == 'frame': out.append(w)
    return out

def content_view(w): return find_node(w, lambda n: role_of(n) == 'table' and name_of(n) == 'Content View')
def cell_name(c):
    nm = name_of(c)
    return nm.rsplit('. ', 1)[0] if '. ' in nm else nm

def do(n, action):
    ai = n.get_action_iface()
    names = [ai.get_action_name(i) for i in range(ai.get_n_actions())] if ai else []
    if action not in names: raise RuntimeError(f'no_action:{action}')
    return ai.do_action(names.index(action))

def wait_for(fn, secs=4.0, step=0.12):
    t = time.time() + secs
    while time.time() < t:
        r = fn()
        if r: return r
        time.sleep(step)
    return None

def open_window(path, needs_items=True):
    """Open a fresh Files window on `path` (closed again by the caller). New windows are appended last; a window
    with an empty list is a stale one (e.g. its folder was deleted) unless the folder really is empty."""
    title = os.path.basename(path.rstrip('/')) or path
    before = len(files_windows())
    subprocess.Popen(['nautilus', '--new-window', path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    def ready():
        ws = files_windows()
        if len(ws) <= before: return None
        for w in reversed(ws[before:]):
            v = content_view(w) if name_of(w) == title else None
            if v is not None and (v.get_child_count() > 0 or not needs_items): return w
        return None
    w = wait_for(ready, 6.0)
    if w is None: raise RuntimeError(f'files_window_not_opened:{title}')
    return w

def select_names(w, wanted):
    """Select exactly these names; rows load lazily, so scroll down then up until every name was seen."""
    t = wait_for(lambda: (lambda v: v if v is not None and v.get_child_count() > 0 else None)(content_view(w)), 5.0)  # the list loads after the window
    if t is None: raise RuntimeError('no_file_list')
    time.sleep(0.2)
    do(t, 'list.unselect-all')
    want = set(wanted); got = set(); seen = set()
    for direction in ('down', 'up'):
        stale = 0
        for _ in range(400):
            t = content_view(w); n = t.get_child_count()
            new = 0
            for i in range(n):
                c = t.get_child_at_index(i); nm = cell_name(c)
                if nm not in seen: seen.add(nm); new += 1
                if nm in want and nm not in got:
                    # select_child takes the row's place in the WHOLE folder, not among the loaded rows (after a scroll
                    # child 0 may be row 33): posinset is that place, 1-based. Selecting by child index picked wrong files.
                    try: pos = int(c.get_attributes().get('posinset')) - 1
                    except Exception: pos = i if i == c.get_index_in_parent() and not seen - set(want) else None
                    if pos is not None and Atspi.Selection.select_child(t, pos): got.add(nm)
            if got == want or not n: break
            stale = stale + 1 if not new else 0
            if stale >= 3: break
            edge = t.get_child_at_index(n - 1 if direction == 'down' else 0)
            try: do(edge, 'listitem.scroll-to')
            except Exception: break
            time.sleep(0.12)
        if got == want: break
    return got

def cmd_files_move(a):
    src = a['dir']; names = list(a['names']); target = a['target']; t0 = time.time()
    w = open_window(src)
    try:
        got = select_names(w, names)
        if not got: return {'ok': False, 'error': 'nothing_selected', 'selected': []}
        if a.get('newFolder'):
            do(w, 'view.new-folder-with-selection')
            dlg = wait_for(lambda: find_node(w, lambda n: role_of(n) == 'dialog'), 4.0)
            if dlg is None: raise RuntimeError('new_folder_dialog_missing')
            entry = find_node(dlg, lambda n: role_of(n) == 'text' and 'EditableText' in n.get_interfaces())
            btn = find_node(dlg, lambda n: role_of(n) in ('push button', 'button') and name_of(n) == 'Create')
            if entry is None or btn is None: raise RuntimeError('new_folder_dialog_unreadable')
            Atspi.EditableText.set_text_contents(entry, a['newFolder'])
            time.sleep(0.15)
            do(btn, 'click')
        else:
            do(w, 'view.cut')
            tw = open_window(target, needs_items=False)
            try:
                do(tw, 'view.paste_accel')
                wait_for(lambda: all(os.path.lexists(os.path.join(target, x)) for x in got), 8.0, 0.1)
            finally:
                try: do(tw, 'window.close')
                except Exception: pass
        wait_for(lambda: all(os.path.lexists(os.path.join(target, x)) for x in got), 6.0, 0.1)
        return {'ok': True, 'selected': sorted(got), 'ms': int((time.time() - t0) * 1000)}
    finally:
        try: do(w, 'window.close')
        except Exception: pass

CMDS = {'windows': cmd_windows, 'tree': cmd_tree, 'act': cmd_act, 'set_text': cmd_set_text, 'files_move': cmd_files_move}
try:
    print(json.dumps(CMDS[sys.argv[1]](json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})))
except Exception as e:
    print(json.dumps({'error': str(e)[:200]})); sys.exit(1)
