# Changelog

## 0.61.0

### Existing database connections repair in place

`ablo connect apply` is now the single repeatable operation for both a new
database connection and an existing registration. A healthy connection is a
no-op. When a registration predates current publication, replica-identity,
grant, or row-level-security requirements, the same command reconciles those
database-owned invariants through the transient owner URL while preserving
Ablo's working scoped passwords.

If that repair means an earlier initial snapshot may have omitted rows, the
operation requests the required fresh snapshot and subsequent reruns report its
loading or ready state. Automation can select `--json` for stable lifecycle and
per-step codes instead of parsing human output. Credential rotation remains an
explicit operation for an actually incomplete or invalid role pair.

## 0.60.0

### Sessions are the connection boundary for people and agents

`Sessions({ schema, apiKey })` is now the dedicated session issuer. Backends create scoped
agent sessions with `sessions.create({ agent, can, groups })` and expose browser
sessions with `sessions.handler({ authenticate, grant })`. Both return the same
short-lived session contract, and both are supplied to clients through
`Ablo({ schema, session })`:

```ts
const workerAccess = {
  records: ['read', 'update'],
} as const;

import Sessions from '@abloatai/ablo/sessions';

const sessions = Sessions({ schema, apiKey: process.env.ABLO_API_KEY });

const session = () =>
  sessions.create({
    agent: { id: stableWorkerId },
    groups: [workspaceGroup],
    can: workerAccess,
  });

const agent = Ablo({ schema, session });
```

Session clients default to one reconnecting WebSocket for commits, claims,
observation, presence, and collaboration. API-key clients remain HTTP by
default, and bounded session work can select `transport: 'http'` explicitly.
Model calls do not open additional sockets.

An async session provider represents one renewable logical identity. The client
caches each short-lived credential until it approaches `expiresAt`, pre-mints a
replacement, and reconnects with that replacement when necessary. Durable
observation resumes from its acknowledged cursor across socket replacement.
A provider resolving `null` means the application login ended and terminates the
session; a thrown error remains transient. A static session object cannot renew
itself and ends when its bearer expires. In-flight commits whose outcome became
ambiguous still reject and can be retried with their original idempotency key.

The browser client now names its session route as
`session: { endpoint: '/api/ablo-session' }`; `authEndpoint` is removed. Public
connection scope is `groups`; public `syncGroups` is removed. The overlapping
`agents.create`, `join`, and `useJoin` lifecycles are also removed: connection
groups define visibility, `usePeers` reads presence, and row claims own
exclusion.

Internally, session contract, creation, handler, source normalization, and
credential renewal now live beneath one `sessions` boundary. HTTP bootstrap and
the live socket consume the same normalized session access, so credential
identity and renewal policy cannot diverge.

Session issuance no longer occupies a property on `Ablo(...)`. That client owns
the schema model namespace, so an application model named `sessions` works as
`ablo.sessions` like any other model. Issuance and lifecycle administration stay
server-only behind the explicit `@abloatai/ablo/sessions` import.

## 0.59.2

### Patch Changes

- Updated dependencies [0b2fff7]
  - @abloatai/humans@0.59.2
  - @abloatai/transaction@0.59.2

## 0.59.1

### Plans recognize completed database migrations

`ablo plan` now treats a connected PostgreSQL column as evidence that required
field migration work is complete when the mapped column exists, has the expected
type, and already enforces `NOT NULL`. The plan reports that verified work once
instead of demanding a synthetic backfill merely because the active Ablo
artifact predates the database migration.

The same reconciliation now recognizes a risky field-type correction as already
completed when PostgreSQL has the candidate type, so activation does not demand
`--force` merely because the active artifact still describes the old type. That
evidence remains a forward-only contract boundary: reactivating the old artifact
would disagree with the migrated database. Enum narrowing is not inferred from
a `TEXT` column because the observed shape does not prove existing values satisfy
the new constraint.

Removing a model from the served schema also no longer implies that Ablo will
drop its table when the connected database is application-owned and the table is
still present. The plan reports a compatibility warning, retains the physical
table, and allows the reviewed metadata activation without `--force`. Ablo-owned
tables, missing application tables, and unobserved database states remain
destructive errors.

Missing, nullable, incompatible, contradictory, and unobserved database states
remain blocked. Duplicate physical findings shared by the candidate and active
schemas are collapsed, while genuine three-state disagreements remain visible
in both directions.

### Batched writes preserve their exact-read evidence

Reactive writes that carry captured rows through `reads` now retain those
dependencies when several writes are sealed into one durable commit, including
after an offline replay. A premise that became stale is therefore still rejected
instead of being lost at the batch boundary.

## 0.59.0

### Schema changes now have one ordered deployment plan

`ablo plan` compares the source schema, the active Ablo schema artifact, and the
connected PostgreSQL shape without changing any of them. It produces one
fingerprinted expand, dual-write, backfill, verify, switch, and contract
sequence, with explicit owners, blockers, and a rollback target:

```sh
npx ablo plan
npx ablo plan --json
```

`ablo check` is now the database-compatibility view of that same plan. `ablo
push` and `ablo migrate` consume it instead of maintaining separate migration
judgments, and `ablo rollback` plans or applies a reviewed reactivation of an
earlier schema artifact. The shared deployment contracts are available through
`@abloatai/ablo/schema` and `@abloatai/transaction/schema`.

Planning must observe all three states. `ablo plan`, `ablo check`, and `ablo
migrate` therefore require `ABLO_API_KEY` plus
`DATABASE_ADMIN_URL`/`DATABASE_URL`; a migration dry run is no longer a
source-only operation. `ablo push` now refuses a blocked plan and can accept an
explicit lifecycle manifest with `--manifest <path>`.

