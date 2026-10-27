#!/usr/bin/env python3
"""Desktop helper for the Friday node (GNOME, Wayland or X11). One command per run, JSON args as argv[2] or on stdin ("-"), JSON on stdout.
  screen                      -> desktop size in logical pixels + monitors (Mutter DisplayConfig; xrandr fallback)
  shot '{"maxWidth":1280}'    -> downscaled JPEG of the whole desktop, base64 (xdg-desktop-portal, non-interactive)
  clip_get                    -> clipboard text
  clip_set '{"text":"..."}'   -> own the clipboard (a detached process keeps serving it until someone else copies)
Clipboard goes through XWayland (GDK_BACKEND=x11): Mutter bridges X11 and Wayland selections, and an X11 client
may read/own the selection without having keyboard focus (a Wayland client may not)."""
import base64, json, os, subprocess, sys, time


def screen():
    try:
        import gi
        gi.require_version('Gio', '2.0')
        from gi.repository import Gio
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        r = bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', 'GetCurrentState',
                          None, None, Gio.DBusCallFlags.NONE, 3000, None).unpack()
        _serial, monitors, logical, props = r
        physical = props.get('layout-mode') == 2  # 1 = logical (scaled) layout, 2 = physical pixels
        modes = {}
        for spec, mlist, _p in monitors:
            for m in mlist:
                if m[6].get('is-current'): modes[spec[0]] = (m[1], m[2])
        out = []
        for x, y, scale, transform, primary, specs, _p in logical:
            w, h = modes.get(specs[0][0], (0, 0)) if specs else (0, 0)
            if transform in (1, 3, 5, 7): w, h = h, w  # rotated 90/270
            if not physical: w, h = round(w / scale), round(h / scale)
            out.append({'name': specs[0][0] if specs else '?', 'x': x, 'y': y, 'width': w, 'height': h, 'scale': round(scale, 3), 'primary': bool(primary)})
        if not out: raise RuntimeError('no monitors')
        return {'width': max(m['x'] + m['width'] for m in out), 'height': max(m['y'] + m['height'] for m in out), 'monitors': out, 'source': 'mutter'}
    except Exception as e:
        err = str(e)[:120]
    try:  # X11 / XWayland fallback (on Wayland this reports the XWayland root, usually the same layout)
        o = subprocess.run(['xrandr', '--query'], capture_output=True, text=True, timeout=5).stdout
        import re
        mons = [{'name': m[0], 'width': int(m[2]), 'height': int(m[3]), 'x': int(m[4]), 'y': int(m[5]), 'scale': 1, 'primary': bool(m[1])}
                for m in re.findall(r'^(\S+) connected (primary )?(\d+)x(\d+)\+(\d+)\+(\d+)', o, re.M)]
        if mons: return {'width': max(m['x'] + m['width'] for m in mons), 'height': max(m['y'] + m['height'] for m in mons), 'monitors': mons, 'source': 'xrandr'}
    except Exception:
        pass
    return {'error': f'screen_geometry_unavailable: {err}'}


def portal_shot(timeout=15):
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    token = f'friday{os.getpid()}'
    sender = bus.get_unique_name()[1:].replace('.', '_')
    handle = f'/org/freedesktop/portal/desktop/request/{sender}/{token}'
    loop = GLib.MainLoop(); result = {}

    def on_resp(_c, _s, _p, _i, _sig, params, *_):
        code, res = params.unpack()
        if code == 0 and 'uri' in res: result['path'] = GLib.filename_from_uri(res['uri'])[0]
        else: result['error'] = f'portal_denied_or_failed({code})'
        loop.quit()
    # Subscribe BEFORE calling, on the predictable request path, so a fast Response is never missed.
    bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response', handle, None, Gio.DBusSignalFlags.NONE, on_resp)
    opts = {'handle_token': GLib.Variant('s', token), 'interactive': GLib.Variant('b', False)}
    bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Screenshot', 'Screenshot',
                  GLib.Variant('(sa{sv})', ('', opts)), None, Gio.DBusCallFlags.NONE, 5000, None)
    GLib.timeout_add_seconds(timeout, lambda: (result.setdefault('error', 'timeout'), loop.quit()))
    loop.run()
    return result


