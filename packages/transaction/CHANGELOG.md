# @abloatai/transaction

## 0.40.0

## 0.39.0

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
  idempotent writes, settlement, and observation through Ablo.

  Add `@abloatai/ablo/ai-sdk` model tools for authoritative reads, idempotent
  creates, concurrency-safe updates, and claimed deletes. Remove the previous
  `coordinatedTool` API and narrow the internal agent package to composition and
  perception adapters instead of owning runtimes, sandboxes, prompts, providers,
  or application tools.

## 0.37.1

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
