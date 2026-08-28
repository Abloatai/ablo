# API

> The per-method reference for every model call an agent or an interface can make.

> **Upgrading?** Follow the version-matched workflow in the
> [Upgrade Guide](./migration.md), then read the intervening changelog entries.

This is the per-method reference for reading and writing rows that stay in
sync across sessions. You declare your models once, then call the same
`ablo.<model>` methods from React, a server action, or an agent — and every
confirmed write streams to everyone watching. When two writers touch the same
row, you can optionally `claim` it so they serialize instead of clobbering
each other.

Three things to know before the method list. **`get` observes; `read` declares.**
Both fetch one current row, but only the exact object returned by `read({ id })`
can be carried in a mutation's `reads` array. If it changed, that mutation does
not land. `get({ id })` and `list({ where })` are ordinary queries with no stale
guard. **Local reads do not fetch.** Put `local.` in front of a query and
you get the same read restricted to what is already here, which is why it can
return a value rather than a promise: `local.get(id)`, `local.list({ where })`,
`local.count({ where })`. Use those in render, after data has synced.
**Claims don't lock.** If another writer holds the row, `claim` waits
for them, re-reads the fresh row, then hands it to you — so two writers
serialize instead of clobbering.

Start with the schema client:

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
  }),
});

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

await ablo.ready();
const report = await ablo.weatherReports.read({ id: 'report_stockholm' });
if (!report) throw new Error('Row not found');

await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  reads: [report],
});
```

For end-to-end app setup across React, existing backends, Data Source, and
agents, read the [Integration Guide](./integration-guide.md).

## Model Methods

Each schema model becomes a typed model on the client:

- `ablo.weatherReports.get({ id })` fetches one row without declaring a decision dependency.
- `ablo.weatherReports.read({ id })` fetches one guardable decision input.
- `ablo.weatherReports.list({ where })` fetches an observational collection.
- `ablo.weatherReports.listAll({ where })` explicitly reads every matching page.
- `ablo.weatherReports.local.get(id)` reads one row synchronously from the local graph.
- `ablo.weatherReports.create({ data })` creates a row.
- `ablo.weatherReports.update({ id, data, ...options })` updates a row.
- `ablo.weatherReports.delete({ id, ...options })` deletes a row.
- `ablo.weatherReports.claim({ id, description })` acquires a durable write lease; the HTTP form is awaited.

`local.` narrows a query to what has already synced. `get({ id })`, `read({ id })`, and
`list({ where })` answer from the local graph and fall back to IndexedDB and
then the network, so reach for them when the row may not be here yet.
`local.get(id)` and `local.list({ where })` are the same reads with the
fallback removed — nothing to await, so they return a value.

| Method | Returns | Use when |
|---|---|---|
| `get({ id })` | `Promise<T \| undefined>` | You need to observe one current row. |
| `read({ id })` | `Promise<CapturedRow<T> \| undefined>` | A later mutation is based on this row. |
| `list({ where })` | `Promise<ModelList<T>>` | You need to observe a collection. |
| `listAll({ where, maxPages?, signal? })` | `Promise<T[]>` | You deliberately need every matching row. |
| `local.get(id)` | `T \| undefined` | You want a synchronous snapshot of one local row. |
| `local.list(options?)` | `T[]` | You want a synchronous snapshot of a local collection. |
| `local.count(options?)` | `number` | You want a synchronous count of local rows. |
| `create({ data, ...options })` | `Promise<T>` | You want to create through the schema model. |
| `update({ id, data, ...options })` | `Promise<T>` | You want to update through the schema model. |
| `delete({ id, ...options })` | `Promise<void>` | You want to delete through the schema model. |
| `claim({ id, description })` | `Promise<HeldClaim<T>>` | Slow or expensive work must exclude another writer. |
| `claim.state({ id })` | `Promise<Claim \| null>` on HTTP | You need the current holder without acquiring the row. |
| `claim.list({ id })` | `Promise<{ object: 'list'; data: Claim[] }>` on HTTP | You need every disjoint holder on the row. |
| `claim.queue({ id })` | `Promise<ClaimQueueView>` on HTTP | You need the durable wait line. |
| `claim.release({ id })` | `Promise<void>` on HTTP | You need to release a claim early. |
| `claim.reorder({ id, order })` | `Promise<void>` on HTTP | A privileged coordinator needs to reorder the wait line. |

`get`, `read`, `list`, `create`, `update`, `delete`, and `claim` go
through the server. The `local` reads work off the rows a session has already
synced, so a cheap re-read needs no round-trip.

## Atomic commits

Use one `ablo.commits.create` when several Ablo model writes must all land or
none may land. Put every operation in `operations` and every exact row returned
by `read` that influenced the batch in the top-level `reads` array.

```ts
import { AbloStaleContextError } from '@abloatai/ablo';

const task = await ablo.tasks.read({ id: taskId });
if (!task) throw new Error('task not found');

