# Design: Phase 3 — State and Sync

Converts state management and sync from filesystem to server API. After this phase, `state.yaml` and `.brainjar/state.yaml` are dead. The server owns the scope chain. The CLI writes `CLAUDE.md` from server-composed content.

## 1. State Resolution

### Before

Every command that needs effective state runs this chain in the CLI:

```
readState()         → parse ~/.brainjar/state.yaml
readLocalState()    → parse .brainjar/state.yaml (cwd)
readEnvState()      → parse BRAINJAR_SOUL, BRAINJAR_PERSONA, BRAINJAR_RULES_ADD, BRAINJAR_RULES_REMOVE
mergeState(g, l, e) → apply overrides: global → local → env
```

Result: `EffectiveState` with scope annotations (`global`, `local`, `+local`, `-local`, `env`, `+env`, `-env`).

### After

Single API call replaces the entire chain:

```
GET /api/v1/state
Headers:
  X-Brainjar-Workspace: {config.workspace}
  X-Brainjar-Project: {basename(cwd)}   — only if .brainjar/ dir exists in cwd
  X-Brainjar-Session: {BRAINJAR_SESSION} — only if set (brainjar shell)
```

Response shape (new type `ApiEffectiveState`):

```json
{
  "soul": { "slug": "straight-shooter", "scope": "workspace" },
  "persona": { "slug": "cto", "scope": "project" },
  "rules": [
    { "slug": "default", "scope": "workspace" },
    { "slug": "git-discipline", "scope": "+project" }
  ]
}
```

The client already sends `X-Brainjar-Workspace` and `X-Brainjar-Project` headers (see `src/client.ts` lines 67-75). No new header logic needed. The `X-Brainjar-Project` header value is already `basename(cwd)` when a local `.brainjar/` dir exists (`detectProject()` at line 42).

**Env state removal:** `readEnvState()` and the `BRAINJAR_SOUL`, `BRAINJAR_PERSONA`, `BRAINJAR_RULES_ADD`, `BRAINJAR_RULES_REMOVE` env vars are removed. Per the design doc section 6: session scope (via `brainjar shell`) covers per-shell overrides. Config-level env vars (`BRAINJAR_SERVER_URL`, `BRAINJAR_WORKSPACE`, `BRAINJAR_BACKEND`) stay — those configure the CLI itself, not content state.

### New helper function

Add to `src/state.ts`:

```typescript
export async function getEffectiveState(api: BrainjarClient): Promise<ApiEffectiveState>
```

This is a thin wrapper around `api.get<ApiEffectiveState>('/api/v1/state')`. It exists so every command has one call site instead of repeating the path string.

## 2. State Mutations

### Before

Every `use`/`drop`/`add`/`remove` command follows this pattern:

```typescript
// Workspace scope (default)
await withStateLock(async () => {
  const state = await readState()
  state.soul = name       // mutate
  await writeState(state)
})

// Project scope (--local flag)
await withLocalStateLock(async () => {
  const local = await readLocalState()
  local.soul = name       // mutate
  await writeLocalState(local)
})
```

### After

Replace with a single `PUT /api/v1/state` call. The scope is determined by headers, not by which file you write to.

**Workspace scope** (default — no `--local`/`--project` flag):

```
PUT /api/v1/state
Headers: X-Brainjar-Workspace: {workspace}
Body: { "soul_slug": "straight-shooter" }
```

**Project scope** (`--local`/`--project` flag):

```
PUT /api/v1/state
Headers: X-Brainjar-Workspace: {workspace}, X-Brainjar-Project: {basename(cwd)}
Body: { "soul_slug": "straight-shooter" }
```

The client's `RequestOptions` already supports a `project` field (line 22 of `src/client.ts`). For project-scoped mutations, pass `{ project: basename(process.cwd()) }` in the request options to force the header even if no `.brainjar/` dir exists locally.

### Mutation body shapes by command

