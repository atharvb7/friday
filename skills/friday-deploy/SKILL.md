---
name: friday-deploy
description: How to build a web app/site so Friday can host it on the owner's server with app_deploy (Dockerfile or static or Node, PORT, health, no secrets). Use whenever an app should be hosted/put online.
---
# Shipping an app Friday can host

Friday's deployer builds your **project workspace** (this folder) into a container and publishes it on the owner's
Tailscale network at `https://<server>.ts.net:<port>`. Build the app so this just works:

## Pick ONE of these layouts (checked in this order)
1. **`Dockerfile` at the project root** (best for anything non-trivial: APIs, full-stack, Python, multi-stage builds).
   - Listen on `0.0.0.0` and on the port in `$PORT` if set; also `EXPOSE <that port>` (the first EXPOSE is used).
   - Run as a non-root user (`USER node`, or `USER 10001`). No privileged ports (<1024).
   - Multi-stage: build in one stage, copy only the output into a small runtime image (`node:22-alpine`, `nginxinc/nginx-unprivileged:1.27-alpine`, `python:3.12-slim`).
2. **Static site**: `index.html` at the root, or a built site in `dist/`, `build/`, `out/` or `public/` **and no package.json** → served by nginx on 8080. For a framework app, either commit the built output and remove package.json from the deploy folder, or (better) write a Dockerfile.
3. **Node app**: `package.json` with `"start"` (and optional `"build"`) → `npm ci && npm run build && npm start` on port 3000 (`$PORT`). Bind `0.0.0.0`.

## Rules
- The app must answer `GET /` with a 2xx/3xx within ~30 s of starting (that is the health check).
- **Never put secrets in the project.** `.env*` files are excluded from the image on purpose. If the app needs a key, stop and tell Friday which key and why.
- Keep it light: the server has ~6 GB RAM shared with everything; apps get 256 MB by default. No headless browsers, no huge models.
- Data that must survive redeploys: use a hosted DB/service or SQLite in a path the user agrees on — containers are replaced on every deploy.
- `node_modules`, `.git` and caches are not sent; the build installs dependencies itself, so `package-lock.json` must be committed.
- Before saying "done": build it locally in the workspace (`npm run build` / `docker build` is NOT available — so run the app's own build and start it, curl `http://127.0.0.1:$PORT/`), then report the workspace name, the layout you chose, the port and how you verified it. Friday then calls `app_deploy`.

## Quality bar for websites
Follow the `frontend-design` skill for look & feel, `react-best-practices` for React/Next.js, `verification-before-completion` before claiming success. Mobile-first, accessible (labels, contrast, focus), fast (optimised images, no unused JS), real content (no lorem ipsum unless asked).
