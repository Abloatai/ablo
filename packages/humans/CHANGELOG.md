# @abloatai/humans

## 0.52.0

## 0.51.0

## 0.50.0

### Minor Changes

- 6864853: Add the standalone `context()` structure for recursively awaited application
  values, exact Ablo read evidence, honest source guarantees, and optional AI SDK
  formatting. Search, memory, model execution, and conversation lifecycle remain
  application or provider concerns.

### Patch Changes

- Updated dependencies [6864853]
  - @abloatai/transaction@0.50.0

## 0.49.0

### Minor Changes

- a409395: Release the coordination core as one versioned SDK cut: exact returned rows as
  explicit write dependencies, fenced claims for expensive turns, durable
  paginated commit records, server-derived effective authority, and actionable
  capability denials. No execution enclosure or Node-only client entry point is
  introduced.

### Patch Changes

- Updated dependencies [a409395]
- Updated dependencies [3f145a3]
  - @abloatai/transaction@0.49.0

## 0.48.0

### Minor Changes

- 8151175: One answer for a branch that is not connected yet. A branch keeps its own storage until you connect a database to it, and a request that needs one now fails with `no_data_source_registered` and plain guidance to run `ablo connect` for that branch. The older `test_database_not_registered` code is removed: it described a sandbox that no longer exists, and it arrived on requests that had nothing to do with a test database.

  `FootprintPlane` is now `DataSourceIdentity`, with the same three fields. The old name described an internal layout; the new one describes what it identifies.

  Replace any handler matching on `test_database_not_registered` with `no_data_source_registered`, and any import of `FootprintPlane` with `DataSourceIdentity`.

### Patch Changes

- Updated dependencies [8151175]
  - @abloatai/transaction@0.48.0

## 0.47.0

### Minor Changes

- 2e4be0a: Make schema model writes optimistic with one stable promise contract: local reactive state changes immediately, while awaiting `create`, `update`, or `delete` always waits for authoritative confirmation. Remove the model-level and client-level `wait` options; explicit queued-versus-confirmed receipt control remains on `commits.create`.

### Patch Changes

- Updated dependencies [2e4be0a]
  - @abloatai/transaction@0.47.0

## 0.46.0

### Patch Changes

- Updated dependencies [534310b]
  - @abloatai/transaction@0.46.0

## 0.45.0

### Patch Changes

- @abloatai/transaction@0.45.0

## 0.44.0

### Patch Changes

- @abloatai/transaction@0.44.0

## 0.43.0

### Patch Changes

- @abloatai/transaction@0.43.0

## 0.42.0

### Patch Changes

- @abloatai/transaction@0.42.0

## 0.41.0

### Patch Changes

- @abloatai/transaction@0.41.0

## 0.40.0

### Patch Changes

- @abloatai/transaction@0.40.0

## 0.39.0

### Patch Changes

- @abloatai/transaction@0.39.0

## 0.38.0

### Minor Changes

- fae876d: Make Ablo branch-first across its transaction API, credentials, CLI, live
  clients, and dashboard. Development and preview work now uses isolated,
  immutable branch identities instead of a shared Sandbox mode. `ablo dev`
  discovers or accepts a branch, ensures it, mints an expiring credential, wires
  the local environment, and pushes the schema.

  Source adapters and PostgreSQL footprint helpers now select immutable branches.
  Callers constructing `FootprintPlane` or `SourceRequestContext` must replace
  `environment`, `mode`, and `sandboxId` with `branchId`.

  Add stable OpenAPI operation names and shared wire schemas as the foundation
  for generated language SDKs. Add explicit PostgreSQL adapter profiles and a
  validated adapter factory for Prisma, Drizzle, and Kysely integrations.

  Add runnable Temporal and Inngest integration examples that keep durable
  workflow execution in those systems while routing shared-data reads, claims,
  idempotent writes, confirmation, and observation through Ablo.

  Add `@abloatai/ablo/ai-sdk` model tools for authoritative reads, idempotent
  creates, concurrency-safe updates, and claimed deletes. Remove the previous
  `coordinatedTool` API and narrow the internal agent package to composition and
  perception adapters instead of owning runtimes, sandboxes, prompts, providers,
  or application tools.

