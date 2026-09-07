# Comote VPS deployment

This document records the active single-user deployment as of 2026-09-07. It intentionally contains no passwords, session cookies, or Tailscale authentication keys.

## Access

- Private URL: `https://comote-vps.tailb6b750.ts.net/`
- The client device must be signed in to the same Tailscale network.
- Comote then requires its own password and records the supplied device name in session and Git provenance.
- The app is installable from the browser as a PWA on a phone or laptop.

## Network topology

Tailscale Serve terminates private HTTPS and proxies to Comote on `127.0.0.1:4173`. Comote and Codex App Server have no public listener. UFW allows public SSH and allows TCP 443 only on `tailscale0`.

Nginx remains installed for future public applications, but its service is disabled and public ports 80/443 are closed. Re-enabling Nginx does not replace the private Comote route.

## Files and ownership

- Active release: `/opt/comote/current`
- Immutable releases: `/opt/comote/releases/<git-sha>`
- Canonical development workspace: `/home/coder/projects/comote`
- Comote state: `/home/coder/.local/share/comote`
- Isolated task worktrees: `/home/coder/.local/share/comote/worktrees`
- Codex login and sessions: `/home/coder/.codex`
- Root-only environment: `/etc/comote/comote.env`
- Service definition: `/etc/systemd/system/comote.service`
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

## Development continuity

All browser clients operate on the same VPS development environment. New Codex tasks use persistent isolated Git worktrees, so parallel tasks do not overwrite each other's uncommitted files; existing threads continue in their original canonical workspace. A clean, committed task branch can be merged explicitly into the canonical branch. Commits and task merges made by the Comote UI include `Requested-From`, `Developed-On`, `Assisted-By`, and `Comote-Session` trailers so the origin remains visible in Git history.

The repository uses `https://github.com/kopipes/comote.git` as its off-VPS Git remote. The VPS workspace uses a dedicated, repository-scoped SSH deploy key; that key must be registered on GitHub with write access before the explicit Push action can authenticate.
