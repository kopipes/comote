# Comote

Comote is a private, single-user PWA for continuing the same VPS-hosted development work from a phone or laptop. The browser gets a focused product UI; Codex and shell execution remain behind the server boundary.

## Security model

- The HTTP server binds to `127.0.0.1` and is published privately with Tailscale Serve.
- Comote has its own password/session gate in addition to Tailscale device identity.
- Session cookies are `HttpOnly`, `Secure`, and `SameSite=Strict`; mutating requests require a per-session CSRF token.
- Passwords use Node's built-in scrypt and only the derived hash is stored.
- Login attempts are rate-limited.
- Codex App Server is spawned lazily over stdio and never receives a public listener.
- Projects are restricted to direct Git workspaces under `COMOTE_PROJECTS_ROOT`.
- The systemd service runs as the unprivileged `coder` user with no Linux capabilities and a read-only system/home view except for explicit Comote paths.
- Git commits created by Comote include request device, VPS, assistant, and Comote thread trailers.

## Local development

Requirements: Node.js 22+, npm, Git, and Codex CLI for live agent sessions.

```sh
npm install
npm run password:hash
```

Set the printed hash as `COMOTE_PASSWORD_HASH`, create at least one Git repository under `./projects`, then run:

```sh
COMOTE_PASSWORD_HASH='scrypt$...' COMOTE_COOKIE_SECURE=false npm run dev
```

The Vite UI listens on `127.0.0.1:4173` and proxies API requests to `127.0.0.1:4174`.

## Production

```sh
npm ci
npm run typecheck
npm test
npm run build
NODE_ENV=production node build/server/index.js
```

Production configuration is shown in `.env.example`. The systemd unit at `deploy/comote.service` expects the release at `/opt/comote/current`, configuration at `/etc/comote/comote.env`, and writable state under `/home/coder`.

The currently deployed VPS topology and recovery commands are documented in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Current MVP surface

- Private login with remembered device label
- Project and Codex thread discovery
- New/resumed natural-language sessions
- Live assistant, command, file-change, status, and approval events
- Approval allow/decline actions
- Git status and diff viewer
- Explicit commit with provenance trailers and explicit push
- Responsive mobile/desktop layout and installable PWA shell

Passkeys, managed preview URLs, worktree-per-task isolation, and push notifications are intentionally scheduled after the private end-to-end path is validated on the VPS.
