# @brainjar/cli is deprecated

This package and its source repository are **deprecated and archived**.
brainjar 1.0 ships as a single Go binary at
**[brainjar-sh/brainjar](https://github.com/brainjar-sh/brainjar)**.

## Why

The TypeScript/npm distribution required Node.js, a `bun install`
toolchain, and a separate `@brainjar/server` package for the HTTP and
MCP surfaces. Consolidating into a single Go binary:

- Removes Node.js as a runtime prerequisite.
- Folds CLI and server into one program (`brainjar` and
  `brainjar serve`).
- Makes installation a one-line `curl | sh` with signed, multi-arch
  release artifacts.
- Removes the npm release channel entirely. There is no `@brainjar/`
  org package going forward.

## Migrating

1. Uninstall the npm package:

   ```sh
   npm uninstall -g @brainjar/cli
   ```

2. Install the Go binary:

   ```sh
   curl -fsSL https://get.brainjar.sh/brainjar/install.sh | sh
   ```

3. Initialize a new workspace:

   ```sh
   brainjar init
   ```

4. The data shape is different (single SQLite file, no Postgres
   server). Hand-port any souls / personas / rules you care about, or
   re-create them via the documented CLI commands. There is no
   automated migration tool.

The new binary's command surface is documented in its
[README](https://github.com/brainjar-sh/brainjar#readme) and at
`brainjar --help`.

## What stays

The npm package versions up to and including `0.7.6` remain installable
from the registry — they're just deprecated, not unpublished. Source
history, tags, and release artifacts on `brainjar-sh/cli` remain
read-only after archival.