Runtime schema-drift warnings now name the affected fields and distinguish
client-only fields, active-only fields, and changes to type or optionality.

### Declared timestamps no longer recurse during local edits

Schemas can declare `createdAt` and `updatedAt` for typed reads and ordering
without turning Ablo's automatic timestamp bookkeeping into another model
edit. Updating an observable field now advances `updatedAt` once, keeps the
timestamp observable, and excludes system-managed timestamps from the
user-authored change payload.

### The public client configuration boundary is explicit

The supported `Ablo({ ... })` options are now machine-checked against the
published reference. The internal `onCommitReceipt` transport callback is no
longer accepted by the public factory type.

### Connection capacity is selectable from the public pricing model

The pricing API can now select the first tier that accommodates a requested
connection count. The published Pro allowance increases from 1,000 to 5,000
concurrent connections.

### CLI telemetry can reach authenticated ingestion

When an Ablo runtime key is available, the CLI uses it only in memory to
authenticate product-analytics delivery. The key is not written to the local
telemetry state, and existing telemetry opt-outs continue to apply.

### Version-matched integration guidance is easier to enter

The documentation bundled with `@abloatai/ablo` now starts from installation,
the operation being coordinated, and whether an existing write boundary must
be preserved. New focused pages cover basic usage, implementation choices,
existing-operation coordination, every client option, security,
instrumentation, comparisons, common questions, and GraphQL.js. `npx ablo
docs` continues to read this package-local documentation, so the guidance
matches the installed version.

A new stale-context agent-turn example shows the complete long-running policy:
abort cancellable work when an exact read moves, rebuild context for a bounded
retry, retain the authoritative write guard, and reconcile rather than blindly
replay an irreversible external side effect.

## 0.58.0

### Reads now distinguish observation from decision input

`get({ id })` returns the current row for display or inspection. `read({ id })`
returns the same row while privately retaining its model, id, and watermark so a
later write can prove exactly which state it depended on:

```ts
const report = await ablo.reports.read({ id: reportId });

await ablo.reports.update({
  id: report.id,
  data: { summary },
  reads: [report],
});
```

If `report` changed in between, the update does not land and rejects with
`AbloStaleContextError`. `get()` and `list()` remain observational, while
`onChange()` remains the live notification surface.

This replaces the older `retrieve()` and durable `track()` model surfaces. It is
a public-surface break with no compatibility aliases:

- replace `retrieve({ id })` with `get({ id })` for observation, or `read({ id })`
  when a later mutation depends on the row;
- replace `track(...)`, `CommitContext.track`, and mutation `track` / `onStale`
  options with captured rows passed through the mutation's `reads` option; and
- replace AI SDK `ToolModel.get` with `ToolModel.read`.

Schema conflict-policy configuration and the `agents*`, `humans*`, and
`system*` policy constants are also removed, together with the supporting
conflict, stale-notification, persisted-read-set, and internal read-set exports.
Use an active claim when work must exclude another participant. Use `read()` and
`reads` when work may run concurrently but must not commit from a stale premise.

The removals announced by earlier releases now take effect too:
`SourceRequestContext.requiredSyncGroups` is gone in favor of `syncGroups`, and
`DeltaPosition`, `deltaPositionSchema`, `ReadSetWatermark`, and
`readSetWatermarkSchema` are gone in favor of `LogPosition` and
`logPositionSchema`.

### Context follows exact reads and can stop stale work early

`context()` now assembles ordinary application values and exact Ablo reads into
one result with `data`, `reads`, and `onChange`. It no longer publishes a
context-level cursor or source classification. `ContextResult.cursor`,
`ContextResult.sources`, `ContextChange`, `ContextSource`, and
`contextSourceSchema` leave with that older model.

The reactive client's cache-based `snapshot()` operation and `Snapshot` type are
removed. Call `read()` for every row an action depends on, assemble those values
with `context()`, and pass `ctx.reads` to the final write:

```ts
const ctx = await context({
  ablo,
  data: {
    report: ablo.reports.read({ id: reportId }),
    documents: searchDocuments(reportId),
  },
});

const stop = ctx.onChange((error) => controller.abort(error));

try {
  const summary = await generateSummary(ctx.data, controller.signal);
  await ablo.reports.update({
    id: reportId,
    data: { summary },
    reads: ctx.reads,
  });
} finally {
  stop();
}
```

`onChange` calls its listeners once when any captured row moves, which lets an
expensive model call stop early. The final write must still receive
`reads: ctx.reads`; that server-side check stays authoritative if notification
races the write or the connection drops.

Atomic `commits.create()` batches accept the same captured rows on both the
stateless HTTP and reactive WebSocket clients. Typed model claim handles can be
passed directly as a batch's `claim`, without losing their row type. Disposing a
reactive client now also disposes its mutation queue and commit-lane timers.

### Claims are available from the shell

The CLI can now acquire, queue for, inspect, heartbeat, and release a row lease:

```bash
npx ablo claims acquire reports report_123 --queue -- npm run reconcile
npx ablo claims list reports report_123
npx ablo claims release reports report_123
```

The `-- <command>` form keeps the lease alive only while the child process runs
and releases it on success, failure, or interruption. This lets an operator or
coding agent participate in the same coordination boundary as SDK clients
without first adding application code.

### An agent run can carry the person who started it

An agent session can now name the person it acts for. Pass `onBehalfOf` when you
mint, and every write that agent makes records both principals: the agent as the
actor, that user as the delegator.

