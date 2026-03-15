# Audit: OSS Readiness

**Date:** 2026-03-15
**Version:** v0.1.0
**Scope:** Full codebase review — architecture, security, complexity, OSS launch readiness, code quality

---

## Executive Summary

brainjar-cli is in strong shape for an open-source launch. The codebase is lean (two runtime deps), well-tested (217 tests, strict TypeScript), and the contributor experience is above average (good README, CONTRIBUTING.md, issue templates, CI matrix).

Three items need attention before going public:

1. **One confirmed bug** — env-scoped rule removal silently ignored in local sync (`sync.ts:116`).
2. **Org name mismatch** — local repo uses `brainjar-sh`, published URLs reference `brainjar-dev`. Breaks npm provenance and trust signals.
3. **Empty CHANGELOG** — v0.1.0 shipped with no changelog entry.

Everything else is improvement work that can ship incrementally post-launch.

---

## Architecture

**Reviewer:** Architect

### Strengths

| # | Finding |
|---|---|
| 1 | Clean separation between state model (`state.ts`) and output generation (`sync.ts`). Neither leaks into the other. `mergeState` backed by 25+ pure unit tests. |
| 2 | Well-defined extensibility interface for credential engines. `CredentialEngine` is a lean 3-method interface with a registry pattern. Adding a vault backend requires implementing the interface and registering it. |
| 3 | Defense-in-depth on path traversal. `normalizeSlug` called consistently before filesystem access. |

### Risks

| # | Severity | Finding |
|---|---|---|
| 1 | Medium | `state.ts` is a god module (445 lines) — slug validation, frontmatter parsing, global/local/env state CRUD, merge algorithm, file locking, identity loading, rule resolution. Recommend splitting into `state/model.ts`, `state/merge.ts`, `state/locks.ts`, `state/layers.ts`. |
| 2 | Medium | Single credential engine with no plugin loading path. `engines/index.ts` hardcodes bitwarden. The interface is good but the registry blocks community contribution without forking. |
| 3 | Low | `seeds.ts` embeds all default content (personas, rules, soul) as TypeScript string literals. Contributors can't propose changes to defaults via clean `.md` file PRs. |

---

## Security

**Reviewer:** Auditor

No hardcoded secrets found. No SQL or template injection. Session token redacted in status output.

| ID | Severity | Location | Issue |
|---|---|---|---|
| 001 | Medium | `sync.ts:72`, `state.ts:153` | `backend` field read from `state.yaml` without enum validation before cast to `Backend`. |
| 002 | Medium | `commands/identity.ts:81-88` | `identity list` uses raw filesystem filenames as slugs without `SLUG_RE` validation. |
| 003 | Low | `commands/shell.ts:80` | `$SHELL` env var used as executable path without validation. |
| 004 | Low | `commands/rules.ts:243-244` | `rules remove` skips `normalizeSlug`; dirty value written transiently to disk. |
| 005 | Low | `engines/bitwarden.ts:29-31` | `bw get item` input has weak character set validation (safe due to Bun shell escaping). |
| 006 | Low | `commands/identity.ts:232` | `~/.brainjar/` directory may have loose permissions; `BRAINJAR_HOME` can redirect token writes. |
| 007 | Info | `paths.ts:6,10,35` | All path roots overridable via env vars with no sanitization. |
| 008 | Info | `state.ts:37-48` | Rule directory file iteration follows symlinks. |

---

## Complexity

**Reviewer:** Minimalist
**Overall score:** 4/10 (lean)

| Issue | File(s) | Severity |
|---|---|---|
| Duplicated lock function (33 lines each) | `state.ts` L172 & L342 | Medium |
| `EnvState` is alias for `LocalState` | `state.ts` L233 | Low |
| `engines/` over-abstracted for 1 engine | `src/engines/` | Low |
| `inlineSoul`/`inlinePersona` duplication | `sync.ts` L15-31 | Low |
| `dist/cli.js` stale artifact | `dist/cli.js` | Low |
| `show` command pattern repeated 3x | `soul.ts`, `persona.ts`, `identity.ts` | Low |

