#!/usr/bin/env python3
"""AT-SPI accessibility helper for the Friday node (read UI trees, press buttons,
set text). Works on Wayland because it talks to the accessibility bus, not the
compositor. Usage: atspi-helper.py <cmd> '<json args>'   -> JSON on stdout."""
import json, sys
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

MAX_NODES = 150
INTERACTIVE = {'push button', 'toggle button', 'check box', 'radio button', 'menu item', 'link', 'text', 'entry',
               'password text', 'combo box', 'page tab', 'list item', 'tool bar', 'paragraph', 'terminal', 'spin button'}

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

def walk(node, path, out, depth=0):
    if len(out) >= MAX_NODES or depth > 14: return
    role = role_of(node); nm = name_of(node); st = states(node)
    if st.get('SHOWING', True) and (role in INTERACTIVE or nm):
        acts = []
        try:
            ai = node.get_action_iface()
            if ai: acts = [ai.get_action_name(i) for i in range(ai.get_n_actions())]
        except Exception: pass
        out.append({'ref': '.'.join(map(str, path)), 'role': role, 'name': nm[:80], 'actions': acts, 'editable': bool(st.get('EDITABLE'))})
    try: n = node.get_child_count()
    except Exception: n = 0
    for i in range(min(n, 80)):
        try: walk(node.get_child_at_index(i), path + [i], out, depth + 1)
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
                wins.append({'ref': f'{ai}.{j}', 'name': name_of(w)})
        except Exception: pass
        res.append({'app': name_of(app), 'index': ai, 'windows': wins})
    return {'apps': res}

def cmd_tree(a):
    node = resolve(a['ref'])
    out = []; walk(node, [int(x) for x in a['ref'].split('.')], out)
    return {'elements': out}

def cmd_act(a):
    node = resolve(a['ref']); ai = node.get_action_iface()
    if not ai: return {'ok': False, 'error': 'no_actions'}
    names = [ai.get_action_name(i) for i in range(ai.get_n_actions())]
    idx = names.index(a['action']) if a.get('action') in names else 0
    return {'ok': bool(ai.do_action(idx)), 'action': names[idx]}

def cmd_set_text(a):
    node = resolve(a['ref'])
    et = node.get_editable_text_iface()
    if not et: return {'ok': False, 'error': 'not_editable'}
    return {'ok': bool(et.set_text_contents(a['text']))}

CMDS = {'windows': cmd_windows, 'tree': cmd_tree, 'act': cmd_act, 'set_text': cmd_set_text}
try:
    print(json.dumps(CMDS[sys.argv[1]](json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})))
except Exception as e:
    print(json.dumps({'error': str(e)[:200]})); sys.exit(1)
