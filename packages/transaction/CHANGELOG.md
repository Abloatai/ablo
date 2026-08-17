# @abloatai/transaction

## 0.53.0

### Minor Changes

- A collection read now reports where the collection stands, and a filtered read
  reaches the server with its filter intact.

  `list` returns a page. The result is still an array, so it maps, spreads, and
  iterates as before, and it carries `hasMore` and `nextCursor` beside the rows.
  Pass `nextCursor` back as `cursor`, keeping `where` and `orderBy` the same, to
  walk the rest:

  ```ts
  let cursor: string | null = null;
  const open = [];
  do {
    const page = await ablo.weatherReports.list({
      where: { status: ['draft', 'review'] },
      orderBy: { createdAt: 'asc' },
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    open.push(...page);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  ```

  The parameter that resumes a collection is `cursor`, in the SDK and on every HTTP
  collection route. It was `starting_after`, a spelling whose established meaning
  elsewhere is a row id, while this value has always been an opaque token tied to
  the sort it was issued for. `starting_after` is still accepted on the wire and is
  removed in a later release; sending both uses `cursor`.

  A list read has always been a page: the server applies a default size and caps
  the largest one. Until now that page state was dropped on arrival, so a read
  returning 20 of 500 matching rows looked exactly like a complete one. Check
  `hasMore` before treating a result as the whole set.

  `where` accepts operators as well as equality, and both travel to the server. An
  array value is an `IN`, as in `{ status: ['draft', 'review'] }`, and tuple form
  spells the rest out, as in
  `[['title', 'ILIKE', '%storm%'], ['createdAt', '>=', cutoff]]`. Clauses combine
  with AND. For OR, run two reads and union the results.

  On the stateless client (`transport: 'http'`) an `IN` filter and every
  tuple-form clause were previously discarded before the request left, and the
  read came back unfiltered. Any agent or worker that filtered a collection over
  HTTP was reading more rows than it asked for. Every transport now encodes a
  filter the same way.

  A boolean filter could match the opposite rows rather than fail. A value that
  arrived as the database's own text spelling bound as its negation, so a filter
  on a boolean field is now coerced before binding and read back the same way.

  A field declared as a number reads back as a number whatever integer width its
  column uses; a wide column previously arrived as a decimal string while its
  narrower neighbour arrived as a number. A stored value beyond the range a
  JavaScript number represents exactly now fails with `column_value_out_of_range`
  rather than arriving quietly rounded. Declare such a field as text to read those
  values digit for digit.

  The live client keeps a local graph and loads a working set rather than pages,
  so it rejects `cursor` instead of returning the first page again. Narrow the
  `where`, or construct the client with `transport: 'http'` to page. On that
  client `hasMore` reports whether a `limit` cut the working set short, and
  `nextCursor` is `null`.

  A snapshot no longer overwrites a row the live client already knows to be newer.
  Each row records the log position it reflects, and a bootstrap or an on-demand
  read from an earlier position is left unapplied, so a reconnect cannot roll back
  a write the server had already confirmed. The ordered change stream continues to
  carry every other writer's edits. A plugin receives that position as `syncId` on
  `AppliedChange`.

  `baseURL` is checked where the credential travels. It accepts an HTTPS origin,
  preserving a path prefix for a deployment mounted under one, and plain HTTP for
  localhost. A URL that embeds its own credentials or carries a query or fragment
  is refused when the client is constructed, rather than failing later as an
  opaque request error. The CLI answers to the same rule for `ABLO_API_URL` and
  for a new `--url`.

  `normalizeAbloHostedBaseUrl` is renamed `normalizeAbloBaseUrl`. The old name
  still resolves to the same function and is removed in 0.54.0.

  `GET /v1/projects` returns the canonical list envelope, with `has_more` and
  `next_cursor` beside `data`, matching every other collection endpoint.

  Two further error codes join the registry: `organization_disabled` when an
  operator has disabled an organization, and `query_relation_expansion_too_large`
  when a requested relation expansion exceeds the nested-row budget. The error
  contract version becomes `2026-08-15`.

## 0.52.0

### Minor Changes