| Command | Body |
|---|---|
| `soul use X` | `{ "soul_slug": "X" }` |
| `soul drop` | `{ "soul_slug": null }` |
| `persona use X` | `{ "persona_slug": "X", "rule_slugs": ["bundled1", ...] }` |
| `persona drop` | `{ "persona_slug": null }` |
| `rules add X` | `{ "rules_to_add": ["X"] }` |
| `rules remove X` | `{ "rules_to_remove": ["X"] }` |
| `brain use X` | `{ "soul_slug": "S", "persona_slug": "P", "rule_slugs": ["R1", ...] }` |

No locks needed. The server handles concurrency. `withStateLock` and `withLocalStateLock` are deleted.

### New helper function

Add to `src/state.ts`:

```typescript
export async function putState(
  api: BrainjarClient,
  body: ApiStateMutation,
  options?: { project?: string }
): Promise<void>
```

### Flag rename: `--local` becomes `--project`

The `--local` flag on `use`/`drop`/`add`/`remove` commands maps to project scope. The flag name should change to `--project` to match the server model. No backward compatibility alias for `--local`.

## 3. Sync

### Before

`sync()` in `src/sync.ts` (172 lines):

1. Read effective state from filesystem
2. Read `.md` files from `~/.brainjar/souls/`, `personas/`, `rules/` directories
3. Assemble markdown sections (soul header, persona header, rule blocks)
4. Splice between `<!-- brainjar:start -->` / `<!-- brainjar:end -->` markers
5. Write to `CLAUDE.md`

### After

Sync is purely client-side. The CLI fetches state and content from the server, then assembles and writes `CLAUDE.md` locally:

```
1. GET /api/v1/state → { soul: {slug: "S"}, persona: {slug: "P"}, rules: [{slug: "R1"}, ...] }
2. GET /api/v1/souls/S → { content: "..." }
3. GET /api/v1/personas/P → { content: "..." }
4. GET /api/v1/rules/R1 → { entries: [{content: "..."}, ...] }
   GET /api/v1/rules/R2 → ...
5. Assemble sections locally (same section headers: ## Soul, ## Persona, rule content)
6. Splice into CLAUDE.md between markers (unchanged logic)
```

**What stays in the CLI:**
- `MARKER_START`, `MARKER_END` constants
- `parseMarkers()` — marker detection and content extraction
- The marker-based splice logic (lines 126-160 of `src/sync.ts`)
- File backup on first-time takeover
- Writing to the correct backend config file (`getBackendConfig()`)

**What gets deleted from `src/sync.ts`:**
- `inlineSoul()` — replaced by server content fetch
- `inlinePersona()` — replaced by server content fetch
- `inlineRules()` — replaced by server content fetch
- All imports from `src/state.ts` (`readState`, `readLocalState`, `readEnvState`, `mergeState`)
- The `resolveRuleContent` import

**New `sync()` signature:**

```typescript
export interface SyncOptions {
  backend?: Backend
  project?: boolean  // renamed from "local"
}

export async function sync(options?: SyncOptions): Promise<SyncResult>
```

The `envOverrides` field is removed (env state is gone). The `local` field is renamed to `project`.

### Sync for `--project`

