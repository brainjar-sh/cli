# brainjar — Agent Guide

This document is for AI coding agents that interact with brainjar. It describes the CLI, its purpose, and how to use it on behalf of the operator.

## What brainjar does

brainjar manages composable configuration layers for coding agents. The operator uses it to control your personality (soul), role behavior (persona), and behavioral rules. All layer content lives in `~/.brainjar/`. The CLI reads active layers and inlines them into a single config file (e.g. `~/.claude/CLAUDE.md`).

## Key concepts

- **Soul** — your personality and values. Markdown content stored on the brainjar server. One active at a time.
- **Persona** — role behavior and workflow. Markdown content on the server. One active at a time. Personas can bundle default rules.
- **Rules** — behavioral constraints. Multiple can be active simultaneously. Markdown content on the server.
- **Brain** — saved snapshot of soul + persona + rules. Activate in one shot.
- **State** — tracks which soul, persona, and rules are active (workspace and project scopes).
- **Backend** — the agent platform being configured (e.g. `claude`, `codex`). Only relevant for `init` and `reset`.

## Discovering commands

Every command is self-describing:

```bash
brainjar --help                  # list all commands
brainjar soul --help             # list soul subcommands
brainjar soul create --help      # see args and options
brainjar --llms                  # full machine-readable manifest
```

## Common workflows

### First-time setup

```bash
brainjar init --default
brainjar status
```

### Check current state

```bash
brainjar status
```

### Switching contexts

```bash
brainjar soul use thorough-and-cautious
brainjar persona use reviewer
brainjar rules remove verbose-explanations
brainjar status
```

### Using brains

Brains are named snapshots of soul + persona + rules. Use them for repeatable context switches:

```bash
brainjar brain list                       # see available brains
brainjar brain show review                # inspect a brain's config
brainjar brain use review                 # activate soul + persona + rules in one shot
brainjar brain save my-workflow           # snapshot current state as a brain
brainjar brain drop old-workflow          # delete a brain
```

### Project-level overrides

Use `--project` to write to `.brainjar/state.yaml` in the current project, overriding workspace config:

```bash
brainjar persona use reviewer --project
brainjar rules add security --project
```

### Viewing specific layers

```bash
brainjar persona show reviewer    # view any persona by name
brainjar soul show                # view the active soul
brainjar rules show security      # view a rule's content
brainjar status --short           # one-liner: soul | persona
brainjar soul show --short        # just the active soul name
```

### Spawning subagents

Use `compose` to assemble the full subagent prompt in a single call. A **brain** is a named snapshot of soul + persona + rules:

```bash
# Primary path — brain drives everything
brainjar compose review --task "Review the auth changes"

# Ad-hoc — no saved brain, specify persona directly
brainjar compose --persona architect --task "Analyze the auth module and write a design doc"
```

This returns the soul + persona + rules + optional task context, ready to pass as a subagent prompt.

For more granular control, retrieve layers individually:

```bash
brainjar soul show                    # get active soul
brainjar persona show architect       # get persona content + its bundled rules
brainjar rules show boundaries        # get rule content
```

## Important notes

- Sync runs automatically after mutating operations (use, drop, add, remove). You rarely need to trigger it manually (`brainjar status --sync`).
- `persona use` replaces the current rule set with the persona's declared rules from frontmatter.
- `brainjar reset [--backend claude|codex]` removes the generated config from the backend and restores any backup. Only suggest this if the operator wants to uninstall brainjar.
- Layer content is inlined into the config file — no symlinks or external file references.
- State merges in three layers: global → local → env. `brainjar status` shows where each setting comes from.

## Contributing to brainjar

If you're working on brainjar itself (not just using it), see [CONTRIBUTING.md](CONTRIBUTING.md) for architecture, toolchain, testing patterns, and agentic development guidelines.