try {
  await ablo.commits.create({
    operations: [
      {
        action: 'update', model: 'tasks',
        id: task.id,
        data: { status: 'done' },
      },
      {
        action: 'create', model: 'tasks',
        id: markerId,
        data: { title: 'atomic marker', status: 'done' },
      },
    ],
    reads: [task],
  });
} catch (error) {
  if (error instanceof AbloStaleContextError && error.code === 'stale_context') {
    console.log(error.code);
  } else {
    throw error;
  }
}
```

The server checks the premises and applies the operations in one transaction.
If any premise is stale or any operation fails, no operation lands. Independent
model calls are not an atomic batch. External effects and application-owned
Postgres writes cannot join this commit; keep those in their existing
transaction or outbox.

### Reading a whole collection

Prefer a filtered `listAll` when the application truly needs one complete
array. It follows the same cursor loop as async iteration, defaults to at most
100 pages, and checks an abort signal between requests and rows:

```ts
const controller = new AbortController();
const open = await ablo.weatherReports.listAll({
  where: { status: ['draft', 'review'] },
  orderBy: { createdAt: 'asc' },
  maxPages: 25,
  signal: controller.signal,
});
```

A complete traversal can be expensive in latency, memory, and read volume.
Narrow it with `where`; use `list` and its cursor when a UI or worker can process
one page at a time.

`for await` walks the pages:

```ts
const open = [];
for await (const report of await ablo.weatherReports.list({
  where: { status: ['draft', 'review'] },
  orderBy: { createdAt: 'asc' },
})) {
  open.push(report);
}
```

`list` returns a page, because the server applies a default size and caps the
largest. The result is an array, so it maps and iterates as before, and it
carries `hasMore` and `nextCursor` alongside the rows. Iterate it to work with
the page you were handed; `for await` it to work with the collection.

```ts
const page = await ablo.weatherReports.list({ where: { status: 'draft' } });
page.length;    // the rows this page carries
page.hasMore;   // whether the collection continues past them
```

Take the cursor yourself when the pages go somewhere other than a loop — one
screenful at a time, or a job that stops and resumes:

```ts
const page = await ablo.weatherReports.list({ where: { status: 'draft' }, limit: 100 });
const next = page.hasMore
  ? await ablo.weatherReports.list({ where: { status: 'draft' }, limit: 100, cursor: page.nextCursor })
  : null;
```

Keep `where` and `orderBy` the same across pages: the cursor encodes the sort
position it was issued for, and a read that changes either starts a new walk.

`where` accepts operators as well as equality, and both travel to the server:
`{ status: ['draft', 'review'] }` is an `IN`, and tuple form spells the rest
out, as in `[['title', 'ILIKE', '%storm%'], ['createdAt', '>=', cutoff]]`.

### Changing a field, and clearing one

`null` clears a field:

```ts
await ablo.weatherReports.update({ id, data: { reviewerId: null } });   // unassigned
await ablo.weatherReports.update({ id, data: { reviewerId: 'usr_2' } }); // reassigned
```

An update is a patch, so a field you leave out keeps its value. That makes
`undefined` and "leave it alone" the same thing: `{ reviewerId: undefined }`
is dropped from the payload and the old reviewer stays. Reach for `null`
whenever a value is going away, and the type will hold you to it — only a
field your schema declares optional accepts one, since a required field has no
empty value to move to.

## Guarded Writes

Use `read` when a write depends on the row's current state, then pass that exact
row in `reads`:

```ts
const report = await ablo.weatherReports.read({ id: 'report_stockholm' });
if (!report) throw new Error('report not found');

await ablo.weatherReports.update({
  id: report.id,
  data: { status: 'ready' },
  reads: [report],
});
```

Reactive local state changes optimistically at call time; awaiting the model
write waits for authoritative confirmation.

If the row changed after `read`, the write rejects with
`AbloStaleContextError`. Ablo retains only model, id, and the read watermark as
evidence; it does not record the row contents. A write without `reads` is an
intentional unconditional assignment.

Write options:

| Option | Purpose |
|---|---|
| `reads` | Exact rows returned by `read` that the mutation depends on. |
| `idempotencyKey` | Stable key for retry-safe writes. The SDK generates one when omitted. |
| `timeout` | Maximum time to wait for the write call. |

## Claims

Before anyone writes a row, they can claim it so other agents and people see
who is editing it in real time. Claims don't lock. If another writer holds the
row, `claim` waits for them, re-reads the fresh row, then hands it to you — so
two writers serialize instead of clobbering. A claim is temporary: it expires
on its own if the holder stops, and is never saved as a row.

You coordinate a row with calls on its model, beside `create`/`update`/`get`:
`ablo.<model>.claim({ id })` takes the claim and returns a handle,
`ablo.<model>.claim.state({ id })` reads who currently holds it, and
`ablo.<model>.claim.release({ id })` releases it early. These reads are synchronous
on the stateful client and awaited server calls on the HTTP client. The full
coordination surface is `claim.state({ id })` / `claim.list({ id })` /
`claim.queue({ id })` / `claim.release({ id })` /
`claim.reorder({ id, order })` hanging off `claim`.

The fields on a claim, its lifecycle diagram, and the full method surface are in
[Coordination](./coordination.md#the-claim-state-object), which is where that
object is defined. Note that the entity half of `target` is spelled `model`/`id`
on the SDK's model surface and `type`/`id` on the claim handle and the wait
line.

### Reading and claiming

`claim.state({ id })` is the read side for observers and returns the current claim
state object (or `null`). It reads the stateful client's local cache synchronously;
the HTTP client returns a promise because it asks the server. `claim({ id })` is the write
side: it takes the claim and returns a `ClaimHandle`. Claims don't lock — if someone else
already holds the row, `claim` waits for them to finish, re-reads the fresh row,
then hands it to you, so you always proceed from current state. Default reads
return the row even while someone is mid-edit; if a server read should not
return a row while it's claimed, pass `ifClaimed: 'fail'` to error out instead.
Reads never block on a claim — to wait for a row to free up, `claim({ id })` it
(the claim queues fairly behind the holder).

```ts
const claim = await ablo.weatherReports.claim.state({ id: 'report_stockholm' });
if (claim) {
  claim.heldBy;
  claim.description;
}

