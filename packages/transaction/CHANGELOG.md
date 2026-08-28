# @abloatai/transaction

## 0.59.0

### Minor Changes

- Expose plan selection by requested connection capacity and raise the published Pro concurrent-connection capacity to 5,000.
- Define the supported public `Ablo(...)` configuration surface explicitly and stop accepting the internal `onCommitReceipt` transport callback through the public factory type.
- Add one fingerprinted deployment plan that reconciles the source schema, active Ablo schema, and connected PostgreSQL shape. The CLI exposes it through `ablo plan`, projects `ablo check` from the same evidence, adds reviewed rollback, and makes push and migrate consume the shared plan. Push now refuses blocked plans and accepts explicit lifecycle manifests. The underlying deployment contracts are exported from the public schema surface.

## 0.58.0

### Minor Changes

- Converge agent context on exact reads. `context()` now returns only `data` and
  `reads`, retaining each row's own `readAt` evidence instead of publishing a
  context-level cursor or source classification.

  Remove the reactive client's cache-based `snapshot()` operation and its
  `Snapshot` type. Call `read()` for every row an action depends on, assemble
  those rows with `context()`, and pass `context.reads` to `create`, `update`, or
  `delete`.

  Atomic `commits.create()` batches now accept and resolve the same captured rows
  on both the stateless HTTP and reactive WebSocket clients. Typed model claim
  handles can be passed directly to an atomic batch without erasing their row
  data type. Disposing a reactive client also disposes its mutation queue and
  releases commit-lane timers.

- Separate observation from decision input: `ablo.<model>.get({ id })` returns a
  plain current row, while `ablo.<model>.read({ id })` privately retains compact
  model, id, and watermark evidence that can
  be passed through a mutation's `reads` option and retained in its attributed
  commit record without copying row contents.

  Remove the older `retrieve` and durable `track` model surfaces. A row returned by
  `read` has one stale behavior when carried into a mutation: the stale mutation
  does not land. `get` and `list` remain observational, and live `onChange` remains
  the socket-based notification path.

  This is an announced public-surface break with no compatibility aliases. Replace
  `retrieve({ id })` with `get({ id })` for observation or `read({ id })` when a
  later mutation depends on the row. Replace `track(...)`, `CommitContext.track`,
  and mutation `track` / `onStale` options with captured rows passed through the
  mutation's `reads` option. Stale premises now always reject the mutation;
  stateful WebSocket clients can use `onChange` to observe subsequent updates.

  Schema-level conflict policy configuration and its `agents*`, `humans*`, and
  `system*` policy constants are removed, along with the supporting conflict,
  stale-notification, persisted-read-set, and internal read-set exports. Use an
  active claim when work needs exclusive row access, and use `read` plus `reads`
  for optimistic premise checks. AI SDK `ToolModel.get` is likewise replaced by
  `ToolModel.read`.

- Use `ABLO_API_KEY` as the CLI's single explicit credential input. Management,
  branch-runtime, and restricted-agent authority now follow from the credential's
  kind and server-side grant instead of a separate `ABLO_MANAGEMENT_KEY`
  environment variable.

  Keep control-plane credentials out of sandbox integration recipes and pass only
  a delegated, per-run `rk_` credential to an agent runtime.

  Add explicitly hosted, expiring `test` branches for live integration fixtures.
  These branches use Ablo's log-backed storage, expire within 24 hours, and leave
  ordinary customer branches unbound until their own database is connected.

## 0.57.0

### Minor Changes