- Ablo models now describe application data consistently, regardless of who
  created the database table. `id` is the only universal model field. Timestamps,
  tenancy, and attribution values are ordinary application fields when declared;
  Ablo does not impose them for coordination or auditing.

  A model that relied on Ablo supplying `createdAt`, `updatedAt`, or `createdBy`
  should declare those fields to keep reading and writing them. Ablo still records
  who made every change in its own transaction log, and it still owns the tenancy
  value on each write.

  Two error codes are renamed to match that vocabulary: `task_id_missing` becomes
  `item_id_missing`, and `task_id_required` becomes `item_id_required`. Neither
  old code was ever returned by a request, so a caller matching on error codes has
  nothing to change unless it names one of them directly.

  Database adapters now accept database-generated identifiers and return them as
  canonical string IDs. The adapter learns the database ID type from the database
  connection rather than asking the model to repeat database facts.

  An update operation accepts a `where` precondition. The database changes the row
  only while its current values still match. A mismatch fails the complete commit
  with `precondition_failed`, leaving every operation unapplied. The Kysely source
  adapter supports these preconditions; unsupported adapters report
  `source_adapter_misconfigured`.

  Commit receipts include `operationResults`, pairing each operation's existing
  `transactionId` with its outcome and the authoritative row returned by the
  database transaction.

  The CLI adds `ablo setup`, a read-only guided setup journey that reports the
  decisions, actions, blockers, and postconditions required for an existing
  application. `ablo init --plan` previews file actions using the same terms.

  `ablo telemetry` controls limited CLI usage analytics. Collection is on by
  default and stays off in continuous integration and whenever `DO_NOT_TRACK=1` or
  `ABLO_TELEMETRY_DISABLED=1` is set. Run `ablo telemetry status` to see the
  current state, `ablo telemetry disable` to turn collection off, and
  `ablo telemetry reset` to rotate the local installation identity.

## 0.51.0

- Default cross-organization user sessions to the platform key's schema
  project while keeping data in the target organization.
- Add the explicit `schemaProject` session override for migrations and advanced
  routing.

## 0.50.0

- Make returned rows opaque read-evidence handles. Attach dependencies directly
  to a write with `reads: [task, policy]`; no execution enclosure or async
  context is required, and clones or fabricated rows fail locally.
- Add durable `CommitRecord` retrieval, cursor-paginated `commits.list`, exact
  ReadSet evidence, compact validated claim references, attempt evidence, and
  canonical confirmation timing.
- Expose the server-derived `EffectiveAuthority` as `ablo.identity` on the
  stateless client after `ready()`. Permission denials retain their structured
  `requiredCapability` grant.
- Requires the matching sync-server deployment and the
  `20260805120000_canonical_commit_status` then
  `20260805130000_complete_commit_ledger` database migrations. There is no
  runtime decoder for pre-migration execution receipts.

## 0.49.0

### Minor Changes

- a409395: Release the coordination core as one versioned SDK cut: exact returned rows as
  explicit write dependencies, fenced claims for expensive turns, durable
  paginated commit records, server-derived effective authority, and actionable
  capability denials. No execution enclosure or Node-only client entry point is
  introduced.

### Patch Changes

- 3f145a3: Resolve lowercased wire model aliases in direct Postgres mutations so camelCase schema keys correlate with their canonical typenames.

## 0.48.0

### Minor Changes

- 8151175: One answer for a branch that is not connected yet. A branch keeps its own storage until you connect a database to it, and a request that needs one now fails with `no_data_source_registered` and plain guidance to run `ablo connect` for that branch. The older `test_database_not_registered` code is removed: it described a sandbox that no longer exists, and it arrived on requests that had nothing to do with a test database.

  `FootprintPlane` is now `DataSourceIdentity`, with the same three fields. The old name described an internal layout; the new one describes what it identifies.

  Replace any handler matching on `test_database_not_registered` with `no_data_source_registered`, and any import of `FootprintPlane` with `DataSourceIdentity`.

## 0.47.0

### Minor Changes

- Added stable `source_connector_*` error codes for localhost Data Source
  authentication, attachment, protocol, timeout, handler, and lifecycle
  failures. Connector-only responses now preserve canonical `code` envelopes.

- 2e4be0a: Make schema model writes optimistic with one stable promise contract: local reactive state changes immediately, while awaiting `create`, `update`, or `delete` always waits for authoritative confirmation. Remove the model-level and client-level `wait` options; explicit queued-versus-confirmed receipt control remains on `commits.create`.

- Direct customer database connections now require the branch-scoped publication
  and replication slot everywhere. The legacy `FootprintPlane` type has been
  removed; use `DataSourceIdentity` when deriving a Data Source's Postgres object
  names. The legacy `test_database_not_registered` error code is also removed;
  disconnected branches use `no_data_source_registered` consistently.

## 0.46.0

### Patch Changes

- 534310b: Connected Postgres databases now report their automatic initial-snapshot
  progress through `ablo connect check`, `ablo status --json`, and `ablo doctor`.
  A connection is not called ready while rows that predate its replication slot
  are still loading, and the CLI and Data Source guide make clear that no manual
  row-touch backfill is needed.

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

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
  idempotent writes, confirmation, and observation through Ablo.

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
