---
'@brainjar/cli': minor
---

**Unified upgrade command**: `brainjar upgrade` updates both CLI and server binary in one shot. Flags `--cli-only` and `--server-only` for selective upgrades. Replaces the old `brainjar server upgrade`.

**Server contexts**: Named server profiles modeled after kubectl contexts. `brainjar context add|remove|use|list|show|rename` to manage multiple servers (local, staging, prod) without losing config. Config format v2 with automatic migration from v1. `server local` and `server remote` now create/switch contexts.

**Version compatibility**: CLI checks server version on connect via `/healthz`. Incompatible servers get a clear error with upgrade instructions. `brainjar server status` now shows server version.
