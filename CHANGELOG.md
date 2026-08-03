# Changelog

## 0.48.0

### A branch is unbound until you connect a database to it

A branch keeps its own storage, and it does not quietly get Ablo's. Until a
database is connected to that branch, a request needing one fails with
`no_data_source_registered` and says what to do:

```
This branch is not connected to your database yet.
Run `ablo connect` for this branch, then retry.
```

The old `test_database_not_registered` is gone. It described a sandbox that no
longer exists, it arrived on requests that had nothing to do with a test
database, and its advice pointed at options the SDK had already removed. A
branch created by `ablo dev` now reports its state plainly rather than looking
ready and then refusing the first schema push.

**Action required.** Replace any handler matching `test_database_not_registered`
with `no_data_source_registered`. The new code carries the same 4xx meaning and
a recovery path a caller can act on.

### Failures say which branch they happened on

An unconnected branch previously returned its refusal with nothing written
server-side, so a support question about one customer's branch could not be
answered from logs at all. These now carry the request, organization, project,
branch, key kind and storage state, indexed in Sentry, so a failure can be
looked up by branch instead of reconstructed from database tables.

### Replication uses your branch's own publication and slot

Registration, validation, writer checks, replication, drift detection and
`ablo connect` all require the branch-scoped names recorded when the source was
registered. Nothing falls back to a shared `ablo_publication` or `ablo_slot`
any more, so two branches on one database can never quietly share a stream.
`ablo connect scan` reports legacy unsuffixed objects as retired.

Once your engine is on this release and `ablo connect check` is clean, the
temporary alias can go:

```sql
DROP PUBLICATION IF EXISTS "ablo_publication";
```

### Renamed

`FootprintPlane` is now `DataSourceIdentity`, with the same three fields. The
old name described an internal layout; the new one describes what it
identifies.

## 0.47.0

### Local Postgres works with Ablo Cloud

Run `npx ablo dev --local` to serve the generated signed Data Source handler
over an outbound, protocol-scoped connector. Postgres remains private on the
developer's machine and its connection string never leaves the app process.
The Data Source guide now explains exactly which writes are visible without
WAL, and the public error reference includes actionable `source_connector_*`
codes for every connector lifecycle failure.

### Awaiting a model write now means it is confirmed

`create`, `update`, and `delete` change local reactive state immediately and
return a promise with a single meaning: the write reached authoritative
confirmation. An interface stays responsive without awaiting anything, and code
that needs to know a write survived can await the same call it already makes.

The `wait` option is gone from the client and from individual model calls.
Awaiting a model write always waits for confirmation, so there is nothing left
to configure. Explicit control over a queued versus confirmed receipt remains on
`commits.create`, which still hands back the receipt and its confirmation
separately.

**Action required.** Remove `wait` from `Ablo({ ... })` and from every
`create`, `update`, and `delete` call.

- `wait: 'confirmed'` behaves identically once removed.
- `wait: 'queued'` on a call you never awaited behaves identically once removed.
- `wait: 'queued'` on a call you did await now waits for confirmation. Move to
  `commits.create` if the queued receipt was the reason for the option.

### Customer branches connect before accepting a schema

A customer branch now remains in provisioning until it has an active Data
Source. Ablo does not invent internal storage for customer data: it reads the
customer's database through WAL and writes through the separately scoped DML
credential (or uses the explicitly registered signed endpoint fallback).

Database validation now uses the branch-scoped publication and replication slot
persisted with that Data Source. It no longer falls back to the shared
`ablo_publication` / `ablo_slot` names, so `ablo connect check` validates the
same objects that `ablo connect apply` created.

The sandbox-only `test_database_not_registered` error has been removed. An
unconnected customer branch now consistently returns `no_data_source_registered`
with the `ablo connect` recovery step.

**Action required for type imports.** `FootprintPlane` has been removed. Import
`DataSourceIdentity` from `@abloatai/ablo/source` instead; its fields remain
`organizationId`, optional `projectId`, and `branchId`.

### The CLI names the problem it actually hit

A refused push no longer reports every failure as a missing `schema:push`
capability. That advice was wrong for most refusals: a database privilege error,
a row-level security misconfiguration, and an unregistered development database
each need a different fix, and none of them is a different API key. Each now
leads with the server's own message and the remedy for that specific cause.

Project names also resolve correctly under a branch-bound key. Listing projects
is a management operation that such a key is deliberately not allowed to
perform, so `ablo status` and `ablo push` reported a correctly minted key's
project as `unnamed` alongside a permission error. The name now comes from the
stored management credential.