Two runtime dependencies (`incur`, `yaml`). Clean dependency footprint.

---

## OSS Readiness

**Reviewer:** OSS Lead
**Score:** 7.5/10

### What's solid

- LICENSE (MIT)
- README (excellent)
- CONTRIBUTING.md (includes agentic dev section)
- SECURITY.md
- CI matrix
- Issue and PR templates

### Top 5 fixes before going public

| # | Priority | Issue |
|---|---|---|
| 1 | Blocker | **Org name mismatch** — local repo is `brainjar-sh`, all URLs point to `brainjar-dev`. Breaks npm provenance, `npm repo`, trust. |
| 2 | High | **Empty CHANGELOG.md** — v0.1.0 shipped but changelog says nothing. |
| 3 | Medium | **CODE_OF_CONDUCT.md** — stub that links out. No enforcement contact. |
| 4 | Medium | **No `npm publish` in release CI** — changesets create GitHub releases but nothing pushes to npm. |
| 5 | Low | **`incur` dependency risk** — obscure CLI framework with no visible community. Needs disclosure note. |

---

## Code Quality

**Reviewer:** Reviewer
**Verdict:** COMMENT (not blocking, but issues to address)

217 tests pass. TypeScript strict mode clean.

### Bugs

| Severity | Location | Issue |
|---|---|---|
| Blocker | `sync.ts:116`, `status.ts:117`, `rules.ts:124` | Local-mode rule filter uses `r.scope !== '-local'` instead of `!r.scope.startsWith('-')`. Env-scoped rule removals silently ignored in local sync. |
| Warning | `rules.ts:243` | `rules remove` skips `normalizeSlug` in `--local` path. |

### Inconsistencies

- `state.ts:153` — `backend` uses `||` (falsy coercion) while all other fields use `safeName()` / `?? null`.
- `(parsed as any)` repeated 6x in `readState` vs clean `Record<string, unknown>` pattern in `readLocalState`.

### Missing test coverage

- No test for env-scoped rule removal in local sync — would have caught the blocker bug.

### What's good

- `normalizeSlug` applied consistently across the codebase.
- Lock implementation is correct.
- Atomic writes via temp file + rename.
- Error messages include actionable hints.
- `readEnvState` is pure.

---

## Cross-Agent Consensus

Findings independently discovered by multiple agents carry higher confidence.

| Finding | Discovered by |
|---|---|
| `rules remove` skips `normalizeSlug` | Auditor, Reviewer |
| `state.ts` is overloaded / god module | Architect, Minimalist |
| Seed content as TS string literals limits contribution | Architect, Minimalist |

---

## Prioritized Action Items

### Before launch

| # | Item | Source | Effort |
|---|---|---|---|
| 1 | Fix env-scoped rule removal bug in `sync.ts:116`, `status.ts:117`, `rules.ts:124` | Reviewer | Small |
| 2 | Add regression test for env-scoped rule removal in local sync | Reviewer | Small |
| 3 | Resolve org name mismatch (`brainjar-sh` vs `brainjar-dev`) | OSS Lead | Small |
| 4 | Populate CHANGELOG.md for v0.1.0 | OSS Lead | Small |
| 5 | Validate `backend` field against enum before casting | Auditor | Small |
| 6 | Apply `normalizeSlug` in `rules remove --local` path | Auditor, Reviewer | Small |

### Post-launch improvements

| # | Item | Source | Effort |
|---|---|---|---|
| 7 | Split `state.ts` into `state/` module directory | Architect, Minimalist | Medium |
| 8 | Deduplicate lock functions in `state.ts` | Minimalist | Small |
| 9 | Add `SLUG_RE` validation to `identity list` filesystem reads | Auditor | Small |
| 10 | Add enforcement contact to CODE_OF_CONDUCT.md | OSS Lead | Small |
| 11 | Add `npm publish` step to release CI | OSS Lead | Medium |
| 12 | Extract seed content from TS literals to `.md` files | Architect | Medium |
| 13 | Design plugin loading path for credential engines | Architect | Large |
| 14 | Add `incur` dependency disclosure note | OSS Lead | Small |
