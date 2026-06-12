# Changelog

## 0.10.1

### Patch Changes

- Docs: add the 0.10.0 entry to the Version History & Migration Guide — the `test`/`live` → `sandbox`/`production` environment enum rename (key prefixes unchanged) and the new `transport: 'http'` stateless client.

## 0.10.0

### Minor Changes

- Rename environment enum values to `production` and `sandbox` while preserving the existing `*_live_`/`*_test_` key prefix format.

### Patch Changes

- Stateless HTTP transport for server-side actors, and a canonical environment vocabulary.
  - **`Ablo({ transport: 'http' })`** returns a stateless `AbloHttpClient` for agents, workers, and serverless — the same `ablo.<model>` surface and coordination plane with no websocket: each call is one HTTP round-trip and identity rides the Bearer credential. The return type narrows so stateful-only APIs (`get`/`getAll`/`onChange`) are compile errors instead of latent runtime gaps.
  - **Canonical `production` / `sandbox` environments** (new `environment.ts`, exported from the root): `sk_test_` / `sk_live_` remain the wire-level key prefixes but now map to `production` / `sandbox` everywhere — key parsing, source `mode`, and the CLI (which drops the legacy test/live config migration).
  - **Source-mode commit scoping**: `commit` now forwards `projectId`, `accountScope`, and `environment` to customer storage resolvers, so per-project and sandbox/production traffic can be routed to distinct stores.
  - **Fixes**: the WebSocket bearer credential is sent in the `ablo.bearer.<token>` subprotocol (never in the URL or proxy logs); `Model` no longer fabricates an `updatedAt` of "now" for records that arrive with only `createdAt`.

## 0.9.15

### Patch Changes

- Package metadata: set the npm description to "The Collaboration Layer For AI Agents" (matching the GitHub repo About) so it stops reverting to the old "State control API…" text on publish.

## 0.9.14

### Patch Changes

- README: replace the `schema -> ablo.<model>...` pseudo-diagram with a real typed snippet (`create`/`retrieve`/`update`/`claim`), and tidy the Get-started line.

## 0.9.13

### Patch Changes

- Per-project axis: schemas, planes, routing, and enforcement scoped per project. Adds the control plane, per-project key scoping with identity threading, a `remove_model` gate, and the CLI/docs to drive it.

## 0.9.12

### Patch Changes

- README: point the Docs / Quickstart / API header links at `docs.abloatai.com` (the real docs) instead of `abloatai.com`, which 307-redirects to the marketing site.

## 0.9.11

### Patch Changes

- `Model<'name'>` type helper via the `Register` binding — name your model in one parameter (`Model<'tasks'>`) instead of restating `typeof schema`; `Model<S, 'name'>` is also supported and `InferModel` is deprecated. CLI: retire the stale `dev` wording from the login outro and `push` header. Docs: cover the `Register` binding end-to-end and document the `pk_` publishable key + the `/v1/commits` HTTP path.
- 3024593: Fix `sessions.create({ user })` 403 — user sessions now mint via the sk\_-gated ephemeral-key door
  - `sessions.create({ user })` mints an `ek_` user session via `/auth/ephemeral-keys` (was wrongly routed through `/auth/capability`, which rejects human participants — writes were being attributed to agents).
  - Control-plane calls always present your original `sk_`, never the client's exchanged sync credential.
  - `sessions.create({ agent, can })` no longer requires hand-built `syncGroups` — the org anchor is the server default — and the `can` allowlist is now honored at commit time (model-alias matching).
  - New: `ablo.organizationId` (resolved after `ready()`), `ablo status --json`, typed sync-group inputs (`SyncGroupInput` + `invalid_sync_group` rejection for malformed groups).

## 0.9.10

### Patch Changes

- README: add a centered brand header (Ablo banner, tagline, doc nav links, and status badges).

## 0.9.9

### Patch Changes

- Docs: version history & migration guide refinements plus changelog, audit, and link fixes.

## 0.9.8

### Patch Changes

- Docs: add a Version History & Migration Guide, bring the changelog current, and sync doc trees. Drop the dormant `causedByTaskId` from the audit-row docs and fix the `ablo mode` argument vocabulary.

## 0.9.7

### Patch Changes

- Docs: fix the `commits.create` operation shape to the public `{ action, model, data }` form.

## 0.9.6

### Patch Changes

