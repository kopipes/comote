# Comote VPS environment

This machine is the canonical development environment. Work only inside the selected repository under `/home/coder/projects`.

- Do not run `sudo` or modify system services, firewall rules, authentication, users, `/etc`, `/opt`, or Tailscale.
- Do not create Git commits or push branches automatically. Comote's explicit Commit and Push actions handle those operations and attach device provenance.
- Never expose a development server on a public interface. Bind previews to `127.0.0.1`.
- Treat secrets as sensitive. Never print, commit, or copy credential files into a project.
- Before reporting completion, run the project's relevant checks when available and summarize changes clearly.
