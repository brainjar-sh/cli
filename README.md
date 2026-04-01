# brainjar

[![CI](https://github.com/brainjar-sh/brainjar-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/brainjar-sh/brainjar-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@brainjar/cli)](https://www.npmjs.com/package/@brainjar/cli)
[![downloads](https://img.shields.io/npm/dm/@brainjar/cli)](https://www.npmjs.com/package/@brainjar/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Shape how your AI thinks — soul, persona, rules.

brainjar manages AI agent behavior through composable layers. Instead of one monolithic config file, you separate **what the agent sounds like** (soul), **how it works** (persona), and **what constraints it follows** (rules). Each layer is a markdown file. Mix, match, and switch them per project, per task, or per session.

**[Documentation](https://brainjar.sh)** · **[Getting Started](https://brainjar.sh/getting-started/)**

## Quick start

```bash
# Install
bun install -g @brainjar/cli

# Initialize with starter content
brainjar init --default

# See what's active
brainjar status
```

## Concepts

| Layer | Purpose |
|-------|---------|
| **Soul** | Who the agent is — voice, character, standards |
| **Persona** | How the agent works — role, workflow, bundled rules |
| **Rules** | Behavioral constraints — guardrails that apply regardless of persona |
| **Brain** | Saved snapshot of soul + persona + rules — activate in one shot |

## Commands

```
brainjar init [--default] [--obsidian] [--backend claude|codex]
brainjar status [--sync] [--global|--local] [--short]
brainjar sync [--quiet]
brainjar compose <brain> [--task <text>]

brainjar brain save|use|list|show|drop
brainjar soul create|list|show|use|drop
brainjar persona create|list|show|use|drop
brainjar rules create|list|show|add|remove

brainjar pack export|import
brainjar hooks install|remove|status [--local]
brainjar shell [--brain|--soul|--persona|--rules-add|--rules-remove]
brainjar reset [--backend claude|codex]
brainjar server start|stop|status|logs|local|remote
brainjar migrate [--dry-run] [--skip-backup]
```

See the [CLI reference](https://brainjar.sh/reference/cli/) for full details.

## Development

Built with [Bun](https://bun.sh) and [incur](https://github.com/bradjones/incur).

```bash
bun install
bun test
bun run src/cli.ts --help
```