- CLI quickstart simplification (3 commands). `init` now owns login, `migrate` is dropped from the direct-`databaseUrl` quickstart (dev handles it), and the `dev` command is renamed to `push` for honest naming with headless-safe login. **Note:** `ablo dev` is now `ablo push` — update any scripts. Also fixes 3 production bugs surfaced by the new end-to-end journey test harness.

## 0.9.5

### Patch Changes

- Scoped-role automation + tenant-routing fix. `ablo migrate` now auto-creates the RLS-gated scoped role (zero SQL) with a log-safe SCRAM-SHA-256 password verifier, plus a Neon/Supabase scoped-role `databaseUrl` recipe. Fix a jsonb double-encode that corrupted per-tenant routing and silently fell back to the shared pool.

## 0.9.4

### Patch Changes

- Sync-position correctness + CLI hardening. Consolidate five scattered sync cursors into one typed `syncPosition` (persisted/applied/acked with a derived `readFloor`), fixing a claim taken right after an ack-confirmed write reading stale against that write's own delta. Add transaction ack-confirmation, schema DDL-first-push, and a reworked CLI (config/dev/login/mode/drizzle-pull).

## 0.9.3

### Patch Changes

- Onboarding: quickstart leads with your-own-database (Drizzle Data Source), drop Ablo-managed mode, add `ablo push` step; context7 library-claim config.

## 0.9.2

### Patch Changes

- Developer-onboarding overhaul so an LLM or a person gets a working integration on the first try.
  - **`ablo init` scaffolds a project that builds and is current-API.** The Next.js scaffold now ships `app/providers.tsx` + an `app/api/ablo-session` route, uses `useAblo` (the removed `withSync` is gone), object-param verbs, and never bundles your `sk_` key into the browser. The webhook receiver moved off the `[...all]` catch-all.
  - **Agent docs are accurate and ship.** `AGENTS.md`, `llms.txt`, and `llms-full.txt` are on the 0.9.x API (object-param `create`/`update`/`delete`/`retrieve`, disposable `await using claim`, `AbloProvider client` prop), lead with `ablo init`, and `AGENTS.md` now ships in the package.
  - **`ablo push` is self-documenting.** Writing to a model the server hasn't seen now fails with an error that tells you to run `ablo push` (the `server_execute_unknown_model` / `unknown_model` messages), instead of a cryptic "unknown model."
  - **`intents` is deprecated in favor of `claim`** everywhere the docs and the MCP scaffold/prompts teach or generate coordination; the public `ablo.intents` accessor is marked `@internal`.
  - Docs say Node 24+, and the `drizzle-orm` peer floor is `>=0.44`.

- a88747a: Remove the `turn` primitive and the agent-work `tasks` resource from the client surface — the SDK is now purely `ablo.<model>` + `claim`.

  **Breaking**
  - `engine.beginTurn()`, the `Turn` handle interface, and the `Ablo.Turn` type are removed. `AbloApi.beginTurn` and the HTTP client's `beginTurn` are gone too.
  - `CommitCreateOptions.causedByTaskId` is removed. (Lineage is no longer stamped from the client.)
  - The engine no longer exposes a `protocol` accessor or a public `tasks` work-unit resource. `ablo.tasks` is, and always was, the schema `tasks` model proxy.
  - The **`agent().run()` helper and the low-level agent/task type family are removed**: `AbloApi.agent(id, options)` and `AbloApi.tasks` (the `TaskResource`), plus the exported types `Agent`, `AgentOptions`, `AgentRunOptions`, `AgentRunResult`/`Done`/`Failed`/`Cancelled`, `AgentRunStatus`, `AgentRunContext`, `AgentModelClient`, `AgentModelReadOptions`, `AgentModelMutationOptions`, `AgentIntentOptions`, `AgentIntentInput`, `Task`, `TaskResource`, `TaskCreateOptions`, `TaskCloseOptions`, `TaskCloseResult` (and the `Ablo.*` namespace aliases for all of them). The `Ablo.Auth.Agent` principal constructor and the schema-backed `tasks` model are unaffected.

  **Why**

  `turn`/`agent_tasks` was a second coordination-and-attribution mechanism living alongside `claim`. It is redundant on the client:
  - `claim` already serializes writers **and** carries the causal link — its `intent` id rides on every guarded write.
  - The server stamps `actor` / `onBehalfOf` / `capabilityId` onto each delta from the auth context.
  - Per-run token/cost is recorded in Langfuse, not the `agent_tasks` table.

  So the only thing the client lost is the audit pane's "show everything this exact prompt produced" filter, which keyed off `caused_by_task_id`; new writes leave that column null.

  **Migration**

  Agents stop opening/closing tasks — just issue `ablo.<model>` writes (schema-backed) or `ablo.commits.create(...)` (schema-less) under a `claim`. Replace `Ablo({ apiKey }).agent(id, opts).run(prompt, handler)` with: mint a scoped credential via `sessions.create({ agent })`, then `claim` the row and `update` / `commits.create`.

  The **server** `agent_tasks` table, the `caused_by_task_id` delta column, the `/api/sync/commit` wire field, and the `agent_actions_log` compliance hash-chain remain in place but **dormant** (client writes leave the field null) — they are load-bearing for the tamper-evident audit chain and historical-row audit JOINs, so they are intentionally NOT dropped. The dead `/v1/tasks` + `/api/agent/turn` route handlers ARE removed (zero live callers).