When `project: true`, the CLI:
1. Sends `X-Brainjar-Project` header to all API calls
2. Writes to `.claude/CLAUDE.md` in cwd (same as today)
3. Only includes layers that are overridden at project scope (the server's response will indicate this via scope annotations; the CLI can compare workspace vs. project state to determine what to write)

Simpler approach for phase 3: when `project: true`, always write the full composed prompt to the local file. The server handles scope resolution — the CLI doesn't need to diff scopes.

## 4. Status Command

### Before (`src/commands/status.ts`)

```typescript
const global = await readState()
const local = await readLocalState()
const env = readEnvState()
const effective = mergeState(global, local, env)
```

### After

```typescript
const api = await getApi()
const state = await getEffectiveState(api)
```

**`--global` flag becomes `--workspace`:**

```
GET /api/v1/state/override
Headers: X-Brainjar-Workspace only (no project)
```

Returns only the workspace-level override, not the resolved chain.

**`--local` flag becomes `--project`:**

```
GET /api/v1/state/override
Headers: X-Brainjar-Workspace + X-Brainjar-Project
```

Returns only the project-level override.

**`--short` flag:**

```typescript
const state = await getEffectiveState(api)
const parts = [
  `soul: ${state.soul?.slug ?? 'none'}`,
  `persona: ${state.persona?.slug ?? 'none'}`,
]
return parts.join(' | ')
```

**`--sync` flag:**

Calls the new `sync()` (which is now server-backed) instead of the old filesystem sync.

**Default output (human-readable):**

Scope annotations come directly from the server response. No client-side scope tracking. The CLI formats them the same way:

```
soul: straight-shooter (workspace)
persona: cto (project)
rules: default (workspace), git-discipline (+project)
```

### Before/after for `brainjar status`

**Before (status.ts line 61-75):**
```typescript
const global = await readState()
const local = await readLocalState()
const env = readEnvState()
const effective = mergeState(global, local, env)
// ... format effective.soul.value, effective.soul.scope, etc.
```

**After:**
```typescript
const api = await getApi()
const state = await getEffectiveState(api)
// ... format state.soul.slug, state.soul.scope, etc.
```

## 5. Reintroducing Sync in use/drop/add/remove

Phase 2 removed `sync()` calls from mutation commands (marked with `// sync() removed — phase 3` comments). These need to come back, now calling the server-backed sync.

### Pattern for every mutation command

```typescript
// soul use
async run(c) {
  const api = await getApi()
  const name = normalizeSlug(c.args.name, 'soul name')

  // Validate exists
  await api.get<ApiSoul>(`/api/v1/souls/${name}`)

  // Mutate state on server
  const mutationOpts = c.options.project
    ? { project: basename(process.cwd()) }
    : undefined
  await putState(api, { soul_slug: name }, mutationOpts)

  // Sync CLAUDE.md
  await sync({ project: false })
  if (c.options.project) {
    await sync({ project: true })
  }

  return { activated: name, project: c.options.project }
}
```

### What gets removed from mutation commands

All filesystem state operations:
- `requireBrainjarDir()` — server validates workspace existence
- `withStateLock(async () => { ... })` — server handles concurrency
- `readState()` / `readLocalState()` / `writeState()` / `writeLocalState()` — replaced by `putState()`
- `readEnvState()` / `mergeState()` — replaced by `getEffectiveState()`

### Commands that get sync() reintroduced

| File | Commands | Sync calls |
|---|---|---|
| `src/commands/soul.ts` | `use`, `drop` | `sync()` + `sync({project: true})` if project flag |
| `src/commands/persona.ts` | `use`, `drop` | Same |
| `src/commands/rules.ts` | `add`, `remove` | Same |
| `src/commands/brain.ts` | `use` | Same |

### Before/after: `soul use` (representative)

**Before (`src/commands/soul.ts` lines 161-177):**
```typescript
if (c.options.local) {
  await withLocalStateLock(async () => {
    const local = await readLocalState()
    local.soul = name
    await writeLocalState(local)
    // sync() removed — phase 3
  })
} else {
  await withStateLock(async () => {
    const state = await readState()
    state.soul = name
    await writeState(state)
    // sync() removed — phase 3
  })
}
return { activated: name, local: c.options.local }
```

**After:**
```typescript
const mutationOpts = c.options.project
  ? { project: basename(process.cwd()) }
  : undefined
await putState(api, { soul_slug: name }, mutationOpts)

await sync()
if (c.options.project) await sync({ project: true })

return { activated: name, project: c.options.project }
```

## 6. Impact on compose.ts and shell.ts

### compose.ts — changes in this phase

`compose.ts` currently reads filesystem content (souls, personas, rules `.md` files) and assembles prompts locally. Per the design doc section 12, compose moves to `POST /api/v1/compose` in **phase 4**. However, compose also uses state functions that are being deleted in this phase:

- `readState()`, `readLocalState()`, `readEnvState()`, `mergeState()` (lines 109-115) — used in the ad-hoc `--persona` path to resolve the active soul
- `readFile(join(paths.souls, ...))` and `readFile(join(paths.personas, ...))` — filesystem content reads
- `resolveRuleContent()` — filesystem rule reads
- `readBrain()` from `src/brain.ts` — filesystem brain reads

**Decision:** Compose must be updated in this phase because its state dependencies are being removed. Two options:

1. **Convert compose to server API in phase 3** (merge phase 4 work forward) — cleaner, avoids a hybrid state
2. **Replace only the state calls, keep filesystem content reads** — creates a weird hybrid

**Recommendation: Pull compose conversion into phase 3.** The server's `POST /api/v1/compose` already exists. The conversion is straightforward:

```typescript
// Brain path
const result = await api.post<ApiComposeResult>('/api/v1/compose', {
  brain: brainName,
  task: c.options.task,
})

// Ad-hoc persona path
const result = await api.post<ApiComposeResult>('/api/v1/compose', {
  persona: personaFlag,
  task: c.options.task,
})
```

This eliminates all filesystem content reads from compose.ts and deletes the `readBrain()` import.

### shell.ts — changes in this phase

`shell.ts` uses:
- `sync()` — already server-backed after this phase
- `readBrain()` from `src/brain.ts` — filesystem brain read
- `BRAINJAR_*` env vars for session overrides

**Changes needed:**

1. Replace `readBrain(c.options.brain)` with `api.get<ApiBrain>(`/api/v1/brains/${slug}`)` — same as brain.ts commands already do
2. Replace env var overrides with **session-scoped state mutation**: `PUT /api/v1/state` with `X-Brainjar-Session` header
3. Pre-shell sync: `await sync()` (already server-backed)
4. Post-shell cleanup: `PUT /api/v1/state` to clear session state, then `await sync()` to restore

**New shell flow:**

```
1. Create session: PUT /api/v1/state with X-Brainjar-Session + overrides
2. sync() — writes CLAUDE.md with session-scoped state
3. Spawn subshell (no BRAINJAR_* env vars needed — state is on server)
   - Still set BRAINJAR_SESSION env var so nested brainjar commands use the session
4. On exit: DELETE session state, sync() to restore
```

**Decision:** Shell conversion should happen in this phase since `readBrain()` filesystem calls and env-var-based state are both being removed.

### brain.ts — deleted

`src/brain.ts` (`readBrain()`) is a filesystem-only module. After this phase, compose.ts and shell.ts use server API calls. Delete `src/brain.ts` entirely.

## 7. `--local` to `--project` Flag Rename and Header Mapping

### Current state

- CLI commands use `--local` flag (boolean)
- `src/client.ts` `detectProject()` (line 42) auto-detects project from `basename(cwd)` when `.brainjar/` dir exists
- `RequestOptions.project` (line 22) allows explicit project override

### Mapping

| CLI flag | Header | Value |
|---|---|---|
| (no flag) | `X-Brainjar-Project` sent only if `.brainjar/` exists in cwd | `basename(cwd)` |
| `--project` | `X-Brainjar-Project` always sent | `basename(cwd)` |
| `--local` (alias) | Same as `--project` | Same |

For state mutations with `--project`, the project header must be sent even if no `.brainjar/` dir exists locally (the server creates the project scope on first write). Pass `{ project: basename(process.cwd()) }` explicitly in `RequestOptions`.

### Flag definition change

In every command that has `--local`:

```typescript
// Before
local: z.boolean().default(false).describe('Write to local scope')

// After
project: z.boolean().default(false).describe('Apply at project scope')
```

## 8. Functions Deleted from state.ts

### Deleted entirely

| Function | Lines | Reason |
|---|---|---|
| `readState()` | 119-145 | Replaced by `GET /api/v1/state` |
| `writeState()` | 193-203 | Replaced by `PUT /api/v1/state` |
| `readLocalState()` | 230-267 | Replaced by `GET /api/v1/state` with project header |
| `writeLocalState()` | 269-287 | Replaced by `PUT /api/v1/state` with project header |
| `readEnvState()` | 291-315 | Env state removed entirely |
| `withStateLock()` | 189-191 | Server handles concurrency |
| `withLocalStateLock()` | 317-321 | Server handles concurrency |
| `withLock()` | 156-187 | No filesystem locks needed |
| `mergeState()` | 374-385 | Server resolves scope chain |
| `applyOverrides()` | 324-371 | Server resolves scope chain |
| `resolveRuleContent()` | 24-59 | Rules fetched from server API |
| `listAvailableRules()` | 61-72 | Rules listed from server API |
| `requireBrainjarDir()` | 83-89 | Server validates workspace; local dir not needed |

### Kept

| Function/Type | Lines | Reason |
|---|---|---|
| `normalizeSlug()` | 9-17 | Still validates user input before sending to server |
| `State` interface | 74-79 | Might be useful during transition; can delete in phase 7 |
| `EffectiveState` interface | 222-228 | Replaced by `ApiEffectiveState`; delete |
| `LocalState` interface | 207-215 | Delete — no local state file |
| `EnvState` type | 219 | Delete — no env state |
| `Scope` type | 220 | Delete — server defines scopes |
| `LayerFrontmatter` interface | 91-93 | Used by compose.ts; delete when compose moves to server |
| `parseLayerFrontmatter()` | 95-107 | Same as above |
| `stripFrontmatter()` | 109-111 | Same as above |

Since compose is also being converted in this phase (see section 6), `LayerFrontmatter`, `parseLayerFrontmatter()`, and `stripFrontmatter()` are also deleted.

### state.ts after phase 3

The file shrinks to approximately:

```typescript
export const SLUG_RE = /^[a-zA-Z0-9_-]+$/

export function normalizeSlug(value: string, label: string): string { ... }

export async function getEffectiveState(api: BrainjarClient): Promise<ApiEffectiveState> { ... }

export async function putState(api: BrainjarClient, body: ApiStateMutation, options?: { project?: string }): Promise<void> { ... }
```

Everything else is dead code.

## 9. New API Types in api-types.ts

Add these types:

```typescript
/** Scoped value in effective state response. */
export interface ApiScopedValue {
  slug: string | null
  scope: string  // "workspace" | "project" | "session"
}

/** Scoped rule in effective state response. */
export interface ApiScopedRule {
  slug: string
  scope: string  // "workspace" | "+project" | "-project" | "+session" | "-session"
}

/** Effective state as returned by GET /api/v1/state. */
export interface ApiEffectiveState {
  soul: ApiScopedValue
  persona: ApiScopedValue
  rules: ApiScopedRule[]
}

/** State override at a single scope, returned by GET /api/v1/state/override. */
export interface ApiStateOverride {
  soul_slug?: string | null
  persona_slug?: string | null
  rule_slugs?: string[]
  rules_to_add?: string[]
  rules_to_remove?: string[]
}

/** Body for PUT /api/v1/state — partial update. */
export interface ApiStateMutation {
  soul_slug?: string | null
  persona_slug?: string | null
  rule_slugs?: string[]
  rules_to_add?: string[]
  rules_to_remove?: string[]
}

/** Response from POST /api/v1/compose. */
export interface ApiComposeResult {
  prompt: string
  soul: string | null
  persona: string
  rules: string[]
  token_estimate?: number
  warnings: string[]
}

/** Response from POST /api/v1/compose/sync (if available). */
export interface ApiComposeSyncResult {
  prompt: string
  warnings: string[]
}
```

## 10. Files Touched and Testing Strategy

### Files modified

| File | Change summary |
|---|---|
| `src/state.ts` | Delete 15 functions/types. Add `getEffectiveState()`, `putState()`. ~300 lines deleted, ~20 added. |
| `src/sync.ts` | Delete `inlineSoul()`, `inlinePersona()`, `inlineRules()`. Replace state reads with server API calls. Keep marker logic. ~80 lines deleted, ~40 added. |
| `src/commands/status.ts` | Replace all `readState/readLocalState/readEnvState/mergeState` with `getEffectiveState()`. Rename `--global`→`--workspace`, `--local`→`--project`. |
| `src/commands/soul.ts` | Replace filesystem state ops with `putState()`. Reintroduce `sync()`. Rename `--local`→`--project`. Remove `requireBrainjarDir()`. |
| `src/commands/persona.ts` | Same pattern as soul.ts. |
| `src/commands/rules.ts` | Same pattern. Replace filesystem rule state ops with `putState()`. |
| `src/commands/brain.ts` | Replace filesystem state ops in `save`/`use` with server calls. `save` uses `getEffectiveState()`. `use` uses `putState()`. |
| `src/commands/compose.ts` | Replace local assembly with `POST /api/v1/compose`. Delete filesystem content reads. Delete `readBrain()` import. |
| `src/commands/shell.ts` | Replace `readBrain()` with server API call. Replace env var overrides with session-scoped state. |
| `src/api-types.ts` | Add 6 new types (see section 9). |
| `src/paths.ts` | Remove `paths.state` and `paths.localState` getters. Keep `paths.root` and content paths (needed until phase 7 cleanup). |

### Files deleted

| File | Reason |
|---|---|
| `src/brain.ts` | `readBrain()` replaced by `api.get<ApiBrain>(...)` everywhere |

### Files NOT touched

| File | Why |
|---|---|
| `src/client.ts` | Already has all needed header logic. No changes. |
| `src/config.ts` | No changes — config is local CLI concern. |
| `src/daemon.ts` | No changes. |
| `src/commands/init.ts` | Phase 6. |
| `src/commands/reset.ts` | Purely local, no state dependency. |
| `src/commands/server.ts` | Phase 5. |

### Testing strategy

**Unit tests for new helpers:**
- `getEffectiveState()` — mock `api.get`, verify path and return type
- `putState()` — mock `api.put`, verify path, body, and `project` option maps to request options

**Integration tests for mutation + sync flow:**
- `soul use X` → verify `PUT /api/v1/state` called with `{ soul_slug: "X" }`, then `sync()` called
- `soul use X --project` → verify `PUT` includes project in request options, then both `sync()` and `sync({ project: true })` called
- `rules add X` → verify `PUT` with `{ rules_to_add: ["X"] }`
- `rules remove X` → verify `PUT` with `{ rules_to_remove: ["X"] }`

**Integration tests for status:**
- Mock `GET /api/v1/state` → verify output formatting matches scope annotations
- `--short` → verify one-line format
- `--workspace` → verify `GET /api/v1/state/override` called without project header
- `--project` → verify `GET /api/v1/state/override` called with project header

**Integration tests for sync:**
- Mock state + content API calls → verify `CLAUDE.md` output matches expected marker-wrapped content
- Verify marker splice preserves user content before/after markers

**Integration tests for compose:**
- `compose brain-name --task "do X"` → verify `POST /api/v1/compose` with `{ brain: "brain-name", task: "do X" }`
- `compose --persona engineer --task "do X"` → verify `POST /api/v1/compose` with `{ persona: "engineer", task: "do X" }`

**Integration tests for shell:**
- Verify session-scoped state mutation on entry
- Verify state cleanup on exit
- Verify sync runs before and after subshell

**What to mock:** All tests mock the HTTP client (`BrainjarClient`). No real server needed. The existing test infrastructure likely mocks filesystem calls — those mocks get replaced with client mocks.

**Server prerequisite:** The server must have `GET /api/v1/state`, `PUT /api/v1/state`, and `GET /api/v1/state/override` endpoints before this phase can be tested end-to-end. The `POST /api/v1/compose/sync` endpoint is nice-to-have (fallback is individual fetches).