- Detect mutable schemas that use narrower sync-group routing without a matching
  row-access policy, with an explicit routing-only acknowledgement for intentional
  designs. Generate membership-revalidating, same-origin Next.js session routes
  and protect secret clients with the framework's `server-only` boundary.

  Add `listAll({ where, maxPages, signal })` as an explicit bounded complete-read
  API backed by the existing `ModelList` cursor walker. Document managed scoped
  agent lifecycles and the non-atomic contract for commands split across Ablo and
  ORM-only tables.

  Enforce schema-declared row subjects across reads, writes, claims, presence,
  and every storage adapter. Caller-selected CREATE ids now use strict conflict
  semantics, and source outboxes persist transactionally derived `syncGroups` so
  tombstones reach only the row's authorized subject group. Subject-scoped models
  stamp exactly that one group because delivery matching is OR-based. The
  endpoint outbox is now explicitly versioned: historical and old-writer events
  are version 1, while new writers emit database-constrained version-2 events
  with immutable `syncGroups`. Both versions coexist during rollout; pages
  served by an old reader retain v1 semantics, so v2 routing becomes universal
  after all readers upgrade. Pagination and durable acknowledgement are
  separate protocol fields, and built-in adapters perform bounded cleanup only
  from the explicit acknowledgement. No pre-upgrade drain, write pause, or
  manual deletion is required.

  Reorganize the transaction core around downward-owned operation trees. The
  public seam, headless runtime, and model resources now live under `client/`.
  Commit lifecycle and confirmation live under `commit/`, claim contracts
  and lease behavior under `claims/`, and delta/feed behavior under
  `observation/`. Source endpoints, connectors, delivery, database adapters,
  and outbox behavior each have their own entry point; transport is split into
  HTTP, WebSocket, and shared connection mechanisms. Repository consumers now
  use those owned entry points; the former flat module paths and broad wildcard
  exports are removed instead of retained as a parallel compatibility tree.

  `SourceRequestContext.requiredSyncGroups` is renamed `syncGroups`; both spellings
  carry the same value this release and the old one is removed in 0.58.0.
  `DeltaPosition`, `deltaPositionSchema`, `ReadSetWatermark`, and
  `readSetWatermarkSchema` are removed, as 0.56.0 announced; use `LogPosition` and
  `logPositionSchema`.

  Every response now states your rate-limit allowance rather than leaving you to
  find it: `RateLimit-Policy` always, `RateLimit` once the request is attributed to
  a key, and `Retry-After` on a 429. Every response also carries `Ablo-Version`,
  and a route being withdrawn says so on itself for at least 180 days first
  through `Deprecation` and `Sunset`, with the same operations marked
  `deprecated: true` in the OpenAPI document.

  The documentation answers a reader that is not a browser: `/llms-full.txt`,
  `/openapi.json`, `/developers` and `/.well-known/mcp.json` are routes, and every
  page serves Markdown from its own URL under `Accept: text/markdown`.

## 0.56.0

### Minor Changes

- Claims and presence are now cut by sync group, a client converges on the head it
  was measured against, and a replicated array column arrives as the array it is.

  A platform's customers are rows in its own schema, so they share one
  organization and one plane. The claim listing and the presence read were scoped
  to exactly that pair and nothing finer, which meant one customer could see which
  rows another had claimed, who held them, what the work was called, and who was
  online. Row contents were never exposed; everything around them was. Both reads
  now apply the same cut the delivery path applies, taken from the groups each side
  already carries, so a customer sees the coordination for its own rows and no
  others.

  Catch-up measured the plane head, paged the log under the client's own scope,
  then set the cursor to the last row that scope happened to contain. On a plane
  carrying traffic the client cannot see, that row sits below the head, and where
  the scope held nothing the cursor never moved at all. The client half only ever
  reconciled downward, so it could not adopt a head above its own. Together those
  left a client permanently behind, and the catch-up poll turned it into standing
  load: every thirty seconds it took the plane's advisory lock, found the same gap,
  and served the same nothing. The head reads a global sequence, so on any
  deployment with more than one active writer plane this was every client rather
  than an edge case. The server now advances to the head it measured, and the
  client adopts a head above its cursor when the response carries no deltas,
  because an empty response is proof rather than a hint.

  Every replicated array column arrived one level too deep: `{a,b}` as
  `[["a","b"]]` and `{}` as `[[]]`. The driver's array parsers expect the literal
  without its leading brace, and given the whole literal they read that brace as
  the start of a nested array. The control plane refused such a value outright,
  while a customer's own `text[]` column would have carried it into the log
  silently.

  `ablo doctor` now separates a plane where nothing routed at all from one where
  some changes did not, because the two have different causes: a tenancy value
  missing for the whole plane rather than for particular rows.

  `LogPosition` is the one name for a position in the log. `DeltaPosition`,
  `deltaPositionSchema`, `ReadSetWatermark`, and `readSetWatermarkSchema` still
  resolve to it and are removed in 0.57.0. Where a position needs an owner, the
  owner belongs in the field name rather than in a second type.

  `ABLO_DOCS_BASE_URL` and `ABLO_SITE_BASE_URL` are exported for tools that link
  back to the documentation.

  The customer-organizations guide is rewritten around what an organization is: a
  team account, whose members join with their own logins and share what it owns and
  is billed for. Nobody invites their customers into that, so a platform's
  customers are neither organizations nor projects, which are bound one-to-one to a
  database schema. They are rows in the platform's own schema, reached by the sync
  groups on the session.

## 0.55.0

### Minor Changes