def shot(a):
    max_w = max(320, min(int(a.get('maxWidth') or 1280), 3840))
    quality = max(30, min(int(a.get('quality') or 70), 95))
    t0 = time.time()
    r = portal_shot()
    if 'error' in r: return r
    path = r['path']
    try:
        import gi
        gi.require_version('GdkPixbuf', '2.0')
        from gi.repository import GdkPixbuf
        pb = GdkPixbuf.Pixbuf.new_from_file(path)
        sw, sh = pb.get_width(), pb.get_height()
        w = min(sw, max_w); h = max(1, round(sh * w / sw))
        # Scale and flatten onto an RGB canvas in one pass (the JPEG encoder refuses RGBA input).
        out = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, w, h); out.fill(0xffffffff)
        pb.composite(out, 0, 0, w, h, 0, 0, w / sw, h / sh, GdkPixbuf.InterpType.BILINEAR, 255); pb = out
        ok, buf = pb.save_to_bufferv('jpeg', ['quality'], [str(quality)])
        return {'mime': 'image/jpeg', 'base64': base64.b64encode(buf).decode(), 'width': pb.get_width(), 'height': pb.get_height(),
                'sourceWidth': sw, 'sourceHeight': sh, 'ms': round((time.time() - t0) * 1000)}
    finally:
        # The portal saves into ~/Pictures under a fresh unique name (Screenshot.png, Screenshot-1.png, ...): it is ours, remove it.
        try: os.remove(path)
        except OSError: pass


def _gtk():
    os.environ['GDK_BACKEND'] = 'x11'
    import gi
    gi.require_version('Gtk', '3.0'); gi.require_version('Gdk', '3.0')
    from gi.repository import Gtk, Gdk
    if not Gtk.init_check(sys.argv)[0]: raise RuntimeError('no X display for the clipboard (DISPLAY/XAUTHORITY missing?)')
    return Gtk, Gdk


def clip_get(_a):
    Gtk, Gdk = _gtk()
    text = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text()
    return {'text': text or ''}


def clip_set(a):
    text = str(a.get('text', ''))
    rfd, wfd = os.pipe()
    if os.fork() > 0:  # parent: wait until the child owns the selection
        os.close(wfd)
        msg = os.read(rfd, 300).decode() or '{"error":"clipboard_helper_died"}'
        return json.loads(msg)
    os.close(rfd); os.setsid()
    try:
        Gtk, Gdk = _gtk()
        from gi.repository import GLib
        cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        cb.set_text(text, -1)
        started = time.time()
        # Serve pastes until another app takes the clipboard (or 30 min pass).
        cb.connect('owner-change', lambda *_: time.time() - started > 0.5 and Gtk.main_quit())
        GLib.timeout_add_seconds(1800, Gtk.main_quit)
        os.write(wfd, json.dumps({'ok': True, 'chars': len(text)}).encode()); os.close(wfd)
        sys.stdout.flush()
        devnull = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2): os.dup2(devnull, fd)
        Gtk.main()
    except Exception as e:
        try: os.write(wfd, json.dumps({'error': str(e)[:200]}).encode())
        except OSError: pass
    os._exit(0)


CMDS = {'screen': lambda _a: screen(), 'shot': shot, 'clip_get': clip_get, 'clip_set': clip_set}
if __name__ == '__main__':
    try:
        raw = sys.stdin.read() if len(sys.argv) > 2 and sys.argv[2] == '-' else (sys.argv[2] if len(sys.argv) > 2 else '{}')
        print(json.dumps(CMDS[sys.argv[1]](json.loads(raw or '{}'))), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e)[:200]}), flush=True)