```ts
const { token } = await server.sessions.create({
  agent: { id: agentId },
  onBehalfOf: { user: { id: requestingUserId } },
  can: { records: ['read', 'update'] },
  syncGroups: [syncGroup('workspace', workspaceId)],
});
```

Until now the delegation chain root came from whoever called the mint. A browser
session minting for its own user recorded that person; a backend minting with a
secret key recorded nobody. Background work is the second case, so a queued
job's writes arrived attributed to the agent alone, or to `system` where the
worker wrote around Ablo entirely. Ablo never sees your user directory, so it
cannot recover that identity afterwards.

The rule is about who may attest, not who may ask. A secret key already carries
organization authority, so it may name any user id, which is what lets a worker
resume a job somebody else started. A human session may name only its own user,
and naming another is refused. `onBehalfOf` on a capability that is not an agent
is refused as well.

Two habits make this hold in practice. Persist the user id on the job before you
enqueue it, because request context and in-memory arguments do not survive a
retry or a process boundary, and a durable job without its delegator can only
produce agent-only attribution. And do not quietly fall back to writing straight
to the database when minting is unavailable. Those writes are still observed,
but they carry no trusted correlation and are recorded as `system`.

Omit the field and sessions mint exactly as they did before.

### The CLI has one credential input and a clearer project boundary

`ABLO_API_KEY` is now the CLI's single explicit credential input. Management,
branch-runtime, and restricted-agent authority follow from the credential kind
and its server-side grant; `ABLO_MANAGEMENT_KEY` is no longer a separate input.
Keep management credentials at the control-plane boundary and pass only a
delegated, per-run `rk_` credential into a sandbox or agent runtime.

After browser approval, `ablo login` now lets an organization with multiple
projects choose the project in the terminal. `ablo login --project <slug>` skips
the picker. Credentials remain fixed to the project that minted them, and the
CLI refuses to silently use another project's stored key.

Database connection setup now handles more provider-specific PostgreSQL role
constraints, repairs required role inheritance, registers local connectors
through the control-plane boundary, and reports a missing Data Source API key as
an authentication problem with a concrete fix. A branch still needs a database
connected before its schema can be pushed.

### Hosted test branches are explicit and temporary

Live integration fixtures can create an expiring `test` branch backed by Ablo's
hosted log storage. Hosted storage must be requested explicitly and the branch
must expire within 24 hours. Ordinary customer branches remain unbound until
their own database is connected, so a test convenience cannot silently choose
where customer data lives.

The documentation now includes a coordination-conformance fixture, an
existing-document evidence pipeline, an existing Python backend path, a
GraphQL.js approach, and a sandbox-runtime integration guide. These examples
separate the guarantees Ablo enforces from application, provider, database, and
deployment responsibilities.

### Pricing and plan limits moved

The rate card, the included allowances, and the plan ceilings all changed in
this release. The canonical page is published at
https://docs.abloatai.com/pricing and needs no sign-in.

## 0.57.0

### The endpoint outbox upgrades without a drain

Endpoint events now have an explicit envelope version. Existing rows and writes
from an older endpoint are version 1 and pass through the preserved pre-subject
routing decoder. New adapters write version 2, capturing `sync_groups` in the
same transaction as the row change. The database constraint requires every
version-2 event to carry those immutable routes.

Old and new endpoint versions may run together during rollout without stalling
the feed. A page served by an old reader necessarily uses version-1 semantics,
even when a new writer created the row, because that reader does not select the
new routing columns. Version-2 routing is therefore universal once every
endpoint reader has upgraded. There is still no pre-upgrade drain, write pause,
cursor inspection, or manual deletion.

Ablo sends `cursor` as the read position and `acknowledgedThrough` separately
after the event and consumer position are durable. Built-in adapters use that
explicit acknowledgement for bounded cleanup; custom event handlers may do the
same.

Version 1 remains a deliberately named compatibility decoder, not a
NULL value silently interpreted as an empty audience. Replication connections
have no endpoint outbox and require no action.

### A row is authorized by the subject its schema declares

A model may now declare which field decides who a row belongs to, and that rule
is enforced on every path: reads, writes, claims, presence, and every storage
adapter, including the endpoint ones. A row is authorized exactly when the
request carries the sync group `${group}:${row[field]}`.

This is what 0.56.0's boundary change was heading towards. Sync groups routed
delivery and did not decide authorization, so a model that used them as though
they did was relying on something the guide told you not to rely on. A declared
subject is that rule made real, checked in one place and failing closed.

Two consequences worth knowing. A subject-scoped model stamps exactly one group
on a change, because delivery matching is OR-based and a second group would
widen the audience rather than narrow it. And a tombstone now reaches only the
row's authorized subject group, where before a delete could be announced more
widely than the row ever was.

A schema that routes by sync group without a matching row-access policy is
flagged. If the routing really is only routing, acknowledge it explicitly and
the flag goes quiet.

### Creating many rows is one commit

`create` takes a list as well as a single row, under the same verb:

```ts
const rows = await ablo.weatherReports.create({
  data: [
    { location: 'Stockholm', summary: 'Clear' },
    { location: 'Oslo', summary: 'Rain' },
  ],
});
```

They are written as one atomic commit rather than one request each, so either
every row lands or none does. The result comes back in the order you gave it,
not the order the batch settled, and carries whatever defaults the server
stamped. An empty list writes nothing rather than opening an empty commit.

### Reading a whole collection, in as many words

`listAll({ where, maxPages, signal })` reads a complete collection by walking the
same cursor `list` returns, so the common case stops being a hand-rolled loop:

```ts
const open = await ablo.weatherReports.listAll({
  where: { status: ['draft', 'review'] },
  maxPages: 20,
});
```

