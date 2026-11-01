#!/usr/bin/env python3
"""Virtual keyboard + absolute pointer for the Friday node, in pure Python over /dev/uinput.

Works on GNOME Wayland (no xdotool/ydotool needed): the kernel device is picked up by the
compositor like a real one. Needs rw on /dev/uinput (an ACL for the user is enough; no sudo).
The pointer is ABSOLUTE (like a VM tablet), so positions are exact: the compositor maps the
device's 0..ABS_MAX range over the whole desktop (all monitors, logical pixels), so callers
send fractions of the desktop and HiDPI / multi-monitor layouts need no special casing.

Runs as a small server: one JSON command per stdin line, one JSON reply per stdout line.
Keeping the devices alive between commands avoids the ~0.5 s the compositor needs to adopt
a new device (and a burst of "new input device" churn on every action).
  {"op":"key","keys":"ctrl+shift+t"}   {"op":"type","text":"hello"}   (ASCII, US layout)
  {"op":"move","x":0.5,"y":0.5}         {"op":"click","x":..,"y":..,"button":"left","count":1}
  {"op":"drag","x1":..,"y1":..,"x2":..,"y2":..}   {"op":"scroll","x":..,"y":..,"dy":-3,"dx":0}
"""
import fcntl, json, os, struct, sys, time

ABS_MAX = 32767
EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
ABS_X, ABS_Y, REL_HWHEEL, REL_WHEEL = 0, 1, 6, 8
BTN = {'left': 272, 'right': 273, 'middle': 274}
# ioctl numbers from linux/uinput.h (x86_64/aarch64 encoding)
UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT, UI_SET_ABSBIT = 0x40045564, 0x40045565, 0x40045566, 0x40045567
UI_DEV_SETUP, UI_ABS_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x405C5503, 0x401C5504, 0x5501, 0x5502

KEYS = {
    'esc': 1, 'escape': 1, 'minus': 12, 'equal': 13, 'backspace': 14, 'tab': 15, 'enter': 28, 'return': 28,
    'ctrl': 29, 'control': 29, 'shift': 42, 'alt': 56, 'space': 57, 'capslock': 58, 'super': 125, 'meta': 125, 'win': 125, 'cmd': 125,
    'rightctrl': 97, 'rightshift': 54, 'altgr': 100, 'rightalt': 100, 'print': 99, 'printscreen': 99, 'home': 102, 'up': 103, 'pageup': 104, 'page_up': 104,
    'left': 105, 'right': 106, 'end': 107, 'down': 108, 'pagedown': 109, 'page_down': 109, 'insert': 110, 'delete': 111, 'del': 111,
    'mute': 113, 'volumedown': 114, 'volumeup': 115, 'pause': 119, 'menu': 127, 'nextsong': 163, 'playpause': 164, 'previoussong': 165,
    'stopcd': 166, 'brightnessdown': 224, 'brightnessup': 225,
}
for i, k in enumerate('1234567890'): KEYS[k] = 2 + i
for row, start in (('qwertyuiop', 16), ('asdfghjkl', 30), ('zxcvbnm', 44)):
    for i, k in enumerate(row): KEYS[k] = start + i
for i in range(10): KEYS[f'f{i + 1}'] = 59 + i
KEYS['f11'], KEYS['f12'] = 87, 88
# US layout: character -> (keycode, shift)
CHARS = {' ': (57, False), '\n': (28, False), '\t': (15, False)}
for c in 'abcdefghijklmnopqrstuvwxyz': CHARS[c] = (KEYS[c], False); CHARS[c.upper()] = (KEYS[c], True)
for c in '1234567890': CHARS[c] = (KEYS[c], False)
for c, code in zip('-=[];\'`\\,./', (12, 13, 26, 27, 39, 40, 41, 43, 51, 52, 53)): CHARS[c] = (code, False)
for c, code in zip('!@#$%^&*()_+{}:"~|<>?', (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 26, 27, 39, 40, 41, 43, 51, 52, 53)): CHARS[c] = (code, True)
for c, code in zip('-=[];\'`\\,./', (12, 13, 26, 27, 39, 40, 41, 43, 51, 52, 53)): KEYS[c] = code
KEYS.update({'plus': 13, 'comma': 51, 'period': 52, 'slash': 53, 'semicolon': 39, 'backslash': 43, 'grave': 41, 'bracketleft': 26, 'bracketright': 27, 'apostrophe': 40})


def setup(fd, name, product):
    # struct uinput_setup { struct input_id {u16 bustype, vendor, product, version}; char name[80]; u32 ff_effects_max; }
    fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack('HHHH80sI', 0x06, 0x4652, product, 1, name.encode()[:79], 0))
    fcntl.ioctl(fd, UI_DEV_CREATE)


