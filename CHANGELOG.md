# brainjar

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