It is bounded on purpose. `maxPages` is how you say how much you are willing to
read, and `signal` cancels a walk that is taking longer than the work is worth.
A complete read that cannot say when it will stop is how a page turns into an
outage.

### A claimed write carries its stale guard again

Holding a claim and then writing gave mutual exclusion but not lost-update
detection, on the stateless transport agents run. The claim handle carries the
position the row was read at, and the write defaults to rejecting on a change
since then. Unwrapping the handle cleared the claim before that default was
read, so the guard was unreachable and every model write through the public
surface lost it.

It read as though both protections were present: claim, read, decide, write. The
watermark now travels with the handle, and your own `readAt` or `onStale` still
win where you set them.

### A create on an id that already exists is refused

It reported success and returned a row. A caller-selected id is a claim about
which row this is, so a create that finds one already there is a conflict rather
than an update, and it now says so.

### CLI: a session route that revalidates before it mints

`ablo init` scaffolds a Next.js session route that re-checks membership at mint
time rather than trusting the caller, and puts secret clients behind the
framework's `server-only` boundary so a key cannot be imported into a component
that ships to a browser.

### Filtering a server read by a reference field

`list({ where: { issueId } })` matched nothing on a replicated plane. It raised
no error and returned a well-formed empty array, so the read looked like a
question with no answers rather than a filter that never ran. Filtering on
`id`, `title` or `body` worked, which made the failure look like a property of
the data instead of a property of the field name.

The cause was a key space. A row served from the log is a snapshot in the wire
shape, so its fields are spelled the way your schema spells them, while the
filter looked them up by their database column. Those two agree exactly when a
column is a single word, and part ways on every `issueId`, `teamId` or
`assigneeId`. Ordering, relation expansion and any field declared with
`.from()` were reading the same wrong spelling: a `related` list came back
empty, and a `.from()` field was simply absent from the row.

If you page a collection and filter it in your own code to work around this,
that code can go.

A filter naming a field the model does not declare is now refused, with the
same error the direct-database plane already gave it. It used to return
nothing, which reads as an answer.

### A list read walks its own pages

`list` returns a page, and a page of 20 looks exactly like a complete answer of 20. Every caller either checked `hasMore` or, more often, reasoned about a
truncated collection without knowing there was more.

Iterate the result for the page. Walk it for the collection:

```ts
for await (const issue of await ablo.issues.list({ where: { teamId } })) {
  …
}
```

`hasMore` and `nextCursor` are unchanged, and taking the cursor yourself is
still the right thing when the pages go somewhere other than a loop.

### Clearing a field

`null` clears a field, and the types now say so. They used to accept only the
field's own type or `undefined`, and `undefined` means "leave this alone": it
is dropped from the payload, so an unassign written that way kept the old
assignee and reported success. The only spelling that both compiled and worked
was one that cast the payload, which turned off type checking for the whole
write.

Only a field your schema declares optional accepts `null`. A required field has
no empty value to move to, and the type says that too.

### A write that does not name its row is refused

`delete({ where: { id } })` reads like it should work, and `where` is what the
commit protocol takes one layer down. It used to spell the missing id into the
request as the literal text `undefined`, match no row, and return an ordinary
receipt. It now fails at the call, naming the model, the action, and `{ id }`.

The same guard covers `update`.

### A create honours the id you gave it

An id passed inside `data`, which the create input has always allowed, was
never read: the row was written under a generated id and you were handed back
one you had not named. Both spellings now work, and the standalone `id` wins if
they disagree.

### Every response says what your allowance is

The limiter knew the allowance and the refill and told you neither, so the only
strategy available was to retry and find the wall again.

```
RateLimit-Policy: "secret";q=600;w=12
RateLimit: "secret";r=573;t=8
Retry-After: 3
```

`RateLimit-Policy` is the standing allowance and is always present.
`RateLimit` reports what is left and when it refills, once a request is
attributed to a key. A 429 adds `Retry-After` in whole seconds. Pace against
these rather than retrying blind.

### A route says when it is going away

Every response carries `Ablo-Version`, a date stamp for the contract being
served, so a caller can notice the contract moved under it.

A route being withdrawn now says so on itself for at least 180 days first.
`Deprecation` (RFC 9745) carries when the deprecation took effect, and the route
keeps answering; `Sunset` (RFC 8594) carries when it stops. The same operations
are marked `deprecated: true` in the OpenAPI document, so a generated client
sees it too.

Breaking changes still arrive as a new path segment beside `/v1`, never as a
change to it. Additive ones land in `/v1`, so ignore what you do not recognise.

### The documentation answers a reader that is not a browser

The surfaces `llms.txt` names are routes now rather than a promise:
`/llms-full.txt` for the whole corpus in one fetch, `/openapi.json` for the REST
contract, `/developers` naming every developer surface on one page,
`/.well-known/mcp.json` for the MCP manifest.

Every page also answers from its own URL in Markdown. Send
`Accept: text/markdown`, or append `.md` where a client cannot set headers.
Responses carry `Vary: Accept`, a client that will take neither type gets a 406
listing what is available, and a path that does not exist answers a real 404
rather than a 200 carrying a sign-in page.

### Renamed and removed

`SourceRequestContext.requiredSyncGroups` is now `syncGroups`. Ablo populates
both spellings this release, so a source adapter still reading the old name gets
the groups rather than `undefined`, which on a routing field would read as "no
groups" rather than as a field that moved. The old spelling is removed in
0.58.0.