### Deprecations

`METER_EVENT_COUNTS` is deprecated in favour of its per-surface members, and the
`DatasourceResnapshotResponse` type and its schema are deprecated. All three
still ship and still work; they will be removed in a later release.

## 0.46.0

### Provider branches isolate environments; schemas isolate projects

Several Ablo projects can now share one physical Postgres database safely when
each owns a separate schema. `ablo connect apply --schema mail` binds the
authenticated project branch to `(database, mail)` and derives an independent
slot, publication, replication role, and writer role. Publications enumerate
schema-qualified mapped tables and the idempotency ledger lives in the selected
schema. A provider branch's distinct direct URL remains the environment boundary
for Neon, Supabase, and similar hosts.

Registration enforces one owner per `(database, schema)` globally, without
revealing another organization's coordinates, and refuses a new binding when
`max_replication_slots` has no capacity. Runtime replication, rotate,
resnapshot, disconnect, and scan use the binding's stored/derived footprint;
legacy manual setups remain single-binding.

New clients can pin their intended project and branch with `projectId` /
`ABLO_PROJECT_ID` and `branchId` / `ABLO_BRANCH_ID`. `ablo dev` writes both
immutable coordinates beside its branch-bound key, and `ready()` compares them
with the key's server-resolved target before opening the sync connection. A mail
deployment carrying a slides key now fails with `project_scope_denied`; a
same-project key for the wrong environment fails with `branch_scope_denied`.

### Pre-existing rows arrive on their own

Connecting a database that already holds data no longer leaves those rows
invisible until something touches them. Ablo snapshots the pre-existing rows
automatically, `ablo connect check` refuses to report ready until that
snapshot completes, and `ablo status --json` exposes the progress as
`initialSnapshot.status`: `loading`, `retrying` with the underlying error, or
`complete`. Keep an existing read fallback in place until the status reads
`complete`. Row-touch backfill scripts are unnecessary; the snapshot is the
engine's job.

The snapshot reader now detects row-level security that would filter its
ordinary `SELECT` even though WAL carries every published row. New setup plans
give the read-only replication role `BYPASSRLS` (with `SELECT` still restricted
to published tables), and readiness refuses to call an RLS-filtered snapshot
safe. Existing connections can run `ablo connect resnapshot` after repairing
the role; it recreates only the slot and keeps the DataSource and credentials.
The same completion guard rejects an empty or partial snapshot mapping: if a
pushed model's table is absent from the publication, completion stays pending
until coverage is repaired and a fresh snapshot is requested. Snapshot and WAL
mapping now use the DataSource's configured Postgres schema as part of relation
identity, so an identically named table in another schema cannot be loaded into
the model or falsely satisfy publication coverage.

## 0.45.0

### Claim admission is authoritative

A claim used to return a local handle immediately, before the server had
granted anything, so two agents on different server instances could each
believe they held the same row. Every claim now waits for the server's grant
or rejection, and the server fails closed when the shared lease store is
unavailable rather than admitting claims it cannot coordinate. A two-server
end-to-end regression pins the behavior.

### Contention has a lifecycle you can watch

The new `contention` option names what happens when the row is already held:

```ts
const claim = await ablo.tasks.claim({
  id,
  contention: {
    mode: 'skip',
    onStatus(event) {
      // queued | granted | skipped | failed
    },
  },
});
```

`{ mode: 'skip' }` resolves `null` instead of waiting, and `onStatus` reports
the attempt as it moves. `queue: true` and `queue: false` remain as
compatible spellings of the two modes.

## 0.44.0

### A scope denial names the wall it hit

`capability_scope_denied` now distinguishes the Ablo capability allowlist
from the customer database's row-level security. The error carries the
required capability, the resolved operations, the participant and user
principal, the branch, the organization and project, and any applied session
settings, so "permission denied" is a diagnosis instead of a dead end: you
can see whether your grant was missing a verb or whether your own database's
row policy rejected the session context Ablo applied.

### Write failures carry their request id

A WebSocket write failure now carries the `requestId` the server logged it
under, and a `wait: 'confirmed'` write rejects with the complete typed error
rather than a bare failure, so the error you catch is the error the server
recorded.

### `doctor` reports readiness, not destiny

`doctor` now says infrastructure is ready rather than promising a write will
succeed, because database constraints and row-level security still apply at
write time. The debugging guide explains how to read the new diagnostics,
and documents that `list()` may answer from the local pool while
`list({ type: 'complete' })` waits for the server round trip.