### Patch Changes

- Updated dependencies [fae876d]
  - @abloatai/transaction@0.38.0

## 0.37.1

### Patch Changes

- 5344da6: Restore the full Ablo product explanation and examples in the public package
  README, and reduce live-frame materialization overhead when every delta targets
  a different entity.
  - @abloatai/transaction@0.37.1

## 0.37.0

### Minor Changes

- f60ed16: Harden browser authentication around one typed credential endpoint contract,
  full-plane persistence isolation, awaited terminal cleanup, actual credential
  expiry, and least-privilege human sessions.

  Human session minting now requires a non-empty schema-typed `can` grant. It
  accepts concrete model operations and has no all-data wildcard. Browser
  credentials remain short-lived, refreshable, and isolated from long-lived
  server secrets.

  Endpoint URLs move from `apiKey` to `authEndpoint`. The canonical session and
  capability mint routes are `/v1/ephemeral_keys` and `/v1/capabilities`; legacy
  route aliases are removed.

  Credential providers now use the `CredentialProvider` type. The former
  `ApiKeySetter` export is removed.

- 16cc7d1: Claims are field-granular. The `path` and `range` claim targets are removed, and
  a claim narrows to a whole field or set of fields and no finer. Two agents on the
  same row proceed concurrently when they hold different fields, and serialize when
  they share one.

  This is a breaking removal (the `path` and `range` claim options, the
  `TargetRange` type, and sub-field conflict semantics are gone) and a deliberate
  one. A claim must not promise finer exclusion than the write path can deliver,
  and the smallest thing a write addresses is a whole field: nothing writes part of
  a value. `path`/`range` let two writers hold disjoint spans of one field and told
  them it was safe, which it is not until concurrent edits to one field can be
  reconciled (operational transformation). Until that lands, field is the floor;
  when it lands, sub-field targets return, working.

  If you narrowed a claim by `path` or `range`, claim the field the position lives
  in instead: `fields: ['content']`. To describe a sub-field region to peers for
  display, put it in `meta` — that promises nothing about exclusion.

- 08a3cad: Launch the branded Ablo package as the single package application developers
  install. The root serves headless HTTP callers, while `/client` and `/react`
  serve WebSocket-backed reactive applications.

  The public surface now provides:

  - `@abloatai/ablo` for agents, services, workers, jobs, and backend code;
  - `@abloatai/ablo/client` for live local state;
  - `@abloatai/ablo/react` for React bindings;
  - branded schema, source-adapter, server, authorization, coordination, and wire
    subpaths; and
  - `/source/next`, `/source/drizzle`, `/source/kysely`, and
    `/source/conformance` for Data Source integrations.

  Authoritative reads use `model.get({ id })`; reactive snapshots use
  `model.local.get(id)`.

  Ablo is now presented as the transaction and coordination API for state
  operated by humans, services, tools, and AI agents. Realtime synchronization
  remains available as a client capability rather than defining the product.
  Live applications no longer accept HTTP transport configuration, and the old
  sync-engine package and compatibility paths are removed.

  The public repository preserves the workspace structure used for development
  instead of flattening sources into a generated package. The branded banner,
  documentation, examples, license, notices, and release automation remain part
  of the repository.

  The new package pages direct application developers to the branded Ablo
  entrypoints while still documenting where integration authors can find the
  lower-level transaction and interactive-client contracts.

- f60ed16: Improve confirmed commit throughput and live-client materialization without
  weakening atomic writes, ordered observation, audit delivery, or replay.

  The certified AWS benchmark sustained more than 10,000 committed operations per
  second for homogeneous creates, mixed creates, updates, and deletes with zero
  write errors and sub-second publication drain. The result covers the documented
  single-plane, 12-client, 500-operation benchmark topology rather than claiming
  universal production capacity.

  Live clients now defer reactive model activation until state reaches a
  consumer-visible boundary and keep cache eviction work bounded under sustained
  ingestion. Optimistic state and actively observed models remain immediately
  reactive.

### Patch Changes

- Updated dependencies [f60ed16]
- Updated dependencies [16cc7d1]
- Updated dependencies [08a3cad]
- Updated dependencies [f60ed16]
  - @abloatai/transaction@0.37.0