`DeltaPosition`, `deltaPositionSchema`, `ReadSetWatermark`, and
`readSetWatermarkSchema` are removed, as 0.56.0 announced. Use `LogPosition` and
`logPositionSchema`, which they have resolved to since then.

## 0.56.0

### Coordination reads are scoped to the customer, not the organization

Coordination has always been scoped to the organization, and through 0.51.0 that
was the whole boundary: a platform gave each customer its own organization, and
the sessions guide was explicit that sync groups decide which changes travel
rather than what a session may read.

This release moves that line. A platform's customers are rows in its own schema,
reached by the sync groups on the session, so many customers share one
organization and the organization is no longer the finest boundary. The delivery
path already applied the finer cut. The claim listing and the presence read did
not, so under that newer arrangement one customer could see which rows another
had claimed, who held them, what the work was called, and who was online. Row
contents were never exposed; everything around them was.

Both reads now take the same cut, from the groups each side already carries.

If you give each customer its own organization, nothing changes for you and
nothing was reachable across customers. If you serve many customers from one
organization, this closes the gap with no change on your side.

### A client converges on the head it was measured against

Catch-up measured the plane head, paged the log under the client's own scope, and
then set the cursor to the last row that scope happened to contain. On a plane
carrying traffic the client cannot see, that row sits below the head. Where the
scope held nothing at all, the cursor never moved.

The client half was the mirror image: it reconciled in one direction only and
could not adopt a head above its own. Together those left a client permanently
behind, and the catch-up poll turned that into standing load, taking the plane's
advisory lock every thirty seconds to find the same gap and serve the same
nothing. The head reads a global sequence, so on any deployment with more than
one active writer plane this was every client rather than an edge case.

The server now advances to the head it measured, and the client adopts a head
above its cursor when the response carries no deltas, because an empty response
is proof rather than a hint.

### A replicated array column arrives as an array

Every array column read through replication arrived one level too deep: `{a,b}`
as `[["a","b"]]`, and `{}` as `[[]]`. The driver's array parsers expect the
literal without its leading brace, and given the whole literal they read that
brace as the start of a nested array. The control plane refused such a value
outright; a `text[]` column in your own database would have carried it into the
log silently.

### `ablo doctor` separates two different failures

A plane where nothing routed at all and a plane where some changes did not have
different causes, so they no longer read the same:

```
  ✗ delivery   no change reached anyone (41 in the last hour)
               → run `ablo check`. When nothing routes, the tenancy value is usually missing for the whole plane rather than for particular rows.
```

### `LogPosition` is the one name for a position in the log

`DeltaPosition`, `deltaPositionSchema`, `ReadSetWatermark`, and
`readSetWatermarkSchema` still resolve to it and are removed in 0.57.0. Where a
position needs an owner, the owner goes in the field name rather than into a
second type.

`ABLO_DOCS_BASE_URL` and `ABLO_SITE_BASE_URL` are exported for tools that link
back to the documentation.

### What an organization is, and what your customers are

The customer-organizations guide is rewritten around the distinction it kept
blurring. An organization is a team account: people join it with their own
logins, and share what it owns and is billed for. Nobody invites their customers
into that.

So a platform's customers are not organizations, and they are not projects
either, since a project is bound one to one to a database schema and an account
with four applications could no longer say which of the four a customer belonged
to. They are rows in the platform's own schema, reached by the sync groups on the
session: the account is ambient and derived from the key, the customer is a plain
row, and the session is minted against one of them.

## 0.55.0

### `ablo doctor` says whether the writes reached anyone

Every other check asks whether something is configured. This one asks what
happened to the last hour of changes, which is the question the rest can all be
green through: a commit confirms, the row appears in your database, and no
subscriber is ever told.

```
  ✓ delivery   41 changes in the last hour, all deliverable
```

and when they did not:

```
  ✗ delivery   3 of 41 changes in the last hour reached nobody (e.g. reports/rep_8c2)
               → run `ablo check`. Rows written to Postgres outside Ablo carry no tenancy value, so nothing can route the change.
```

A change Ablo cannot route is excluded from delivery and counted at the moment
it happens, so this is the engine's own record rather than something inferred
afterwards. When a change is undeliverable the report names one model and row,
because that is what turns "realtime is broken" into something you can open.

A server too old to answer the question reports the check as not determined
rather than as healthy. That distinction is the point of the check: folding an
unanswered question into a pass would report health the plane never claimed.

### `ablo check` counts rows the sync layer cannot see

A model having a tenancy column was treated as the whole question. Ablo stamps
that value on the writes it makes, but a seed, a migration, or a backfill that
inserts straight into Postgres does not, and a row without it can never be routed
to anyone: it lands, it is queryable in Postgres, and the sync layer cannot see
it.

Those rows are counted now, so a report reading "23 models, 23 ok" over a table
full of them is no longer possible. The count stops at a cap, because the answer
that changes what you do next is whether there are any, and an uncounted scan of
a large table is not something a command you run on a whim should cost.

### `GET /v1/logs/delivery`

The endpoint behind the check, for building your own monitoring:

```
{ "object": "log_delivery", "window_seconds": 3600,
  "recorded": 41, "unroutable": 3,
  "sample": { "model": "reports", "id": "rep_8c2", "at": "2026-08-19T09:12:04Z" } }
```

Counts and at most one sample, never row data. The window it counted is in the
response, so nothing has to assume one.

### Removed

`CapabilityExchangeResponse` is removed, as 0.54.0 announced. Use
`CapabilityMintResponse`, which it has resolved to throughout.

## 0.54.0

### A scoped session is scoped everywhere it is read