## 0.43.0

### Keys are branch-first

A new key is simply `sk_…`, `rk_…`, `pk_…`, `ek_…`, or `mk_…`: thirty
characters and a checksum, with no `live` or `test` in the name. A key's
project and branch are bindings on the server-side key record, never claims
encoded in the plaintext, so rotating, moving, or inspecting a key is a
server-side question with a server-confirmed answer. Existing `live`/`test`
keys keep working; those spellings are now compatibility forms rather than
the model.

What used to be called the effective key is now the runtime key, and
`status --json` exposes it as `runtimeKey`. The documentation explains the
project, branch, and capability model end to end in `docs/api-keys.md`,
`docs/branch-development.md`, `docs/cli.md`, and `docs/data-sources.md`.

### Credential lookup in the order mature CLIs use

Commands resolve their credential from the process `ABLO_API_KEY` first, then
an explicit `--env-file <path>`, then the stored credential. Read-only
diagnostics may inspect `.env.local` to help; anything that mutates requires
an explicit selection. Recovering a database connection is now one command:
`ablo connect rotate` re-keys the existing roles in place and reuses the
replication slot, so recovery never drops roles or touches your database by
hand.

### Removed

`logs --mode` is gone: `logs` follows the branch bound to the key it runs
with. The `effectiveKey` field of `status --json` is renamed `runtimeKey`.

## 0.42.0

### `ablo whoami`: what does this key act on?

`whoami` returns the server-confirmed organization, project, and branch a key
acts on, or fails. Where `status` is the broad health report and deliberately
degrades when an older or unreachable server cannot confirm identity, `whoami`
is the strict form of the question, which makes it safe to run before a
`connect` or `deregister` instead of inferring a key's scope from a failed
mutation.

### Bound sessions resolve their schema again

Every read seam that honored a first-party schema binding substituted the
owner's organization but kept the caller's own branch, a location where the
owner's schema never lives. Bound sessions therefore resolved an empty schema:
bootstraps returned no models and every query answered `unknown_model`. Reads
and commits now resolve the model map on the owner's branch axis, and an
absent branch resolves to the owner's root.

### Re-pushing an unchanged schema no longer fails

The unchanged-schema fast path skipped the provisioning deferral the real
migration path has, so an identical `ablo push` was refused on any plane that
had no DDL to run. The fast path now defers exactly like the real path, and a
second push of the same schema succeeds with nothing left undone.

## 0.41.0

### Log in before you have a schema

`mintUserSessionKey` accepts `controlPlaneOnly` as a third grant form, for
sessions that exist to prove identity to the dashboard and control surfaces
rather than to read or write data. An organization that has pushed no schema
can now complete `ablo login`, which is the very credential pushing requires;
the old circle (push needs keys, keys need login, login needed a schema) is
gone. Data sessions are unchanged, and a control-plane session holds no model
authority.

### `connect apply` asks before it touches your database

The locate preflight runs before provisioning. When another plane of your
organization already holds the source, `connect apply` refuses with exit 1,
names `ablo connect deregister` as the way out, and leaves your database
exactly as it found it; the same conflict used to be discovered only after a
run had created roles and a publication. A connection string without a
password is refused at registration with the field named, instead of failing
later as a masked server error.

### A CLI that says when a command does not exist

Typing a command the CLI does not recognize used to print the full help and
exit zero. It now fails with the name it did not recognize and, when a
plausible target exists, the command to use: a typo lands on the intended
command, and a wrong-but-reasonable name like `disconnect` points at
`ablo connect deregister`.

## 0.40.0

### The price is a contract, and the pricing page derives from it

Ablo's pricing now lives in one module: the tiers, the rate card, and the
arithmetic that turns a month of usage into a bill. Each tier has a monthly
floor, and metered usage is charged against that floor rather than added to
it, so an organization pays the greater of the two and never both. Commits,
reads, and claim creates roll into one metered axis. Concurrent connections
are a capacity reservation, so they are capped rather than billed.

The published pricing page is generated from the same contract the meter
charges against, and a CI gate fails any change that would let the page and
the invoice disagree. The dashboard gains a billing page that shows the
period's usage and what it costs.

### Tracks that refuse to write on a stale belief

A durable track can now carry `onStale: 'reject'`. The tracker's next commit
is refused until it has observed the change it was tracking, so an agent
cannot write on the basis of a row it has been shown to be stale. The default
stays `notify`, which reports the movement on the receipt and lets the commit
through. Group premises now name the concrete row that moved rather than the
group alone, so reconciliation starts from the exact conflict instead of a
re-read of everything the group covers.

