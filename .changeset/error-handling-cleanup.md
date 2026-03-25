---
"@brainjar/cli": patch
---

Harden error handling and clean up internals.

- Extract `readBrain` into shared module to fix inverted dependency direction
- Throw on non-ENOENT config read errors in sync instead of silently continuing
- User-friendly error message for malformed settings.json in hooks
- Remove unused hono override from package.json