Seven surfaces each answered "which sync groups may this request see", and two of
them consulted only `effectiveSyncGroups` before falling back to an
organization-wide anchor. `syncGroups` is the only field an `ek_` session key
populates, so a session scoped to one workspace was correctly narrowed on five
surfaces and read organization-wide on the other two. Nothing failed while they
disagreed, because each surface's tests pinned that surface to itself.

One module now owns the precedence, and a plane states its difference as an
argument rather than as another copy of the rule. A declared set that is empty
means nothing rather than everything, so a session minted with no groups closes
instead of widening.

### A change reaches the clients watching it, whatever the column is called

Deltas were written in two key shapes. The commit path wrote declared schema
field names; the replication echo wrote the customer's physical column names
undecoded. Neither reader reconciled them, because the client applies a delta
onto the model verbatim.

For a source whose columns are renamed, by `.from(...)` or simply by being
snake_case, every change reached subscribers keyed wrong, and the lookup that
stamps a scope-root group found nothing on a physical row. Such a delta kept only
its organization group, so a client joined to `workspace:<id>` was never sent a
change it was watching: the write landed, and nothing was announced to anyone
listening. Rows are renamed once now, where they enter, and one spelling holds
below that seam.

### Reordering a claim queue takes effect

A reorder took effect for nobody. The route addressed the frame to an
organization group, which entity-scoped fan-out removes, so the frame was built
and then dropped as having no audience. A queue change now goes to the waiters in
that line, each of which recorded what it listens on when it enqueued.

### A commit costs a fixed number of round trips

A direct write paid three round trips to the customer's database plus one per
row. Sharing a region that is a few milliseconds, but across continents it
dominated the wait: an engine in `eu-north-1` against a database in `us-east-2`
measured about four seconds per confirmed write, most of it in trips nobody had
counted.

Three changes remove trips without altering what the database sees. The session
bundle is one statement over parallel name and value arrays rather than eleven
settings awaited in turn, and is still transaction-scoped. The ledger completion
and the replication marker travel as one data-modifying statement, which Postgres
runs to completion whether or not the primary query reads it. And a direct commit
dispatches its operations before awaiting any of them, so the driver pipelines
them.

Ordering is unchanged: Postgres still runs those operations in order on the
connection, so a later one still sees an earlier one's write, two writes to the
same row stay well-defined last-write-wins, and each operation keeps its own
error so a failure still names itself.

### Engine-reserved groups have a constructor

`identityAnchor` builds the sync groups the engine reserves, so the `kind:id`
convention has one home instead of being spelled inline:

```ts
import { identityAnchor } from '@abloatai/ablo/schema';

identityAnchor('org', organizationId);
identityAnchor('user', participantId);
identityAnchor('project', projectId);
```

`IDENTITY_ANCHOR_KINDS` and `IdentityAnchorKind` are exported alongside it.
Schema-declared roles continue to extend this vocabulary per application; these
three are the kinds the engine reserves.

### The cross-organization scope is `organization:act-as`

The scope authorizing a secret key to mint a session into another organization is
now `organization:act-as`, and it names what it grants rather than the mechanism
it was first attached to. Keys already carrying `ephemeral:mint-any-org` keep
working, because the old spelling resolves to the new one.

### An outbox event carries declared field names

A hand-written `events` handler must key its `data` by the model's declared
schema fields rather than by the table's columns. A field named `reviewStatus`
arrives as `reviewStatus` even when it reads from a `review_status` column:

```ts
// the model declares reviewStatus from a review_status column
data: { id: row.id, reviewStatus: row.review_status },
```

Ablo's own adapters rename the row before writing the outbox, so a source built
on one of them is already in this shape. Ablo reads that spelling and never falls
back to the physical one: two namespaces that can collide have no safe merge, and
a key read as the wrong field would route a change into another scope root.

### CLI: report what got in your way

`ablo feedback` is the channel for the two things no counter can carry, because
neither is a sentence: the doc that was missing, and the thing that worked but
was hard.

```
ablo feedback docs "no example of paging a filtered list" --yes
```

`<kind>` is `bug`, `docs`, `feature`, or `friction`. Add `--detail <text>` for
the long version, where `-` reads stdin, and `--command` or `--error-code` to
pre-group the report from what you just saw. `--yes` sends without confirming
and `--json` returns a machine-readable receipt, so a non-interactive caller
needs no terminal.

It is never automatic. Nothing sends unless the command is run, and nothing
rides the telemetry queue, so turning telemetry off does not also turn off bug
reporting, and leaving it on does not start sending prose. The text is redacted
before it leaves, by the same rule error observations already pass through, and
on a terminal you see the redacted version before it is sent. Nothing is read
from your repository, and there is no flag to attach a file.

### Removed

`normalizeAbloHostedBaseUrl` is removed, as 0.53.0 announced. Use
`normalizeAbloBaseUrl`, which the old name has resolved to since then.

`CapabilityExchangeResponse` is announced for removal in 0.55.0. Use
`CapabilityMintResponse`; both already resolve to the same contract.

## 0.53.0

### A collection read says where the collection ends

`list` returns a page. The result is still an array, so it maps, spreads, and
iterates exactly as before, and it now carries `hasMore` and `nextCursor` beside
the rows. Pass `nextCursor` back as `cursor`, keeping `where` and `orderBy` the
same, to walk the rest:

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

A list read has always been a page: the server applies a default size and caps
the largest one. Until now that page state was dropped on arrival, so a read
that returned twenty of five hundred matching rows looked exactly like a
complete one. Check `hasMore` before treating a result as the whole set.

