# Comote VPS deployment

This document records the active single-user deployment as of 2026-09-07. It intentionally contains no passwords, session cookies, or Tailscale authentication keys.

## Access

- Private URL: `https://comote-vps.tailb6b750.ts.net/`
- Public user guide: `https://guide.apps.devop.my.id/`
- The client device must be signed in to the same Tailscale network.
- Comote then requires either a Ping OTP or its existing password and records the supplied device name in session and Git provenance.
- Login defaults to a one-time code delivered by Ping. The existing Comote password remains available as an independent fallback and triggers a Ping security notice after successful use.
- The app is installable from the browser as a PWA on a phone or laptop.

## Network topology

Tailscale Serve terminates private HTTPS and proxies to Comote on `127.0.0.1:4173`. Comote and Codex App Server have no public listener. UFW allows SSH publicly and allows the private Comote/preview HTTPS ports only on `tailscale0`; public ports 80/443 are reserved for deployed production applications.

The optional project preview route uses a second tailnet-only HTTPS listener on port `8443`, proxied by Tailscale Serve to `127.0.0.1:4180`. Only one preview is active at a time. The preview does not pass Comote or Codex secrets into the child process, and its port is not opened on public interfaces.

Production applications use the wildcard `*.apps.devop.my.id`, whose DNS-only A record points to this VPS. Nginx binds only to the VPS private/NAT interface address `10.0.3.25` on public ports 80/443, so Tailscale continues listening on its own address on port 443. Application processes bind to loopback ports 5200–5299 and are not opened by UFW.

The public Comote guide is served as static files from the active Comote release at `guide.apps.devop.my.id`. That Nginx virtual host exposes only `/opt/comote/current/guide`; the private Comote application and API remain available exclusively through Tailscale.

## Files and ownership

- Active release: `/opt/comote/current`
- Immutable releases: `/opt/comote/releases/<git-sha>`
- Canonical development workspace: `/home/coder/projects/comote`
- Comote state: `/home/coder/.local/share/comote`
- Isolated task worktrees: `/home/coder/.local/share/comote/worktrees`
- Codex login and sessions: `/home/coder/.codex`
- Global Codex UI/UX skill: `/home/coder/.codex/skills/ui-ux-pro-max`
- Root-only environment: `/etc/comote/comote.env`
- Service definition: `/etc/systemd/system/comote.service`
- Deployment broker socket: `/run/comote-deploy.sock`
- Production releases: `/srv/comote-apps/<slug>/releases`
- Production metadata: `/var/lib/comote-deploy/apps.json`
- Production app environment: `/etc/comote/apps/<slug>.env`
- Write-only project secrets: `/etc/comote/secrets/<slug>.json`
- Generated database credentials: `/etc/comote/resources/<slug>.json`
- Persistent app data: `/srv/comote-apps/<slug>/shared`
- Root-only local backups: `/var/backups/comote` (14-day retention)

The service runs as the locked, non-sudo `coder` account. Its systemd sandbox grants write access only to the Comote state, Codex state, and project workspace paths.

The root-only environment also contains the Ping webhook token and fixed OTP destination. The browser receives only a masked destination; webhook credentials and full destination configuration never enter client assets or Git history.

The same fixed Ping integration can send optional operational notices when a tracked Codex turn finishes, approval is required, project checks fail, or deployment/rollback completes. Preferences are stored under the private Comote data directory. Notifications contain only a sanitized project name and a short status; prompts, command text, check/deploy logs, code, credentials, and the configured recipient are not included.

## Health and recovery

Run these from an authorized administrator machine:

```sh
ssh cloudeka48 'sudo systemctl status comote.service --no-pager'
ssh cloudeka48 'curl -sS http://127.0.0.1:4173/api/health'
ssh cloudeka48 'tailscale serve status'
ssh cloudeka48 'sudo journalctl -u comote.service -n 100 --no-pager'
ssh cloudeka48 'systemctl list-timers comote-backup.timer comote-healthcheck.timer --no-pager'
```

