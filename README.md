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

- Ping OTP-first login with remembered device label and the existing password as an independent fallback
- Create blank Git projects or import public GitHub repositories from the Projects pane
- Change the Comote password and configure the selected project's public GitHub remote from Settings
- Project and Codex thread discovery
- New/resumed natural-language sessions
- Persisted context-usage meter with safe thresholds and native one-click conversation compaction
- Fresh-session handoff with an AI-generated summary while retaining the exact task worktree and branch
- Per-session model selector populated from the models available to the VPS Codex account; Auto follows the Codex default
- Archive, restore, or permanently delete sessions from the session menu; deletion refuses uncommitted or unmerged task work
- New sessions run in an isolated `comote/task-*` Git worktree; existing sessions remain compatible with the canonical workspace
- Live assistant, command, file-change, status, and approval events
- Approval allow/decline actions
- Git status and diff viewer
- Explicit commit with provenance trailers and explicit push
- Explicit merge from a clean task branch into the canonical branch, also with provenance trailers
- Responsive mobile/desktop layout and installable PWA shell
- Persistent System, Light, and Dark appearance modes; Light uses the warm neutral `#F7F6F3` base
- Daily verified local recovery backups and a five-minute self-healing health probe on the VPS
- One-click preview for Node projects through a private, dedicated Tailscale Serve URL
- One-click local production deployment for npm projects, with isolated releases, persistent storage, SQLite/PostgreSQL/MySQL, private Redis, secrets, migrations, health checks, wildcard HTTPS, and rollback
- Public illustrated user guide at `https://guide.apps.devop.my.id/`, also linked from the Comote header
- Globally installed UI/UX design intelligence for Codex; its skill code and catalogs never enter application repositories

Ping OTP requires `COMOTE_PING_WEBHOOK_TOKEN` and `COMOTE_OTP_EMAIL`; the optional webhook URL defaults to the Ping notify endpoint. Keep the webhook token only in the root-owned production environment. OTP challenges remain in memory, expire after five minutes, are single-use, and are rate-limited.

The UI/UX skill is vendored as a focused runtime bundle under `deploy/skills/ui-ux-pro-max` and copied to `/home/coder/.codex/skills/ui-ux-pro-max` before Comote starts. It is based on the MIT-licensed `nextlevelbuilder/ui-ux-pro-max-skill` core only; the gallery, package manager, fonts, premium assets, and unrelated design skills are excluded. Comote instructs Codex to use the design intelligence without copying its source or datasets into an application project.

For an isolated task, commit its changes first, use **Merge into main**, then use **Push main** when ready. **Push task branch** is available when you want an off-VPS copy of the task before merging. **Start preview** auto-detects an npm `dev` or `start` script; ask Codex to install dependencies first when `node_modules` is absent. **Deploy production** always packages the clean canonical branch, never an uncommitted task worktree. Add `comote.deploy.json`—normally by asking Codex in natural language—to select SQLite, PostgreSQL, MySQL, Redis, migration, health-check, and persistent-storage behavior. See [Project deployment](docs/PROJECT-DEPLOYMENT.md). Private GitHub credentials, passkeys, multi-preview hosting, and push notifications are scheduled as later layers. Public GitHub imports and remotes work without stored GitHub credentials.