### A CLI that fails in plain language

Every command that talks to Ablo's control plane goes through one typed HTTP
client. Failures arrive as named `cli_` error codes with plain-language
messages: a missing API key says how to log in, a missing connection string
says where the CLI looked, an unreachable database says what refused the
dial. Setting `ABLO_JSON=1` switches command output to a machine-readable
form for agents and scripts.

## 0.39.0

### Schema-relative session grants

`mintUserSessionKey` accepts `activeSchemaOperations` in place of `operations`.
Send the verbs a session needs, such as `['read', 'create', 'update',
'delete']`, and the server resolves them against the models in that session's
active schema. A backend that mints sessions for organizations whose schemas it
does not own no longer has to enumerate models it has no way to know.

Calls that pass `operations` are unchanged. A request carries one form or the
other, and the SDK rejects a call carrying both or neither before the round
trip. What the session ends up holding is the same concrete `model.verb`
allowlist either way, so nothing about enforcement changes. A verb is granted
only where the model accepts it, which leaves an immutable model with reads
alone. An organization that has not pushed a schema yet is told to push one
rather than issued a key, since a grant that resolves to nothing would widen
rather than narrow what the session can reach.

### A named error for models outside your schema

Reaching for a model that your schema projection leaves out now fails with a
named `model_not_in_schema` error at the point of access, rather than
surfacing later as a property that happens to be undefined.

### Declared premises serialize against concurrent writers

A commit that declares row premises now serializes those rows against
concurrent commits, not only the rows it writes. Two commits that read the
same rows and wrote different ones could previously both pass validation in a
narrow window. The later commit now observes the earlier one and is rejected
as stale, so a functional update re-reads and re-runs instead of committing on
outdated reads.

### Faster, atomic live updates

The client applies an incoming batch of changes as one action, so reactive
observers see the whole batch or none of it, never a half-applied batch. The
apply path does substantially less work per change, the final partial batch of
a burst materializes after 10 ms rather than 100 ms, and the client no longer
assembles debug payloads it discards.

## 0.38.0

### Branch-isolated development

Ablo branches replace the former shared Sandbox mode. Every project has a
protected Production root and can have multiple isolated development, preview,
test, or long-lived branches. Credentials are bound to immutable branch
identities, so changing a slug or request parameter cannot redirect a write.

`npx ablo dev` now discovers the current Git or CI branch, ensures the matching
Ablo branch, mints an expiring branch credential, writes it to the gitignored
local environment, pushes the schema, and watches for changes. Use
`npx ablo dev --no-watch --branch <name>` for a one-shot agent or CI setup.

The CLI also provides `ablo branch list`, `create`, `ensure`, `status`, `check`,
`credential`, and `delete`. The public HTTP and OpenAPI contracts expose the
same lifecycle for other languages and deployment systems.

This release removes the CLI mode switch and the dashboard Sandbox surface.
Production remains the protected root; a development credential cannot select
another branch or gain production authority.

Source adapters and PostgreSQL footprint helpers now select immutable branches.
If you construct `FootprintPlane` or `SourceRequestContext`, replace
`environment`, `mode`, and `sandboxId` with `branchId`.

### Temporal and Inngest integration guides

New runnable examples and documentation show how Temporal and Inngest
workflows use Ablo without introducing another authority path. Temporal
activities and Inngest steps create the Ablo client, perform authoritative
reads, acquire claims for long-running work, and submit idempotent writes
through the same transaction API as every other caller.

The integrations keep each product in its proper role: Temporal and Inngest
own durable execution, scheduling, retries, and workflow history; Ablo owns
shared-data authority, claims, conflicts, idempotency, settlement, and ordered
observation. Workflow code does not open WebSockets or hold live client state.

### Database adapter foundation, starting with PostgreSQL

Customer-database adapters now declare their database, ORM binding, and
observation strategy as separate axes. The existing Prisma, Drizzle, and Kysely
integrations are accurately identified as PostgreSQL bindings using either a
transactional outbox or PostgreSQL WAL.

All built-in adapters are constructed through one validating factory and the
shared conformance suite checks that the three axes are present. Impossible
capability combinations fail during adapter construction instead of silently
advertising guarantees the database path cannot provide.

PostgreSQL is the first database profile on this axis. The contract leaves room
for additional databases without pretending their transaction, observation,
and change-capture guarantees are interchangeable with PostgreSQL.