## 0.9.1

### Patch Changes

- 90b656c: `drizzleDataSource` now takes `(db, schema)` and derives snake_case columns from your schema, so it composes with `ablo migrate` with no parallel Drizzle table. Update calls from `drizzleDataSource(db, tables)` → `drizzleDataSource(db, schema)`. Also adds the `snakeToCamel` export and provisions the adapter's `ablo_outbox` / `ablo_idempotency` tables via `ablo migrate`.

## 0.9.0

A single options object for every model verb, and a disposable `claim` handle.

### Breaking Changes

- **One options object per verb.** `create`, `update`, `delete`, and the async
  server `retrieve` each take a single options object instead of positional
  arguments, so the id, the data, and every modifier live as named siblings:
  `create({ data, id? })`, `update({ id, data, ...options })`,
  `delete({ id, ...options })`, `retrieve({ id, ...options })`. Reactive local
  reads stay on `get(id)` (synchronous) —
  `useAblo((ablo) => ablo.tasks.get(id))`.

  ```diff
  - await ablo.tasks.update(id, { status: 'done' }, { wait: 'confirmed' })
  + await ablo.tasks.update({ id, data: { status: 'done' }, wait: 'confirmed' })

  - await ablo.tasks.retrieve(id)
  + await ablo.tasks.retrieve({ id })

  - useAblo((ablo) => ablo.tasks.retrieve(id)) ?? serverTask
  + useAblo((ablo) => ablo.tasks.get(id)) ?? serverTask
  ```

- **`claim` returns a disposable handle** instead of taking a callback. The
  handle exposes the fresh row on `.data` and is released on scope exit
  (`await using`) or explicitly via `.release()`. `claim.state`, `claim.queue`,
  `claim.release`, and `claim.reorder` also take the options object.

  ```diff
  - await ablo.tasks.claim(id, async (task) => {
  -   await ablo.tasks.update(task.id, { status: 'in_review' })
  - })
  + await using claim = await ablo.tasks.claim({ id })
  + const task = claim.data
  + await ablo.tasks.update({ id: task.id, data: { status: 'in_review' } })
  ```

## 0.8.0

A callable `claim` coordination namespace and bring-your-own-database support
via a new `databaseUrl` option.

### Minor Changes

- **Callable `claim` coordination namespace.** Taking a claim and inspecting its
  state now live under one accessor: `claim(id, work)` acquires a claim and runs
  `work` while it's held, and `claim.state(id)`, `claim.queue(id)`,
  `claim.release(id)`, and `claim.reorder(id, order)` cover the surrounding
  lifecycle. The README leads with the problem (who is allowed to act, and in
  what order) and the Quick Start now demonstrates `claim` directly.

- **Bring-your-own-database via `databaseUrl`.** Point a project at your own
  Postgres with `Ablo({ schema, apiKey, databaseUrl })`. Ablo writes synced rows
  back into your database, so your data stays canonical. Server-side only;
  defaults to `process.env.DATABASE_URL`. See the data-sources guide for setup
  and role requirements.

### Breaking

- The flat coordination methods `claimState`, `queue`, `release`, and `reorder`
  are removed in favor of the `claim` namespace above.

  ```diff
  - await ablo.task.claimState(id)
  - await ablo.task.release(id)
  + await ablo.task.claim.state(id)
  + await ablo.task.claim.release(id)
  ```

## 0.7.0

### Minor Changes

