# Contributing to brainjar

Thanks for your interest in contributing.

## Getting started

```bash
# Clone the repo
git clone https://github.com/brainjar-sh/brainjar-cli.git
cd brainjar-cli

# Install dependencies (requires Bun)
bun install

# Run checks
bun run check
```

## Development

brainjar is built with [Bun](https://bun.sh) and TypeScript. No build step — bun runs `.ts` directly.

- `bun test` — run tests
- `bun run typecheck` — type check with tsc
- `bun run check` — both

## Making changes

1. Fork the repo and create a branch from `master`.
2. Make your changes. Keep them focused — one logical change per PR.
3. Add or update tests for any new behavior.
4. Run `bun run check` and make sure everything passes.
5. Open a pull request.

## Pull requests

- Keep PRs small and reviewable.
- Write a clear description of what changed and why.
- If your change adds a feature or fixes a bug, include a changeset:

```bash
bunx changeset
```

This creates a file in `.changeset/` describing the change and its semver impact. Commit it with your PR.

## Commit messages

Write meaningful commit messages. Say what changed and why, not just "fix bug."

## Code style

- TypeScript with strict mode.
- Keep it simple. Don't over-engineer.
- Test behavior, not implementation.

## Agentic development

This project welcomes contributions made with AI coding agents (Claude Code, Codex, etc.). Most of our own development is done this way. Here's what agents need to know.

### Toolchain

- **Runtime is bun, not node/npm.** Use `bun install`, `bun test`, `bun run check`. Never `npm` or `npx`.
- **No build step.** Bun runs TypeScript directly. The `bin` entry points to `./src/cli.ts`.
- **Typecheck with `bun run typecheck`** (runs `tsc --noEmit`). Always run before finishing.

### Architecture quick reference

```
src/
  cli.ts            # Entry point — registers all commands
  paths.ts          # Directory path constants, backend config resolution
  state.ts          # State I/O, 3-tier cascade (global → local → env), locking
  sync.ts           # Inlines active layers into CLAUDE.md / AGENTS.md
  seeds.ts          # Default content seeded by `init --default`
  commands/         # One file per command group (soul.ts, persona.ts, brain.ts, etc.)
  engines/          # Credential engine integrations (bitwarden)
```

- **State cascade:** global (`~/.brainjar/state.yaml`) → local (`.brainjar/state.yaml`) → env vars. `mergeState()` in `state.ts` handles the merge.
- **Dual output:** Commands branch on `c.agent || c.formatExplicit` — structured data for agents, compact labels for humans. Follow this pattern in new commands.
- **Sync markers:** `<!-- brainjar:start -->` / `<!-- brainjar:end -->` in CLAUDE.md. Everything outside markers is user-owned. Don't break this contract.
- **Slug validation:** All names go through `normalizeSlug()` in `state.ts`. Alphanumeric, hyphens, underscores only.
- **CLI framework:** [incur](https://github.com/bradjones/incur). Commands use `Cli.create()` with schema validation via `z`.

### Patterns to follow

- **New commands** go in `src/commands/` and get registered in `src/cli.ts`.
- **New tests** go in `tests/`. Test via CLI invocation using `cli.serve(argv, stdio)` — see existing tests for the pattern.
- **Frontmatter** in markdown layers uses `---` delimiters. Parsed by `parseLayerFrontmatter()` in `state.ts`.
- **File locking** uses `withStateLock()` / `withLocalStateLock()` for any state mutations. Don't skip this.

### Rules for agents

- **Scope control.** Only modify files related to the task. Don't refactor adjacent code, rename variables for style, or add "improvements" you weren't asked for.
- **No stubs.** Don't leave TODOs, placeholders, or "implement later" comments. Finish what you start.
- **Run `bun run check` before declaring done.** Typecheck and tests must both pass.
- **Don't create files that weren't requested.** No extra helpers, docs, or configs "for later."
- **Test new behavior.** Every new feature or bug fix gets a test. No exceptions.
- **Don't add dependencies** without discussing it first in the PR or issue.

## Reporting issues

Open an issue on GitHub. Include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, bun version, brainjar version)

## Security issues

See [SECURITY.md](SECURITY.md). Do not open public issues for security vulnerabilities.