The live client keeps a local graph and loads a working set rather than pages, so
it rejects `cursor` instead of returning the first page again. Narrow the
`where`, or construct the client with `transport: 'http'` to page. On the live
client `hasMore` reports whether a `limit` cut the working set short, and
`nextCursor` is `null`.

`GET /v1/projects` returns the same list envelope as every other collection,
with `has_more` and `next_cursor` beside `data`.

### The page cursor is called `cursor`

The parameter that resumes a collection is `cursor`, in the SDK and on every
HTTP collection route. It was `starting_after`, a spelling whose established
meaning elsewhere is a row id, while this value has always been an opaque token
tied to the sort it was issued for. A caller who read the familiar name and
passed a row id was refused, so the name promised something it never did.

`starting_after` is still accepted on the wire and is removed in a later
release. Requests that send it keep working; new code should send `cursor`.
Sending both uses `cursor`. The MCP `list_records` tool and the OpenAPI
description take `cursor`, and the spec marks the old name deprecated.

### A filter reaches the server intact

`where` accepts operators as well as equality. An array value is an `IN`, and
tuple form spells the rest out:

```ts
const storms = await ablo.weatherReports.list({
  where: [
    ['title', 'ILIKE', '%storm%'],
    ['createdAt', '>=', cutoff],
    ['status', 'IN', ['draft', 'review']],
  ],
});
```

Clauses combine with AND. For OR, run two reads and union the results.

On the stateless client (`transport: 'http'`) an `IN` filter and every
tuple-form clause were previously discarded before the request left, and the
read came back unfiltered. An agent or worker that filtered a collection over
HTTP was reading more rows than it asked for, with nothing to indicate it. Every
transport now encodes a filter the same way.

A filter on a boolean field could also match the opposite rows rather than fail,
when its value arrived as the database's own text spelling. Boolean values are
coerced before binding, and read back the same way.

### A number field reads back as a number

A field declared as a number arrives as one whatever integer width its column
uses. A wide column previously came back as a decimal string while its narrower
neighbour came back as a number, so the type a caller received depended on a
database detail the schema had already settled.

A stored value beyond the range a JavaScript number represents exactly now fails
with `column_value_out_of_range` rather than arriving quietly rounded. Declare
such a field as text to read those values digit for digit.

### A reconnect cannot roll back a confirmed write

Each row in the live client records the log position it reflects. A bootstrap or
an on-demand read from an earlier position is left unapplied, so a snapshot that
arrives late no longer overwrites a row the client already knows to be newer.
The ordered change stream continues to carry every other writer's edits. A
plugin receives that position as `syncId` on `AppliedChange`.

### The base URL is checked where the credential travels

`baseURL` accepts an HTTPS origin, preserving a path prefix for a deployment
mounted under one, and plain HTTP for localhost. A URL that embeds its own
credentials, or carries a query or a fragment, is refused when the client is
constructed rather than failing later as an opaque request error. Every request
attaches the resolved key against this origin, so the rule lives beside the
option rather than in each application that sets it.

`normalizeAbloHostedBaseUrl` is now `normalizeAbloBaseUrl`. The old name
resolves to the same function and is removed in 0.54.0.

### Two error codes added

`organization_disabled` is returned when an operator has disabled an
organization, and `query_relation_expansion_too_large` when a requested relation
expansion exceeds the nested-row budget. The error contract version is
`2026-08-15`.

### CLI

Where a command sends a management key is resolved and checked in one place: an
explicit `--url` on the commands that take one, then `ABLO_API_URL`, then the
hosted default. A host given without a scheme becomes absolute, and a
destination that would put the key on the wire in clear, or one carrying its own
credentials, is refused before the request is made.

## 0.52.0

### Models carry only `id`

`createdAt`, `updatedAt`, `organizationId`, and `createdBy` are no longer added
to every model. Declare them as ordinary fields wherever you want them, and
declare them to keep reading and writing them if you relied on Ablo supplying
them. Ablo still records who made each change in its own transaction log, and
still owns the tenancy value on every write.

A model can point at a table Ablo did not create, naming the columns that
differ:

```ts
import { defineSchema, field, model } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  itemEvents: model(
    {
      itemId: field.string().from('item_id'),
      createdAt: field.number().from('created_at'),
    },
    { tableName: 'item_events' }
  ),
});
```

Database adapters accept identifiers the database generates and return them as
canonical string ids, taking the id type from the connection rather than from
the model.

### Updates can carry a precondition

An update operation accepts `where`. The database changes the row only while its
current values still match. On a mismatch the commit fails with
`precondition_failed` and the whole batch declines, leaving every operation in it
unapplied. The Kysely source adapter supports preconditions; the Drizzle,
Prisma, and memory adapters report `source_adapter_misconfigured`.

### Commit receipts return the rows the database wrote

Receipts carry `operationResults`, pairing each operation's `transactionId` with
its outcome and the authoritative row the database transaction returned,
including identifiers and timestamps the database generated.

### Two error codes renamed

`task_id_missing` is now `item_id_missing`, and `task_id_required` is now
`item_id_required`. Neither old code was ever returned by a request, so a caller
matching on error codes has nothing to change unless it names one directly.

### CLI

`ablo setup` reads the repository and the current Ablo target, then prints the
decisions, actions, blockers, and postconditions a verified setup requires. It
reports and leaves the project untouched.

`ablo init --plan` shows every file action before any of it happens.

`ablo telemetry` controls limited CLI usage analytics. Collection is on by
default and stays off in continuous integration and whenever `DO_NOT_TRACK=1` or
`ABLO_TELEMETRY_DISABLED=1` is set. Run `ablo telemetry status` to see the
current state, `ablo telemetry disable` to turn collection off, and
`ablo telemetry reset` to rotate the local installation identity.