const handle = await ablo.weatherReports.claim({
  id: 'report_stockholm',
  description: 'editing',
  ttl: '2m',
});
await ablo.weatherReports.update({
  id: handle.data.id,
  data: { status: 'ready' },
  claim: handle,
});
await handle.release();
```

Writes go through the normal model mutation and pass the held handle as `claim`.
That explicit handle carries commit-time fencing. If the row changed underneath
you since you took the claim, the update rejects with `AbloStaleContextError`,
so you re-read before retrying.
Call `handle.release()` (or `ablo.weatherReports.claim.release({ id })`) to release
the claim when your work is done.

## Agent

Most agents should import the same schema as the app and call
`ablo.<model>.list(...)`, `ablo.<model>.claim({ id })`, and
`ablo.<model>.update({ id, data })`.

## HTTP API

The SDK is a convenience wrapper over a model-scoped HTTP surface — the same
noun (`model`) and verbs as `ablo.<model>.…`. Non-JS callers (or curl) use it
directly. The table below shows the shape with `{model}` as a placeholder; the
[OpenAPI spec](./openapi.json) expands it into one **typed** path per model
(`/api/v1/models/record`, `/api/v1/models/workspace`, …, generated from your schema) so each
endpoint documents that model's real field contract instead of a generic blob.

| SDK call | HTTP |
|---|---|
| `ablo.<model>.create({ data })` | `POST /api/v1/models/{model}` |
| `ablo.<model>.list({ where })` | `GET /api/v1/models/{model}` |
| `ablo.<model>.read({ id })` | `GET /api/v1/models/{model}/{id}` |
| `ablo.<model>.update({ id, data })` | `PATCH /api/v1/models/{model}/{id}` |
| `ablo.<model>.delete({ id })` | `DELETE /api/v1/models/{model}/{id}` |
| `ablo.<model>.claim({ id })` | `POST /api/v1/models/{model}/{id}/claim` |
| (release a claim) | `DELETE /api/v1/models/{model}/{id}/claim` |

Auth is a bearer API key: `Authorization: Bearer sk_…`. Mutations take an
`Idempotency-Key` header — derive it from the business event, not a random
value, so a retry never double-writes. Direct HTTP writes return a protocol
receipt; the typed SDK turns single-model writes into their application result
(the created or updated row, or nothing for delete). A rejected write carries an
error `code` (e.g. `stale_context`, `intent_conflict`) to act on.
`GET /api/v1/models/{model}` is cursor-paginated (`limit`, `order`, `order_by`,
`cursor`) and returns `{ data, has_more, next_cursor }`. The `starting_after`
spelling this parameter used through 0.52.0 is still honoured, and is removed in
a later release.

`POST /api/v1/commits` remains the path for **atomic multi-op** writes (several
operations across rows/models that must commit together) — the per-model routes
above are the one-record path. Both run the identical guarded-write engine.

The [coordination MCP server](./mcp.md) (`@abloatai/mcp`) is this same surface
rendered as agent tools.

## Errors

All SDK errors extend `AbloError`. `type` is the class-name discriminator, such
as `AbloStaleContextError`; `code` is the wire condition, such as
`stale_context`. Use `instanceof` in-process and `type` after serialization.

| Error | Meaning |
|---|---|
| `AbloAuthenticationError` | Missing, invalid, or expired credential. |
| `AbloPermissionError` | Credential is valid but the action is outside scope. |
| `AbloRateLimitError` | Rate limit or quota exceeded. |
| `AbloIdempotencyError` | Idempotency key was reused with a different request. |
| `AbloConnectionError` | Network, timeout, abort, or transport failure. |
| `AbloValidationError` | Invalid input. |
| `AbloServerError` | Server-side 5xx. |
| `AbloStaleContextError` | `readAt` no longer matches current state. |
| `AbloClaimedError` | Active claim conflict or claim wait timeout. |

See [Client Behavior](./client-behavior.md) for retry and timeout guidance.
