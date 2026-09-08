# Comote

Comote is a private, single-user PWA for continuing the same VPS-hosted development work from a phone or laptop. The browser gets a focused product UI; Codex and shell execution remain behind the server boundary.

## Security model

- The HTTP server binds to `127.0.0.1` and is published privately with Tailscale Serve.
- Comote has its own password/session gate in addition to Tailscale device identity.
- Session cookies are `HttpOnly`, `Secure`, and `SameSite=Strict`; mutating requests require a per-session CSRF token.
- Passwords use Node's built-in scrypt and only the derived hash is stored.
- Changing the password from Settings keeps the current device signed in and revokes every other Comote session.
- Login attempts are rate-limited.
- Codex App Server is spawned lazily over stdio, never receives a public listener, and does not inherit Comote's private environment variables.
- Projects are restricted to direct Git workspaces under `COMOTE_PROJECTS_ROOT`.
- The systemd service runs as the unprivileged `coder` user with no Linux capabilities and a read-only system/home view except for explicit Comote paths.
- Production deployment crosses the privilege boundary through a root-owned Unix socket broker. The broker accepts only validated local project, subdomain, deploy, and rollback requests; each production app builds and runs under its own locked Linux user.
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
- Create blank Git projects or import public GitHub repositories from the Projects pane
- Change the Comote password and configure the selected project's public GitHub remote from Settings
- Project and Codex thread discovery
- New/resumed natural-language sessions
- New sessions run in an isolated `comote/task-*` Git worktree; existing sessions remain compatible with the canonical workspace
- Live assistant, command, file-change, status, and approval events
- Approval allow/decline actions
- Git status and diff viewer
- Explicit commit with provenance trailers and explicit push
- Explicit merge from a clean task branch into the canonical branch, also with provenance trailers
- Responsive mobile/desktop layout and installable PWA shell
- Daily verified local recovery backups and a five-minute self-healing health probe on the VPS
- One-click preview for Node projects through a private, dedicated Tailscale Serve URL
- One-click local production deployment for npm projects, with isolated releases, persistent storage, SQLite/PostgreSQL/MySQL, private Redis, secrets, migrations, health checks, wildcard HTTPS, and rollback

For an isolated task, commit its changes first, use **Merge into main**, then use **Push main** when ready. **Push task branch** is available when you want an off-VPS copy of the task before merging. **Start preview** auto-detects an npm `dev` or `start` script; ask Codex to install dependencies first when `node_modules` is absent. **Deploy production** always packages the clean canonical branch, never an uncommitted task worktree. Add `comote.deploy.json`—normally by asking Codex in natural language—to select SQLite, PostgreSQL, MySQL, Redis, migration, health-check, and persistent-storage behavior. See [Project deployment](docs/PROJECT-DEPLOYMENT.md). Private GitHub credentials, passkeys, multi-preview hosting, and push notifications are scheduled as later layers. Public GitHub imports and remotes work without stored GitHub credentials.
