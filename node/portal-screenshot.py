#!/usr/bin/env python3
"""Non-interactive screenshot through xdg-desktop-portal (works on GNOME Wayland;
the portal may show a one-time permission prompt). Prints {"path": ...} or {"error": ...}."""
import json, sys, os
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

def main():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    token = 'friday' + str(os.getpid())
    sender = bus.get_unique_name()[1:].replace('.', '_')
    handle = f'/org/freedesktop/portal/desktop/request/{sender}/{token}'
    loop = GLib.MainLoop(); result = {}
    def on_resp(conn, snd, path, iface, sig, params, *_):
        code, res = params.unpack()
        if code == 0 and 'uri' in res: result['path'] = res['uri'].replace('file://', '')
        else: result['error'] = f'portal_denied_or_failed({code})'
        loop.quit()
    bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response', handle, None, Gio.DBusSignalFlags.NONE, on_resp)
    opts = {'handle_token': GLib.Variant('s', token), 'interactive': GLib.Variant('b', False)}
    bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Screenshot', 'Screenshot',
                  GLib.Variant('(sa{sv})', ('', opts)), None, Gio.DBusCallFlags.NONE, 5000, None)
    GLib.timeout_add_seconds(int(sys.argv[1]) if len(sys.argv) > 1 else 20, lambda: (result.setdefault('error', 'timeout'), loop.quit()))
    loop.run()
    print(json.dumps(result))
try: main()
except Exception as e: print(json.dumps({'error': str(e)[:200]}))
