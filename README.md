# brainjar

[![CI](https://github.com/brainjar-sh/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/brainjar-sh/cli/actions/workflows/ci.yml)
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
brainjar init [--default] [--backend claude|codex]
brainjar status [--sync] [--workspace] [--project] [--short]
brainjar sync [--quiet]
brainjar compose <brain> [--persona <name>] [--task <text>]

brainjar brain save|use|list|show|drop
brainjar soul create|use|show|list|drop
brainjar persona create|use|show|list|drop
brainjar rules create|add|remove|show|list

brainjar pack export|import
brainjar hooks install|remove|status [--local]
brainjar shell [--brain <name>] [--soul <name>] [--persona <name>]
brainjar reset [--backend claude|codex]
brainjar server start|stop|status|logs|local|remote|upgrade
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