- `ablo doctor` now reports whether the writes that landed reached anyone.

  Its other checks ask whether something is configured. This one asks what
  happened to the last hour of changes, which is the question the rest can be green
  through: a commit confirms, the row appears in your database, and no subscriber
  is ever told.

  ```
  ✗ delivery   3 of 41 changes in the last hour reached nobody (e.g. reports/rep_8c2)
  ```

  A change Ablo cannot route is excluded from delivery and counted, so the count is
  the engine's own record rather than an inference. Where a change is undeliverable
  the report names one model and row, which is what turns "realtime is broken" into
  something to look at. A server too old to answer reports the check as not
  determined rather than as healthy, because an unanswered question is not a pass.

  `ablo check` answers the other half. A model having a tenancy column was treated
  as the whole question, but Ablo stamps that value only on writes it makes. A seed,
  a migration, or a backfill that inserts straight into Postgres does not, and such
  a row can never be routed: it lands, it is queryable, and the sync layer cannot
  see it. Those rows are counted now, so a report reading "23 models, 23 ok" over a
  table full of them is no longer possible. The count is capped, because the answer
  that matters is whether there are any.

  `GET /v1/logs/delivery` is the endpoint behind the check, for anyone building
  their own monitoring. It answers counts over a recent window plus at most one
  sample naming a model and a row id, never row data, and reports the window it
  counted rather than leaving a caller to assume one.

  `CapabilityExchangeResponse` is removed, as 0.54.0 announced. Use
  `CapabilityMintResponse`, which it has resolved to throughout.

## 0.54.0

### Minor Changes

- A scoped session is now scoped on every surface that reads it, a change reaches
  the clients watching it whatever a column is called, and a commit costs a fixed
  number of round trips rather than one per row.

  Seven surfaces answered "which sync groups may this request see" separately, and
  two of them read only `effectiveSyncGroups`, falling through to an
  organization-wide anchor. `syncGroups` is the only field an `ek_` session key
  populates, so a session scoped to one workspace was correctly narrowed on five
  surfaces and read organization-wide on the other two. One module now owns that
  precedence, and a declared set that is empty means nothing rather than
  everything.

  Deltas were written in two different key shapes: the commit path wrote declared
  schema field names, while the replication echo wrote the customer's physical
  column names undecoded. For a source whose columns are renamed, by `.from(...)`
  or by being plain snake_case, every change reached subscribers keyed wrong and
  carried no scope-root group, so a client joined to `workspace:<id>` was never
  sent a change it was watching. The write landed and nothing was announced. Rows
  are now renamed once, where they enter, and one spelling holds below that point.

  Reordering a claim queue took effect for nobody. The route addressed the frame to
  an organization group, which entity-scoped fan-out removes, so every reorder was
  built and then dropped as having no audience. A queue change now goes to the
  waiters in that line.

  A direct write paid three round trips plus one per row to the customer's
  database. Same-region that is a few milliseconds; across continents it dominated
  the wait, and one engine in `eu-north-1` against a database in `us-east-2`
  measured about four seconds per confirmed write. The session bundle is one
  statement instead of eleven awaited settings, the ledger completion and the
  replication marker travel together, and operations are dispatched before being
  awaited so the driver pipelines them. Postgres still runs them in order, so a
  later operation still sees an earlier one's write, two writes to one row stay
  last-write-wins, and each keeps its own error.

  `identityAnchor(kind, id)`, `IDENTITY_ANCHOR_KINDS`, and `IdentityAnchorKind` are
  exported from the schema surface. They build the groups the engine reserves,
  `org`, `user`, and `project`, so the `kind:id` convention has one home instead of
  being spelled inline.

  The scope that authorizes minting into another organization is now
  `organization:act-as`. Keys already carrying `ephemeral:mint-any-org` keep
  working; the old spelling resolves to the new one.

  An outbox `events` handler must key its `data` by the model's declared schema
  fields, not by the table's column names: a field named `reviewStatus` arrives as
  `reviewStatus` even when it reads from a `review_status` column. Ablo's own
  adapters already rename before writing the outbox. Ablo reads that spelling and
  never falls back to the physical one, because two namespaces that can collide
  have no safe merge.

  `ablo feedback <kind> "<one line>"` reports a bug, a docs gap, a missing feature,
  or plain friction, with `--detail` for the long version, `--command` and
  `--error-code` to pre-group it, and `--yes` plus `--json` so a non-interactive
  caller can send and read a receipt. Nothing sends unless the command is run and
  nothing rides the telemetry queue, so turning telemetry off does not also turn
  off bug reporting. The text is redacted before it leaves, by the same rule error
  observations pass through, and shown before sending on a terminal.

  `normalizeAbloHostedBaseUrl` is removed, as announced in 0.53.0. Use
  `normalizeAbloBaseUrl`, which it has resolved to since that release.
  `CapabilityExchangeResponse` is now announced for removal in 0.55.0; use
  `CapabilityMintResponse`.

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
