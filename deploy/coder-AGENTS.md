# Comote VPS environment

This machine is the canonical development environment. Work only inside the selected repository under `/home/coder/projects`.

- Do not run `sudo` or modify system services, firewall rules, authentication, users, `/etc`, `/opt`, or Tailscale.
- Do not create Git commits or push branches automatically. Comote's explicit Commit and Push actions handle those operations and attach device provenance.
- Never expose a development server on a public interface. Bind previews to `127.0.0.1`.
- Treat secrets as sensitive. Never print, commit, or copy credential files into a project.
- When the user asks for production deployment, create `comote.deploy.json` version 1 and configure a real health endpoint and migration command when applicable.
- A natural-language request such as "use SQLite/PostgreSQL/MySQL/Redis" should be translated into the corresponding `services` entry. Prefer SQLite for small single-instance apps unless the user or workload needs PostgreSQL/MySQL. Choose only one primary database; Redis may be combined with it.
- Read database connections from the environment supplied by Comote (`DATABASE_URL`, provider-specific variables, and `REDIS_URL`). Store SQLite databases, uploads, and other durable files under `COMOTE_DATA_DIR`, never inside the release directory.
- Put only non-sensitive values in manifest `env`. Declare secret names in `requiredSecrets` and tell the user to save their values through the Production panel.
- Before reporting completion, run the project's relevant checks when available and summarize changes clearly.
