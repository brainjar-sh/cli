---
"@brainjar/cli": patch
---

fix: project scope auto-detection and sync file targeting

- Sync now writes workspace-only state to global CLAUDE.md (suppresses project auto-detection)
- Project CLAUDE.md is written automatically when in a project directory — no `--project` flag needed
- Bump MIN_SERVER_VERSION to 0.4.0 for workspace-namespaced scopes
