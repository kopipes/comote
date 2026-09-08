# Comote VPS deployment

This document records the active single-user deployment as of 2026-09-07. It intentionally contains no passwords, session cookies, or Tailscale authentication keys.

## Access

- Private URL: `https://comote-vps.tailb6b750.ts.net/`
- The client device must be signed in to the same Tailscale network.
- Comote then requires its own password and records the supplied device name in session and Git provenance.
- The app is installable from the browser as a PWA on a phone or laptop.

## Network topology

Tailscale Serve terminates private HTTPS and proxies to Comote on `127.0.0.1:4173`. Comote and Codex App Server have no public listener. UFW allows public SSH and allows TCP 443 only on `tailscale0`.

The optional project preview route uses a second tailnet-only HTTPS listener on port `8443`, proxied by Tailscale Serve to `127.0.0.1:4180`. Only one preview is active at a time. The preview does not pass Comote or Codex secrets into the child process, and its port is not opened on public interfaces.

Production applications use the wildcard `*.apps.devop.my.id`, whose DNS-only A record points to this VPS. Nginx binds only to the VPS private/NAT interface address `10.0.3.25` on public ports 80/443, so Tailscale continues listening on its own address on port 443. Application processes bind to loopback ports 5200–5299 and are not opened by UFW.

## Files and ownership

- Active release: `/opt/comote/current`
- Immutable releases: `/opt/comote/releases/<git-sha>`
- Canonical development workspace: `/home/coder/projects/comote`
- Comote state: `/home/coder/.local/share/comote`
- Isolated task worktrees: `/home/coder/.local/share/comote/worktrees`
- Codex login and sessions: `/home/coder/.codex`
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

The repository uses `https://github.com/kopipes/comote.git` as its off-VPS Git remote. The VPS workspace uses a dedicated, repository-scoped SSH deploy key; that key must be registered on GitHub with write access before the explicit Push action can authenticate.