## 0.51.0

### One platform schema can serve every customer organization

Platforms no longer need to copy the same schema into every customer
organization. When a platform key creates a session for another organization,
Ablo now reads the schema from the platform's project while keeping every row
inside the customer's organization.

```ts
const { token } = await ablo.sessions.create({
  user: { id: userId },
  organizationId: customerOrganizationId,
  can: { records: ['read', 'update'] },
});
```

Most platforms need no schema option at all. Migrations and advanced routing can
still select one explicitly with `schemaProject`.

The sessions guide now draws a firm line between policy-scoped customers and
separate customer organizations. Sync groups decide which changes travel; they
do not authorize reads.

## 0.50.0

### Context can travel from reads to a model and back to a write

`context({ ablo, data })` brings together the information an action needs. It
awaits the values the application selected, returns them as typed `ctx.data`,
and carries exact Ablo rows into `ctx.reads` for the write that follows.

```ts
const ctx = await context({
  ablo,
  data: {
    record: ablo.records.get({ id: recordId }),
    records: ablo.records.list({ where: { recordId } }),
    memory: loadMemories(recordId),
  },
});

await ablo.records.update({
  id: recordId,
  data: result,
  reads: ctx.reads,
});
```

If an included Ablo row moved while the caller was thinking, the write is
refused. External memory, retrieval, extraction, and conversation values pass
through without acquiring that guarantee. `ctx.sources` keeps the difference
visible, including a `mixed` result when one value contains both kinds.

The optional `contextMessage()` formatter produces a user message for AI SDK.
Ablo does not take over the model loop, history, token policy, search, or memory.
The helper is a standalone `@abloatai/ablo/context` export, so `context` remains
available as a schema model name.

## 0.49.0

### An agent can tell Ablo what it read before it writes

An agent reads a row, spends a model call deciding what to do, and then writes.
Another agent can change that row while the model is still thinking, and the
write lands anyway, on top of a decision that is no longer true. Pass the rows
the decision was based on:

```ts
const record = await ablo.records.get({ id: recordId });
await ablo.records.update({
  id: record.id,
  data: { status: 'done', result: `Completed: ${record.title}` },
  reads: [record],
});
```

If either row moved while the agent was thinking, the write is refused instead
of overwriting. The rows carry that evidence themselves, so there is nothing to
set up around your agent and no wrapper to run it inside. One row or several,
the same row you are writing or a different one, all use `reads`. Rows an agent
read without passing stay out of it, so `reads` says what the decision rested on
rather than everything the agent happened to look at.

`idempotencyKey` stays a separate option. It gives a write one stable identity if
the agent retries, which is a different question from what the write assumed.

### A claim holds while an agent thinks

Agents that take minutes per turn can now hold work safely. A claim waits its
turn or skips, expires on its own, and keeps itself alive with a heartbeat while
the agent works.

If an agent loses its claim during a model call, its final write is refused. Two
agents cannot both believe they own the same record and both write, and a slow
agent cannot land its answer on top of whoever picked the work up after it. Ablo
decides who holds the claim, so an agent cannot assert one it does not have.

### An agent can read back what it committed

Ask what happened to a write, using the same key the agent wrote with:

```ts
const record = await ablo.commits.get({ id: commitId });
```

The answer says who committed, what they intended, whether it is confirmed, and
which claim protected it. `commits.list` walks the history a page at a time, so
one agent can review what another already did before repeating it.

What an agent sent is not kept. Prompts, reasoning, and your customers' row
values are removed before the record is stored, so reading history back never
replays an agent's inputs. Records are kept for 90 days, and permanently for a
database you connected.

### An agent can check what its key allows before it acts

An agent holding a key can now ask what that key permits and get the answer from
Ablo, whether it keeps a connection open or calls over HTTP for a single turn.
An agent that mints a narrower key for a sub-record can confirm what it handed
over.

### A refused action says which permission was missing

When Ablo refuses, the error names the permission the agent needed. An agent can
report exactly what it lacked, or request it, instead of retrying a call that
will never succeed.

### Models named in camelCase resolve when writing to your own database

A model whose key mixes capital letters did not match its declared name when the
write went to your database directly, so those writes could not find their
target. They resolve now.

### `ablo connect apply` says when a database is already connected

Connecting a database that another project already owns reported a missing table
mapping, which described a symptom rather than the reason the command could not
continue. It now says the database is already connected. Nothing is written
while it checks, and a project with no models still gets its preflight.

**Action required.** Install this version rather than a tarball or a Git
dependency. This release pairs the SDK with the engine running behind
`api.abloatai.com`, which is already serving it, so there is nothing to
coordinate on your side.

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

### `ablo dev --local` connects a branch to the database on your machine

The rule above raises a fair question: if a branch is unbound until a database
is connected, what connects one during development? `--local` does.

```bash
npx ablo dev --local
```

It registers a connector-only endpoint for that exact branch and opens a
long-lived secure connector. Your database stays where it is: Ablo receives an
endpoint descriptor and a signing key, never a connection string, and reaches
your source back through the connector rather than dialling it. `DATABASE_URL`
is read from `.env.local` into the handler running on your machine and goes no
further.

The branch is then connected like any other, so schema pushes, reads and writes
behave the way they will in production. Because the connector is long-lived,
`--local` cannot be combined with `--no-watch`.

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
deployment carrying an unrelated key now fails with `project_scope_denied`; a
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
const claim = await ablo.records.claim({
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
shared-data authority, claims, conflicts, idempotency, confirmation, and ordered
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
idempotency, confirmation, and ordered changes. Authoritative reads use
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
