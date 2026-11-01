# Friday desktop pet (Tauri shell)

The 3D pet already runs in any browser at `/pet.html` (compact: `/pet.html?compact=1`) and follows Friday's real state
(`/v1/presence`). This folder wraps it in a transparent, always-on-top, click-through-optional window with Tauri.
Status: **config provided, not built here (no Rust toolchain on the dev laptop).**

```bash
# prerequisites: Rust (rustup), Node, and on Ubuntu: libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev
cargo install tauri-cli --version "^2"
cd desktop-pet && cargo tauri dev        # points at http://127.0.0.1:4317/pet.html?compact=1
```
Notes: GNOME Wayland cannot force always-on-top for normal windows; run the pet under XWayland (`GDK_BACKEND=x11`) or use
a GNOME extension. The pet reads state with the owner/device token you enter once in its page (stored in localStorage).
