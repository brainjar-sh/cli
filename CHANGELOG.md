# brainjar

## 0.4.0

### Minor Changes

- 9b2c04f: Thin-client architecture: all content (souls, personas, rules, brains, state) moved from local filesystem to brainjar server API. The CLI is now a lightweight client that talks to either a managed local server (auto-downloaded, embedded Postgres) or a remote server.

  **Server management**: `brainjar server start|stop|status|logs|local|remote|upgrade` for full lifecycle control. Binary distribution via get.brainjar.sh with tarball downloads, SHA-256 checksum verification, and dynamic version resolution. Version tracking and update banner plumbing ready for next incur release.

  **Migration**: `brainjar migrate` imports existing filesystem-based content into the server.

  **Init overhaul**: `brainjar init` now downloads the server binary, starts it, creates the workspace, and seeds content via API. Seed rules flattened from a single "default" pack into individual rules (boundaries, context-recovery, task-completion, git-discipline, security).

  **Other changes**: centralized error codes with typed constants, pack export/import, hooks management, standalone sync command, remote mode fixes, workspace auto-creation, stale docs cleanup.

## 0.3.0

### Minor Changes

- 6465813: Remove identity feature (commands, credential engines, state fields). brainjar now focuses on prompt composition: soul, persona, rules, brain. Identity and credential management will live in a separate tool.

  **Breaking:** `brainjar identity` commands, `--identity` shell flag, and `BRAINJAR_IDENTITY` env var are removed. Existing `identity` fields in state.yaml are silently ignored and cleaned up on next write.

## 0.2.2

### Patch Changes

- 5125ea7: Remove audit job from CI (transitive dep vulnerabilities shouldn't block builds). Add npm downloads badge to README.

## 0.2.1

### Patch Changes

- 04e674a: Harden error handling and clean up internals.

  - Extract `readBrain` into shared module to fix inverted dependency direction
  - Throw on non-ENOENT config read errors in sync instead of silently continuing
  - User-friendly error message for malformed settings.json in hooks
  - Remove unused hono override from package.json

## 0.2.0

### Minor Changes

- bd06ab4: Pack export/import, hooks management, and standalone sync command.

  - **Pack export/import** — bundle a brain and all its layers (soul, persona, rules) into a self-contained directory with a `pack.yaml` manifest. Import with conflict detection, `--force` overwrite, or `--merge` rename strategies. Path traversal protection on untrusted manifests.
  - **Hooks management** — `brainjar hooks install|remove|status` to manage Claude Code SessionStart sync hooks, with `--local` for project-scoped installation.
  - **Standalone sync** — `brainjar sync` command for manual config regeneration outside of hooks.
  - **Session token stdin** — `identity unlock` reads session token from stdin when piped, eliminating shell history and procfs exposure.

## 0.1.0

Composable agent configuration — identity, soul, persona, and rules as separate markdown layers that merge into a single agent config.

### Features

- **Soul, persona, rules** — three composable layers that define agent behavior
- **Brain snapshots** — save and activate full soul + persona + rules configurations in one shot
- **State cascade** — global → local → env, each tier overrides the previous
- **`compose` command** — assemble a full subagent prompt from a brain or ad-hoc persona
- **`shell` command** — scoped subshell with `BRAINJAR_*` env vars
- **Identity & credential engine** — Bitwarden integration for secure credential access
- **Obsidian support** — `init --obsidian` sets up vault-friendly config
- **Dual backend** — writes to `CLAUDE.md` (default) or `AGENTS.md` (codex)
- **Marker-based sync** — `<!-- brainjar:start/end -->` preserves user content outside managed sections
- **Default seed content** — `init --default` scaffolds a starter soul, personas, and rules
