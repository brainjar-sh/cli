# brainjar

[![CI](https://github.com/brainjar-sh/brainjar-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/brainjar-sh/brainjar-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@brainjar/cli)](https://www.npmjs.com/package/@brainjar/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Shape how your AI thinks — identity, soul, persona, rules.

brainjar manages AI agent behavior through composable layers. Instead of one monolithic config file, you separate **what the agent sounds like** (soul), **how it works** (persona), and **what constraints it follows** (rules). Each layer is a markdown file. Mix and match them per project, per task, or per session.

## Quick start

```bash
# Install
bun install -g @brainjar/cli

# Initialize with starter content
brainjar init --default

# See what's active
brainjar status
```

That gives you a soul (craftsman), a persona (engineer), and rules (boundaries, git discipline, security) — all wired into your `CLAUDE.md` and ready to go.

## Concepts

brainjar has four core concepts. Understanding these makes everything else click.

### Soul — who the agent is

The soul defines personality: tone, character, standards. It's the constant across all tasks. You probably only have one or two. Think of it as the agent's voice.

### Persona — how the agent works

Personas define role and workflow. An engineer persona works differently than a reviewer or an architect. Switch personas based on what you're doing — they're the agent's job description.

Personas bundle their own rules via frontmatter:

```yaml
---
rules:
  - default
  - security
---
```

### Rules — what the agent must follow

Rules are behavioral constraints — guardrails that apply regardless of persona. Single files or multi-file packs (directories). Rules from a persona's frontmatter activate automatically when that persona is active.

### Brain — a saved configuration

A brain is a named snapshot of soul + persona + rules. Instead of switching three things separately, save your setup once and activate it in one shot. Useful for repeatable workflows like "code review" or "design session."

### How they compose

```
soul + persona + rules = full agent behavior
      │                    │
      └── bundled rules ───┘  (from persona frontmatter)
```

A brain captures all three layers. `compose` assembles them into a single prompt for subagent dispatch.

## State cascade

State merges in three tiers. Each tier overrides the previous:

```
global  →  local  →  env
```

| Tier | Storage | When to use |
|------|---------|-------------|
| **Global** | `~/.brainjar/state.yaml` | Default behavior across all projects |
| **Local** | `.brainjar/state.yaml` (in project) | Per-project overrides |
| **Env** | `BRAINJAR_*` environment variables | Per-session or CI overrides |

```bash
# Global (default for all projects)
brainjar persona use engineer

# Local (this project only)
brainjar persona use planner --local

# Env (this session only)
BRAINJAR_PERSONA=reviewer claude

# Or use a subshell for scoped sessions
brainjar shell --persona reviewer --rules-add security
```

`brainjar status` shows where each setting comes from:

```
soul     craftsman (global)
persona  planner (local)
rules    default (global), security (+local)
```

### Scope annotations

When you see scope labels in `status` and `rules list` output:

| Label | Meaning |
|-------|---------|
| `(global)` | Set in `~/.brainjar/state.yaml` |
| `(local)` | Overridden in `.brainjar/state.yaml` |
| `(+local)` | Added by local override (not in global) |
| `(-local)` | Removed by local override (active globally, suppressed here) |
| `(env)` | Overridden by `BRAINJAR_*` env var |
| `(+env)` | Added by env var |
| `(-env)` | Removed by env var |

### Environment variables

These env vars override all other state when set:

| Variable | Effect |
|----------|--------|
| `BRAINJAR_HOME` | Override `~/.brainjar/` location |
| `BRAINJAR_SOUL` | Override active soul |
| `BRAINJAR_PERSONA` | Override active persona |
| `BRAINJAR_IDENTITY` | Override active identity |
| `BRAINJAR_RULES_ADD` | Comma-separated rules to add |
| `BRAINJAR_RULES_REMOVE` | Comma-separated rules to remove |

Set to empty string to explicitly unset (e.g., `BRAINJAR_SOUL=""` removes the soul for that session).

## What it does

```
~/.brainjar/
  souls/            # Voice and character — who the agent is
    craftsman.md
  personas/         # Role and workflow — how the agent works
    engineer.md
    planner.md
    reviewer.md
  rules/            # Constraints — what the agent must follow
    default/        # Boundaries, context recovery, task completion
    git-discipline.md
    security.md
  brains/           # Full-stack snapshots — soul + persona + rules
    review.yaml
```

brainjar reads these markdown files, merges the active layers, and inlines them into your agent's config (`~/.claude/CLAUDE.md` or `.codex/AGENTS.md`) between `<!-- brainjar:start -->` / `<!-- brainjar:end -->` markers. Everything outside the markers is yours. Change a layer, and the agent's behavior changes on next sync.

## Layers

### Soul

```bash
brainjar soul create mysoul --description "Direct and rigorous"
brainjar soul use mysoul
```

### Persona

```bash
brainjar persona use planner    # Design session
brainjar persona use engineer   # Build session
brainjar persona use reviewer   # Review session
```

### Rules

```bash
brainjar rules create no-delete --description "Never delete files without asking"
brainjar rules add no-delete
brainjar rules remove no-delete
```

### Brain

```bash
brainjar brain save review           # Snapshot current state as a brain
brainjar brain use review            # Activate soul + persona + rules in one shot
brainjar brain list                  # See available brains
brainjar brain show review           # Inspect a brain's config
```

When to use a brain vs. switching layers individually:
- **Brain:** Repeatable workflow you do often (code review, design, debugging). Save once, activate in one command.
- **Individual layers:** Exploratory work, one-off overrides, or when you only need to change one thing.

## Subagent orchestration

Personas can spawn other personas as subagents. For example, a tech-lead persona can:

1. Spawn an **architect** subagent for design — produces a design doc
2. Get user approval
3. Implement the design itself
4. Spawn a **reviewer** subagent to verify — compares code against the spec

Each subagent gets the full brain context: soul + persona + rules. The `compose` command assembles the full prompt in a single call:

```bash
# Primary path — brain drives everything
brainjar compose review --task "Review the changes in src/sync.ts"

# Ad-hoc — no saved brain, specify persona directly
brainjar compose --persona reviewer --task "Review the changes in src/sync.ts"
```

For more granular control, use `brainjar persona show <name>` and `brainjar rules show <name>` to retrieve individual layers.

## Recipes

### Code review session

```bash
# Save a review brain once
brainjar soul use craftsman
brainjar persona use reviewer
brainjar rules add default
brainjar rules add security
brainjar brain save review

# Then activate it anytime
brainjar brain use review

# Or scope it to a single session
brainjar shell --brain review
```

### CI pipeline — enforce rules without a persona

```bash
# In CI, use env vars to override behavior
BRAINJAR_PERSONA=auditor BRAINJAR_RULES_ADD=security,compliance brainjar status --sync
```

### Project-specific persona

```bash
# In your project directory
brainjar persona use planner --local
brainjar rules add no-delete --local

# Global settings still apply — local just overrides what you specify
brainjar status
# soul     craftsman (global)
# persona  planner (local)
# rules    default (global), no-delete (+local)
```

## Pack

Packs are self-contained, shareable bundles of a brain and all its layers — soul, persona, and rules. Export a brain as a pack directory, hand it to a teammate, and they import it in one command.

A pack mirrors the `~/.brainjar/` structure with a `pack.yaml` manifest at the root. No tarballs, no magic — just files you can inspect with `ls` and `cat`.

```bash
# Export a brain as a pack
brainjar pack export review                        # creates ./review/
brainjar pack export review --out /tmp             # creates /tmp/review/
brainjar pack export review --name my-review       # override pack name
brainjar pack export review --version 1.0.0        # set version (default: 0.1.0)
brainjar pack export review --author frank         # set author field

# Import a pack
brainjar pack import ./review                      # import into ~/.brainjar/
brainjar pack import ./review --force              # overwrite conflicts
brainjar pack import ./review --merge              # rename conflicts as <name>-from-<packname>
brainjar pack import ./review --activate           # activate the brain after import
```

On conflict (a file already exists with different content), import fails by default and lists the conflicts. Use `--force` to overwrite or `--merge` to keep both versions. Identical files are silently skipped.

## Hooks

brainjar integrates with Claude Code's hook system for automatic context injection. When hooks are installed, brainjar syncs your config on every session start — no manual `brainjar sync` needed.

```bash
# Install hooks (writes to ~/.claude/settings.json)
brainjar hooks install

# Install for this project only
brainjar hooks install --local

# Check hook status
brainjar hooks status

# Remove hooks
brainjar hooks remove
```

## Commands

```
brainjar init [--default] [--obsidian] [--backend claude|codex]
brainjar status [--sync] [--global|--local] [--short]
brainjar sync [--quiet]
brainjar compose <brain> [--task <text>]
brainjar compose --persona <name> [--task <text>]

brainjar brain save|use|list|show|drop
brainjar soul create|list|show|use|drop
brainjar persona create|list|show|use|drop
brainjar rules create|list|show|add|remove

brainjar identity create|list|show|use|drop|unlock|get|status|lock
brainjar pack export|import
brainjar hooks install|remove|status [--local]
brainjar shell [--brain|--soul|--persona|--identity|--rules-add|--rules-remove]
brainjar reset [--backend claude|codex]
```

`show` accepts an optional name to view any item, not just the active one. Use `--short` to get just the active name (useful in scripts and statuslines):

```bash
brainjar persona show reviewer    # View a specific persona
brainjar soul show                # View the active soul
brainjar rules show security      # View a rule's content
brainjar status --short           # One-liner: soul | persona | identity
brainjar soul show --short        # Just the active soul name
```

## Obsidian support

`~/.brainjar/` is a folder of markdown files — it's already almost an Obsidian vault.

```bash
brainjar init --obsidian
```

Adds `.obsidian/` config that hides private files (state, identities) from the file explorer and includes templates for creating new souls, personas, and rules from within Obsidian.

## Backends

```bash
brainjar init --backend codex      # writes ~/.codex/AGENTS.md
brainjar reset --backend codex
```

Supported: `claude` (default), `codex`

## Backup & restore

On first sync, brainjar backs up any existing config file to `CLAUDE.md.pre-brainjar`. Running `brainjar reset` removes brainjar-managed config and restores the backup.

## Development

Built with [Bun](https://bun.sh) and [incur](https://github.com/bradjones/incur).

```bash
bun install
bun test
bun run src/cli.ts --help
```