class Devices:
    def __init__(self):
        self.kb = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.kb, UI_SET_EVBIT, EV_KEY)
        for code in set(KEYS.values()) | {c for c, _ in CHARS.values()}: fcntl.ioctl(self.kb, UI_SET_KEYBIT, code)
        setup(self.kb, 'Friday virtual keyboard', 1)
        # Pointer modelled on a VM tablet: ABS_X/ABS_Y + mouse buttons + wheel, no BTN_TOUCH (udev/libinput: absolute mouse).
        self.ptr = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        for ev in (EV_KEY, EV_ABS, EV_REL): fcntl.ioctl(self.ptr, UI_SET_EVBIT, ev)
        for b in BTN.values(): fcntl.ioctl(self.ptr, UI_SET_KEYBIT, b)
        for r in (REL_WHEEL, REL_HWHEEL): fcntl.ioctl(self.ptr, UI_SET_RELBIT, r)
        for a in (ABS_X, ABS_Y):
            fcntl.ioctl(self.ptr, UI_SET_ABSBIT, a)
            # struct uinput_abs_setup { u16 code; struct input_absinfo { s32 value, min, max, fuzz, flat, resolution } }
            fcntl.ioctl(self.ptr, UI_ABS_SETUP, struct.pack('Hxxiiiiii', a, 0, 0, ABS_MAX, 0, 0, 0))
        setup(self.ptr, 'Friday virtual pointer', 2)
        time.sleep(0.6)  # let udev + the compositor adopt the new devices before the first event

    def emit(self, fd, typ, code, value):
        t = time.time()
        os.write(fd, struct.pack('llHHi', int(t), int((t % 1) * 1e6), typ, code, value))

    def syn(self, fd): self.emit(fd, EV_SYN, 0, 0)

    def key(self, code, down):
        self.emit(self.kb, EV_KEY, code, 1 if down else 0); self.syn(self.kb)

    def combo(self, keys):
        parts = [p.strip().lower() for p in str(keys).replace(' ', '').split('+') if p.strip()] if keys != '+' else ['plus']
        codes = []
        for p in parts:
            if p in KEYS: codes.append(KEYS[p])
            elif len(p) == 1 and p in CHARS: codes.append(CHARS[p][0])
            else: raise ValueError(f'unknown key: {p}')
        for c in codes: self.key(c, True); time.sleep(0.012)
        for c in reversed(codes): self.key(c, False); time.sleep(0.012)

    def type(self, text, delay=0.008):
        bad = sorted({c for c in text if c not in CHARS})
        if bad: raise ValueError('non_ascii: ' + ''.join(bad[:10]))  # caller pastes these through the clipboard instead
        for ch in text:
            code, shift = CHARS[ch]
            if shift: self.key(42, True)
            self.key(code, True); self.key(code, False)
            if shift: self.key(42, False)
            time.sleep(delay)

    def move(self, x, y):
        cx = max(0, min(ABS_MAX, round(float(x) * ABS_MAX))); cy = max(0, min(ABS_MAX, round(float(y) * ABS_MAX)))
        self.emit(self.ptr, EV_ABS, ABS_X, cx); self.emit(self.ptr, EV_ABS, ABS_Y, cy); self.syn(self.ptr)

    def button(self, name, down):
        self.emit(self.ptr, EV_KEY, BTN[name], 1 if down else 0); self.syn(self.ptr)

    def click(self, x, y, button='left', count=1):
        if button not in BTN: raise ValueError('button must be left|right|middle')
        self.move(x, y); time.sleep(0.05)
        for _ in range(max(1, min(3, int(count)))):
            self.button(button, True); time.sleep(0.03); self.button(button, False); time.sleep(0.06)

    def drag(self, x1, y1, x2, y2, steps=20):
        self.move(x1, y1); time.sleep(0.05); self.button('left', True); time.sleep(0.08)
        for i in range(1, steps + 1):
            self.move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); time.sleep(0.015)
        time.sleep(0.05); self.button('left', False)

    def scroll(self, x, y, dy=0, dx=0):
        if x is not None and y is not None: self.move(x, y); time.sleep(0.03)
        for axis, n in ((REL_WHEEL, -int(dy)), (REL_HWHEEL, int(dx))):  # dy > 0 scrolls DOWN (wheel value < 0)
            for _ in range(min(abs(n), 50)):
                self.emit(self.ptr, EV_REL, axis, 1 if n > 0 else -1); self.syn(self.ptr); time.sleep(0.02)

    def close(self):
        for fd in (self.kb, self.ptr):
            try: fcntl.ioctl(fd, UI_DEV_DESTROY); os.close(fd)
            except OSError: pass


def handle(d, c):
    op = c.get('op')
    if op == 'key': d.combo(c['keys'])
    elif op == 'type': d.type(str(c['text']))
    elif op == 'move': d.move(c['x'], c['y'])
    elif op == 'click': d.click(c['x'], c['y'], c.get('button', 'left'), c.get('count', 1))
    elif op == 'drag': d.drag(c['x1'], c['y1'], c['x2'], c['y2'])
    elif op == 'scroll': d.scroll(c.get('x'), c.get('y'), c.get('dy', 0), c.get('dx', 0))
    elif op == 'ping': pass
    else: raise ValueError(f'unknown op: {op}')


def main():
    try: d = Devices()
    except OSError as e:
        print(json.dumps({'ready': False, 'error': f'uinput_unavailable: {e.strerror or e}'}), flush=True); sys.exit(1)
    print(json.dumps({'ready': True}), flush=True)
    try:
        for line in sys.stdin:
            if not line.strip(): continue
            c = None
            try:
                c = json.loads(line); handle(d, c); out = {'id': c.get('id'), 'ok': True}
            except Exception as e:
                out = {'id': c.get('id') if isinstance(c, dict) else None, 'ok': False, 'error': str(e)[:200]}
            print(json.dumps(out), flush=True)
    finally:
        d.close()


if __name__ == '__main__':
    main()