- Structured error contract, schema/migration engine, and a full `ablo` CLI.
  - **Structured error contract across HTTP + WS planes.** A closed, canonical
    error-code registry is now the `code` tier of a Stripe-style error model. A
    single HTTP egress funnel converts every throw to a canonical
    `{ type, code, message, doc_url, request_id, ...details }` envelope; the WS
    plane narrows mutation/claim error codes to the same union.
  - **Versioned contract + drift guard.** `ERROR_CONTRACT_VERSION` (date-based)
    ships in `errors.json` and on the `Ablo-Version` response header, so consumers
    detect contract changes without diffing docs. Generated `errors.mdx` /
    `errors.json` plus a CI drift guard keep the docs, OpenAPI spec, and SDK from
    silently diverging from the registry.
  - **Always-on request correlation.** Every response carries a `req_…` request id
    (honoring an inbound `x-request-id`), stamped into the envelope's `request_id`.
  - **OpenAPI parity.** The stale `{ error, reason }` schema is replaced by the
    canonical envelope plus a generated `ErrorCode` enum.

  CLI + schema:
  - **Schema diff + migration planning engine** (`generateProvisionPlan` /
    `generateMigrationPlan` in `@abloatai/ablo/schema`) — pure diff, classify,
    apply, and constant-value backfill for required-field migrations.
  - **`ablo generate`** — emit TypeScript types from the pushed schema.
  - **Full `ablo` CLI suite**, Stripe-CLI-shaped: `init`, `login` / `logout` /
    `status`, `mode [test|live]`, `dev` (push schema to the test sandbox + watch),
    `logs` (tail your scope's commit activity), and the data-source commands below.
    Authentication is the OAuth 2.0 device flow; `login` provisions and stores a
    test and a live key, and `mode` switches the active one.
  - **Database-URL structure (bring-your-own-database).** The CLI is split by where
    it writes:
    - `ablo pull` / `ablo check` / `ablo migrate` operate on **your own
      `DATABASE_URL`** — `pull` introspects it to emit `defineSchema(...)` from
      existing tables (read-only, like `prisma db pull`), `check` verifies tables
      fit the schema with no DDL, and `migrate` applies DDL to `DATABASE_URL`.
    - `ablo schema push` / `ablo dev` target the **hosted** test/live sandbox; the
      server diffs, migrates, and activates the uploaded schema. `dev` never
      touches live data.

  **BREAKING** — removed the legacy React hooks `useQuery` / `useOne` / `useMutate`
  / `useReader`. Use `useAblo()` + `ablo.<model>.*` instead. The `MutateActions`,
  `ReaderActions`, and `ReaderFindOptions` types are still re-exported for callers
  that referenced them.

## 0.6.0

### Minor Changes

- 0f663e7: Coordination surface: fair queue, reactive wait-line, and lease renewal.
  - **Claims acquire through a server FIFO queue.** On contention a claim waits its turn and re-reads before proceeding; reads are never blocked. Writes blocked by another participant's claim throw a typed `AbloBusyError`.
  - **`ablo.<model>.queue(id)`** — reactive read of the wait-line behind a row: who's queued, their action, and FIFO position. Synced to peers like `activity(id)`.
  - **Backpressure on `claim`** — `{ wait: false }` skips instead of waiting if the row is already held (claim-or-skip dedup); `{ maxQueueDepth: n }` bails with `AbloBusyError('queue_too_deep')` rather than joining a line already that deep.
  - **Lease renewal** — a held claim renews automatically while the holder's connection is alive, so you never size a TTL; it lapses only after the holder goes silent. A queued claim that's abandoned is dequeued (no ghost waiters).
  - **Reads are never gated by a claim**, including for agents.
  - Intent vocabulary cleanup: a waiting claim is an `Intent` with `status: 'queued'` (`position` carries its place in line). Removed the unbuilt `whenFree`.

- **BREAKING — API renames** (apply when upgrading from 0.5.1):
  - Change-listeners renamed to `.onChange(...)`: `ablo.<model>.subscribe(cb)`, `presence.subscribe()`, `intents.subscribe()` → `.onChange(...)`. (`subscribe` is reserved for an upcoming scope-grant verb.)
  - Row-access API renamed Resource → Model: `Ablo.Resource.*` → `Ablo.Model.*`, `ablo.resource(name)` → `ablo.model(name)`, `ModelTarget.resource` → `ModelTarget.model`, error code `resource_not_found` → `model_not_found`.

## 0.5.1

### Patch Changes

- Docs: add a React quick-start (provider + `useAblo`), plain-language rewrite, and a "Set up with Claude Code" section.

## 0.5.0

### Minor Changes

- 9154c1b: Rename intent handle methods to a clearer claim vocabulary; add `AbloProvider` `bootstrapMode`.

  BREAKING — on the model intent handle (`ablo.<model>.intent(id)`):
  `acquire`→`claim`, `acquireOrAwait`→`claimOrWait`, `settled`→`whenFree`,
  `release`→`finish`, `revoke`→`cancel`. The lower-level `IntentHandle` /
  `IntentLeaseHandle` (`ablo.intents.*`) are unchanged.

  Also: `AbloProvider` gains a `bootstrapMode` prop (`'full' | 'none'`) to skip the
  baseline pull on read-light pages; `StaleContextConflict` gains an optional
  `conflictingFields`; README + JSDoc clarity pass and a new HTTP API section.

## 0.4.0

### Minor Changes

- Per-entity coordination intents on the model accessor.

  Coordinate writes to an entity through the same accessor you read it with —
  `ablo.<model>.intent(id)`, returning a `ModelIntentHandle`. Intent state is one
  self-describing object (`{ object: 'intent', id, status, target, action, heldBy,
participantKind, createdAt?, expiresAt? }`) with a single lifecycle:
  `status: 'active' | 'committed' | 'expired' | 'canceled'`. An `active` intent is
  the lock.

  ### Added
  - `ablo.<model>.intent(id)` → `ModelIntentHandle<T>`, beside `create` / `update`
    / `retrieve` / `load` on every model.
    - Read side (any participant, synchronous + reactive): `current` (the holder's
      intent, or `null`), `status` (`'idle'` when free), `settled()`.
    - Write side (the holder): `acquire()`, `acquireOrAwait()`, lease-guarded
      `update()`, `release()`, `revoke()`.
    - `AsyncDisposable`: `await using lock = ablo.<model>.intent(id)` auto-releases
      on scope exit.
  - `acquireOrAwait()` — serialize-on-contention: take the lease, or wait out the
    current holder, re-read the changed row, then take it. The caller never branches
    on who holds the target — it just gets the target safely. Bind it to an agent's
    write-tool boundary so agents never reason about coordination.
  - New exports: `ModelIntentHandle`, `ModelIntentAcquireOptions`.

  ### Changed
  - `acquire()` is fire-and-forget over the socket — it does not throw on conflict.
    Resolve contention with `acquireOrAwait()` (wait) or read `current` for a
    reactive "who's editing" badge, rather than catching a rejection.

  ### Deprecated
  - Participant-level `intents.claim()` / `onRejected()` and the `intent_rejected`
    wire frame still work but are superseded by the per-model handle. Their removal
    is a future breaking change.

## Unreleased

Schema-driven identity sync-group composition, plus a terser capability surface.

The convention for deriving a participant's allowed sync-groups from its identity is now declared on the consumer's schema as an open registration. Consumers with a `{ regionId, customerId }` identity shape declare their own roles instead of receiving any built-in prefixes from the SDK.

Capability fields shed their redundant `allowed` prefix to match the surrounding vocabulary — capability inputs always describe what the bearer _can_ touch, so the prefix was doing no disambiguation work for the consumer.

### Added

- `DefineSchemaOptions.identityRoles?: readonly IdentityRole[]` — open registration of identity-anchored sync-group roles on `defineSchema(...)`. Each `IdentityRole` declares `{ kind, template, extract }`: a diagnostic label, a `'<prefix>:{id}'` template, and a pure extractor function from an opaque identity context to zero-or-more ids. No closed enum; consumers fully control both the template strings and the extraction logic.
- `composeIdentitySyncGroups(identity, schema)` exported from `@abloatai/ablo/schema` — walks the schema's registered `identityRoles`, calls each extractor, and substitutes ids into templates. Stable, deduped output. Returns `[]` when no roles are registered.
- `Schema.identityRoles: readonly IdentityRole[]` — the registered list, accessible on every `defineSchema(...)` result.
- New exported types: `IdentityRole`, `IdentityContext`.

### Breaking

- `capabilities.create({ allowedSyncGroups, allowedOperations })` → `capabilities.create({ syncGroups, operations })`. Both fields renamed at every public surface — capability create input, capability retrieve response, capability record, Identity returned from `AuthProvider`. Hard rename, no alias. Update the call sites; the field semantics are unchanged.

  ```ts
  // Before
  await api.capabilities.create({
    allowedSyncGroups: ['org:acme'],
    allowedOperations: ['tasks.update'],
    lease: '10m',
  });

  // After
  await api.capabilities.create({
    syncGroups: ['org:acme'],
    operations: ['tasks.update'],
    lease: '10m',
  });
  ```

### Changed

- `docs/integration-guide.md` §1 now shows `identityRoles` in the canonical `defineSchema` example plus a "Declaring scope on a model" subsection covering `orgScoped` / `scopedVia` / `syncGroupFormat`. `docs/capabilities.md`, `docs/api.md`, `docs/mcp.md`, and `AGENTS.md` cross-reference the `identityRoles` section and use the renamed fields throughout.

## 0.3.0 (2026-04-22)

Umbrella `<AbloProvider>` for React apps. One provider component now owns the full lifecycle — singleton rotation on auth change, Strict-Mode-safe bootstrap, `beforeunload` cleanup, session-expiry IndexedDB wipe, post-bootstrap hooks, mesh client construction. Replaces the ad-hoc provider glue every consumer had to write themselves.

Declarative props absorb every class of lifecycle glue; the status hook returns a tagged union so impossible states are unrepresentable. The reference integration shrank from 515 LOC of hand-rolled singleton/AbortController/beforeunload/reaction-bridge wiring to a 60-LOC thin wrapper that just passes props through.

### Added

- `<AbloProvider>` — umbrella provider at `@abloatai/ablo/react`. Props include data config (`schema`, `url`, `userId`, `organizationId`), auth (`capabilityToken` / `apiKey` / session cookie fallback), declarative behavior (`preventUnsavedChanges`, `lostConnectionTimeout`, `postBootstrap`), callbacks (`onSessionExpired`, `onError`, `resolveUsers`), and DI escape hatches.
- `<SyncGroupProvider id="matter:...">` + `useSyncGroup()` — per-entity scope context.
- `<ClientSideSuspense fallback={...}>` — gate renders until the engine reports `connected`. Phase-1 non-Suspense; phase-2 upgrades to real Suspense.
- `useSyncStatus()` rewritten as a tagged union: `{ name: 'initial' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'needs-auth', ... }`. Impossible states are unrepresentable.
- `useCurrentUserId()` — returns the `userId` prop. Replaces downstream consumers' defineProperty hacks on the store.
- `useErrorListener(cb)` — imperative error callback (Sentry/Datadog).
- `useSync<R>()` and `useSyncStore<T>()` accept generic parameters so consumers can widen to their concrete schema types without `as unknown` casts at call sites.
- `BaseSyncedStore.purge()` / `SyncEngine.purge()` — disconnect + wipe every `ablo_*` / `ablo-*` IndexedDB. Called automatically on session expiry.
- `SyncEngine.onSessionError(listener)` — subscribe to session-error events. Multiple subscribers supported.
- Commit payload projection built into `TransactionQueue`. Mutations are automatically projected onto the model's schema-declared fields (dropping framework internals `__class` / `__typename` / `clientId` / `syncStatus` and anything not declared), with `field.json()` values auto-stringified for TEXT columns and `undefined` dropped on updates. No config port, no consumer hook — the SDK derives correct wire payloads from the schema alone. Apps that previously maintained hand-rolled extractor tables can delete them entirely.

### Breaking (continued)

- Removed `SyncEngineConfig.extractCreateInput` and `SyncEngineConfig.buildUpdateInput`. The SDK's built-in projection replaces them. Consumers who passed these in `configOverrides` should delete the override; the default now covers 100% of identity-column mutations. The `configOverrides` prop still exists but its remaining fields are all deprecated (see below) and scheduled for removal in v0.4.

### Deprecated (vestigial — removal in v0.4)

- `SyncEngineConfig.modelCreatePriority`, `defaultCreatePriority`, `defaultNonCreatePriority` — never read at runtime.
- `SyncEngineConfig.batchableModels` — never read at runtime.
- `SyncEngineConfig.dedicatedDeleteModels` — never read at runtime.
- `SyncEngineConfig.preserveCaseModels` — never read at runtime.
- `SyncEngineConfig.essentialFields` — used only in debug logging, no behavioral effect.
- `SyncEngineConfig.classNameFallbackMap` — dead path; `ModelRegistry.registerModelsFromSchema` registers by constructor identity, bypassing the class-name fallback entirely.

### Breaking

- Removed `<SyncProvider>` — folded into `<AbloProvider>`. Migrate by swapping the provider and passing `userId`/`organizationId`/`url` instead of a pre-constructed store.
- Removed `createAbloContext()` factory and its returned `AbloProvider` / `useAblo` / `useParticipant` triple. Mesh is now always-on inside `<AbloProvider>`; `useAblo()` and `useParticipant(opts)` are always available. Schema-typed mesh hooks are on the roadmap.
- Removed `withSync` (no-op alias of `observer`). Import `observer` from `mobx-react-lite` directly if needed.
- Removed `useSyncContext` from the public surface (never used outside the SDK's test helpers).
- `useSyncStatus()` return shape changed from six booleans to a tagged union. Migration: `const { isReady } = useSyncStatus()` → `const status = useSyncStatus(); const isReady = status.name === 'connected'`.
- `SyncStoreContract` gained six sync-status getters and a `syncStatus` field. Third-party classes implementing the contract must add these (additive for callers).

### Migration

```tsx
// Before (0.2.x)
const { AbloProvider, useAblo, useParticipant } = createAbloContext<typeof schema>();

function Root() {
  const sync = createSyncEngine({ url, schema, user });
  const ablo = new Ablo({ schema });
  return (
    <SyncProvider store={sync._store} organizationId={orgId}>
      <AbloProvider ablo={ablo}>
        <App />
      </AbloProvider>
    </SyncProvider>
  );
}

// After (0.3.0)
function Root() {
  return (
    <AbloProvider
      schema={schema}
      url={url}
      userId={userId}
      organizationId={orgId}
      preventUnsavedChanges
      onSessionExpired={() => router.replace('/signin')}
    >
      <ClientSideSuspense fallback={<Skeleton />}>
        <App />
      </ClientSideSuspense>
    </AbloProvider>
  );
}
```

No breaking change to `useQuery` / `useOne` / `useMutate` / `useReader` / `useMutators` / `useUndoScope` / `usePresence` / `useIntent` — call sites remain source-compatible.

## 0.2.1 (2026-04-22)

React bindings hardening. Fixes two infinite-loop classes that surfaced in downstream apps as React error #185 ("Maximum update depth exceeded"), and exposes sync-status reactivity as a first-class observable + hook.

### Fixed

- **`useQuery` / `useOne` no longer loop on `getSnapshot`.** The `useSyncExternalStore` adapter was returning a fresh `view.results.slice()` on every call, which React's post-commit consistency check interpreted as "store updated mid-render" — scheduling another render, another snapshot, another mismatch, ad infinitum. The snapshot is now cached in a ref and only refreshed inside the subscribe callback right before `onChange()` fires. Affected every tree with multiple simultaneous `useQuery` subscribers.

### Added

- **`BaseSyncedStore` sync status is now properly observable.** `syncStatus` and `dataReady` are annotated `observable`; `isReady`, `isSyncing`, `isOffline`, `isReconnecting`, `isError`, `hasUnsyncedChanges` are `computed`. Before, these were plain getters over plain fields — `reaction(() => store.isReady, ...)` silently never fired. Existing `observer` / `reaction` call sites that relied on the implicit `pool.size` trigger will continue to work; new call sites should read these observables directly.
- **`useSyncStatus()` React hook.** Returns `{ isReady, isSyncing, isOffline, isReconnecting, isError, hasUnsyncedChanges }` as a reactive snapshot, bridged via `useSyncExternalStore` with a correctly-cached snapshot. Replaces hand-rolled `reaction` bridges in consumer providers. See `docs/react.md`.
- **`SyncStoreContract` surfaces the status getters** so TypeScript autocomplete works from the `useSyncContext()` return value without a cast.

### Documentation

- **`llms.txt` and `docs/react.md`** gained a "Common pitfalls" section covering the three traps this release addresses: don't wrap providers in `observer()`, `getSnapshot` must return a cached reference, and sync-status fields are real observables (don't watch `pool.size` as a proxy).

### Migration

No breaking changes. Optional: replace any local `reaction(() => store.isReady, setReady, { fireImmediately: true })` bridges in your own providers with `const { isReady } = useSyncStatus()` for consumers below the store provider.

## 0.2.0 (2026-04-21)

Mesh SDK — the canonical agent-multiplayer surface. Locked at this release; further work is consolidation, not expansion.

### What's frozen

The SDK covers exactly three integration shapes. Each has a canonical example in [`examples/`](./examples/):

1. **Server agent** — `new Ablo({ schema })` reads `ABLO_API_KEY`, joins and works. ([`examples/server-agent.ts`](./examples/server-agent.ts))
2. **Browser app** — server mints a scoped capability, browser holds it via `new Ablo({ schema, capabilityToken })`. No API key in bundle, no session cookies, no allowed-origins registration required. Stripe `client_secret` shape. ([`examples/browser-app.ts`](./examples/browser-app.ts))
3. **Sub-agent** — `parent.join(child, opts)` attenuates from the parent's capability. ([`examples/sub-agent.ts`](./examples/sub-agent.ts))

### Ergonomics (package-wide)

- **`Ablo` class** — `import Ablo from '@abloatai/ablo'` / `new Ablo({ schema })`. Matches `new Stripe()` / `new OpenAI()` / `new Anthropic()` pattern. `createMesh(opts)` stays available as the functional alias.
- **Model-scoped joins** — `ablo.matters.join(id, { label })` desugars to the generic `join`. Proxy-based so the namespace adapts to any schema. Collisions with reserved admin fields (`roles`, `members`, `audit`, `capabilities`) throw at construction time.
- **Flat scope form** — `scope: { matters: id }` alongside the array form.
- **`as` alias** — `{ as: session({...}) }` replaces the security-jargon `onBehalfOf`; both still accepted.
- **Auto-connect** — `join()` returns a connected participant. `autoConnect: false` to opt out.
- **Duration strings** — `ttl: '3m'`, `ttlSeconds: '24h'` accepted alongside numbers.
- **Descriptive generics** — every public type uses `TSchema` / `TAgent` / `ModelName` instead of `S` / `A` / `K`. Zero `unknown` in public types.

### Coordination primitives

- **Presence verbs** — `participant.presence.editing(target)` / `viewing(target)` / `idle()`. Plus `update({...})` escape hatch for custom actions.
- **Intent verbs** — `participant.intents.editing(target, opts)` / `writing(target, opts)`. Returns an `IntentHandle` with `Symbol.asyncDispose` so `await using work = ...` auto-revokes.
- **Snapshots** — `const snap = await participant.snapshot({ clauses: [id] })`. Flat shape: `snap.clauses[id]` (typed from schema via `InferModel`, not `unknown`), `snap.stamp`, `snap.signal` (AbortSignal).
- **Async iterables** — `for await (const peers of participant.presence)`, `for await (const openIntents of participant.intents)`, `for await (const delta of participant.deltas)`.

### Env / config

- `ABLO_API_KEY` — required for server-side use.
- `baseURL` — optional override for private deployments / local-dev (defaults to `wss://api.abloatai.com`).
- `organizationId` — **no longer required** in `createMesh`. The API key or session binds the caller to one org; the capability mint response echoes it back.
- `createMeshFromEnv` — removed. `new Ablo({ schema })` auto-reads env.

### Test coverage

- 53 mesh unit tests across 8 suites (`__tests__/unit/mesh/`)
- New E2E test `e2e-browser-capability-token.ts` proves the server-mints / browser-holds flow end-to-end
- Existing 12 mesh E2E tests (token refresh, watermark, chinese wall, etc.) still pass

---

## 0.1.0 (2026-04-10)

Initial release.

### Features

- **Schema DSL**: Zero-codegen schema definition with full TypeScript inference (`defineSchema`, `field`, `relation`)
- **React Hooks**: `useModels`, `useModel`, `useMutations`, `withSync` for reactive data binding
- **Consumer API**: `createSyncEngine()` — one-liner setup that hides all internal wiring
- **Offline-first**: IndexedDB persistence with automatic offline mutation queue and FK-safe flush
- **Real-time sync**: WebSocket delta streaming with optimistic updates and rollback
- **AI Agent SDK**: `SyncAgent` for backend/AI agent participation as first-class sync citizens
- **Pluggable auth**: `AuthProvider` interface with built-in API key, JWT, and session providers
- **Security**: IndexedDB cleanup on session expiry and sync group revocation
- **Testing utilities**: `@abloatai/ablo/testing` subpath with mocks, fixtures, and harness

### Test Coverage

- 231 unit/integration/property/contract tests
- 50 E2E tests against real Go server + PostgreSQL + Redis
- Property-based testing via fast-check