### Generated language SDK foundation

The HTTP API is now explicitly treated as Ablo's language-neutral product
boundary. Its OpenAPI artifact follows the current Ablo version and every
operation has a stable, unique name suitable for deterministic Python and Go
generation.

The OpenAPI generator and drift check are restored as repository and CI gates.
Future language clients will generate their transport, wire models, and error
decoding from this contract, retaining handwritten code only for thin
language-idiomatic resource and claim façades.

The artifact now names shared claim, receipt, cursor, page, and error schemas;
references the canonical error envelope from every operation; publishes typed
pagination parameters and explicit union discriminators; and normalizes Zod's
JSON Schema output to the portable subset accepted by the Python and Go
generator candidates. CI also validates the rendered OpenAPI 3.1 document with
an independent, pinned Redocly CLI.

### AI SDK tools over the transaction API

`@abloatai/ablo/ai-sdk` now exposes small tool adapters for authoritative
reads, idempotent creates, concurrency-safe updates, and claimed deletes. These
helpers use the caller's existing typed Ablo model resource; they do not add an
agent runtime or a second transport.

The public surface follows the model verbs directly: `readTool`, `createTool`,
`updateTool`, and `deleteTool`. AI SDK metadata and approval policy pass through
to each tool, destructive tools require approval by default, and cancellation
stops queued claim acquisition.

This deliberately replaces the previously published `coordinatedTool` naming:
use `updateTool`, `UpdateToolModel`, `UpdateToolOptions`, `UpdateToolResult`,
`UpdateStrategy`, and the `status` result field. The former
`coordinatedTool`, `CoordinatedModel`, `CoordinatedToolOptions`,
`CoordinatedWriteResult`, and `CoordinationStrategy` exports are removed rather
than retained as legacy aliases.

Queued tool writes now use Ablo's server-owned FIFO claim queue rather than
recreating coordination with client-side polling.

Internal job dispatch, concrete worker tools, prompts, sandboxes, and model
selection remain application concerns and are not part of the public Ablo
agent surface.

## 0.37.1

### A clearer introduction to Ablo

The package README now explains Ablo from the problem outward: humans already
coordinate shared work by seeing who is active, agreeing on ownership, waiting,
and looking again before continuing; Ablo gives agents those same practical
capabilities in software.

It also makes the headless product explicit. The TypeScript SDK is backed by a
pure HTTP transaction API, so agents, services, jobs, command-line tools, and
interactive applications can use the same coordination model without requiring
a browser or reactive client.

### Lower overhead on busy write paths

Large create batches now return only the inserted identifiers needed for
idempotency handling instead of sending every inserted column back to the
server. Live clients also bypass reconciliation work when a publication frame
contains one change per entity.

These changes reduce server response volume and client materialization work.
There are no public API changes in 0.37.1.

## 0.37.0

### One Ablo SDK for humans, agents, and backend systems

Ablo is now presented and shipped as the transaction and coordination layer for
shared application state—not only as a realtime synchronization library.

Install `@abloatai/ablo` as the single public SDK:

- `@abloatai/ablo` provides the pure HTTP path for agents, services, workers,
  jobs, server actions, and other headless runtimes.
- `@abloatai/ablo/client` adds live local state, optimistic interaction,
  persistence, and presence for human-facing applications.
- `@abloatai/ablo/react` provides the React bindings.

Every entrypoint uses the same schema, capabilities, commits, claims,
idempotency, settlement, and ordered changes. Authoritative reads use
`model.get({ id })`; local reactive snapshots use `model.local.get(id)`.

### Coordination now matches the unit applications can safely write

Claims can coordinate an entire row or a typed set of fields. Two actors
working on different fields of the same row can proceed concurrently, while
overlapping work takes turns.

Sub-field `path` and `range` claims have been removed because the write path
cannot yet guarantee independent updates within one field. Applications using
those options should claim the containing field instead and keep any
cursor/range information in claim metadata for display.

### Safer authority for browser applications

Browser sessions now use one typed, short-lived credential flow and require a
non-empty schema-typed `can` grant. Applications specify the exact model
operations a session may perform instead of issuing ambient all-data access.

Use `authEndpoint` for the browser credential endpoint. The supported routes
are `/v1/ephemeral_keys` and `/v1/capabilities`; the former `apiKey` endpoint
option and legacy route aliases are removed. Credential callbacks now use the
`CredentialProvider` type.
