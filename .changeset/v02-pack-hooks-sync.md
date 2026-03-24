---
"@brainjar/cli": minor
---

Pack export/import, hooks management, and standalone sync command.

- **Pack export/import** — bundle a brain and all its layers (soul, persona, rules) into a self-contained directory with a `pack.yaml` manifest. Import with conflict detection, `--force` overwrite, or `--merge` rename strategies. Path traversal protection on untrusted manifests.
- **Hooks management** — `brainjar hooks install|remove|status` to manage Claude Code SessionStart sync hooks, with `--local` for project-scoped installation.
- **Standalone sync** — `brainjar sync` command for manual config regeneration outside of hooks.
- **Session token stdin** — `identity unlock` reads session token from stdin when piped, eliminating shell history and procfs exposure.
