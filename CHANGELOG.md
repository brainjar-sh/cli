# brainjar

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