Restart without changing data:

```sh
ssh cloudeka48 'sudo systemctl restart comote.service'
```

A health timer probes Comote every five minutes and performs one automatic restart if the local HTTP health endpoint fails. A daily backup runs at approximately 03:30 Asia/Jakarta, briefly stops Comote for a consistent snapshot, verifies the archive, restarts the service, and retains 14 days. These archives are root-only and remain on the same VPS, so an off-VPS backup is still recommended later.

Rollback by repointing the release symlink to a known-good release, then restart. Confirm the exact release path before running the command.

## Production deployment

The Changes pane can deploy a clean canonical branch to `<slug>.apps.devop.my.id`. Source is exported with `git archive`, dependencies are installed from `package-lock.json`, and project build scripts execute as a locked per-app Linux user rather than root or `coder`. Static `dist/` builds are served directly by Nginx; projects with an npm `start` script run through `comote-app@<slug>.service`. Let’s Encrypt certificates are requested through an HTTP webroot challenge and renewed by the system timer.

Comote itself is explicitly excluded from public deployment. A project keeps the same slug after its first successful deployment. Up to four recent immutable releases are retained; the UI exposes rollback when a previous release exists. A project manifest can request SQLite, PostgreSQL, MySQL, Redis, migrations, secrets, and an HTTP health path. If a new Node release fails its port or HTTP health check, the broker restores the previous application release automatically. Persistent data and databases are never deleted by release pruning or application rollback.

Useful checks:

```sh
ssh cloudeka48 'sudo systemctl status comote-deploy.socket nginx --no-pager'
ssh cloudeka48 'sudo systemctl status comote-app@SLUG.service --no-pager'
ssh cloudeka48 'sudo journalctl -u "comote-deploy@*" -n 100 --no-pager'
ssh cloudeka48 'sudo nginx -t'
```

## Development continuity

All browser clients operate on the same VPS development environment. New Codex tasks use persistent isolated Git worktrees, so parallel tasks do not overwrite each other's uncommitted files; existing threads continue in their original canonical workspace. A clean, committed task branch can be merged explicitly into the canonical branch. Commits and task merges made by the Comote UI include `Requested-From`, `Developed-On`, `Assisted-By`, and `Comote-Session` trailers so the origin remains visible in Git history.

Project checks run standard npm scripts from the selected task worktree in the fixed order `lint`, `typecheck`, `test`, and `build`; if none exist, Comote recognizes a single `check` script. The browser cannot submit an arbitrary command to this runner. Output is bounded, checks time out after ten minutes per script, Comote environment variables are removed, and a source fingerprint marks old results stale when the worktree changes. Checks run sequentially to keep VPS resource use predictable.

The browser stores an unsent prompt draft under a project-and-session-specific local key. No draft is sent to the server until the user presses Send, and a failed send preserves it. The SSE client deduplicates replayed event IDs and displays a reconnecting state while EventSource restores a dropped connection.

Comote records context usage reported by Codex and exposes native conversation compaction. A fresh-session handoff first compacts the old conversation, asks it for a structured summary, creates a new Codex session on the exact same worktree and branch, archives the old session, and seeds the new session with the summary plus verified Git status. Shared continuation worktrees are reference-protected so deleting the archived conversation cannot delete files still used by its successor.

The core UI/UX design skill is installed globally by the service `ExecStartPre` step. It remains part of Comote infrastructure, not an application repository. Search results guide the code Codex generates; the skill source, catalogs, and scripts are never copied into project workspaces.

Ubuntu's global AppArmor restriction for unprivileged user namespaces remains enabled. The deployment installs `deploy/comote-codex.apparmor`, a narrowly attached profile for the versioned Codex executable only, so its bubblewrap turn sandbox can create the user namespace it requires without opening that permission system-wide.

The repository uses `https://github.com/kopipes/comote.git` as its off-VPS Git remote. The VPS workspace uses a dedicated, repository-scoped SSH deploy key; that key must be registered on GitHub with write access before the explicit Push action can authenticate.
