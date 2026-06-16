# API

> **Upgrading?** Every breaking change and its migration is on the
> [Version History & Migration Guide](./migration.md).

This is the per-method reference for reading and writing rows that stay in
sync across sessions. You declare your models once, then call the same
`ablo.<model>` methods from React, a server action, or an agent — and every
confirmed write streams to everyone watching. When two writers touch the same
row, you can optionally `claim` it so they serialize instead of clobbering
each other.

Two things to know before the method list. **Reads come in two flavors:**
`retrieve({ id })` / `list({ where })` are async and hit the server (use them when
the row may not be local yet); `get(id)` / `getAll({ where })` / `getCount({ where })`
are synchronous reads off the local graph (use them in render, after data has
synced). **Claims don't lock.** If another writer holds the row, `claim` waits
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
const report = await ablo.weatherReports.retrieve({ id: 'report_stockholm' });
if (!report) throw new Error('Row not found');

await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' }, wait: 'confirmed' });
```

For end-to-end app setup across React, existing backends, Data Source, and
agents, read the [Integration Guide](./integration-guide.md).

## Model Methods

Each schema model becomes a typed model on the client:

- `ablo.weatherReports.retrieve({ id })` reads one row asynchronously (server read).
- `ablo.weatherReports.list({ where })` reads a collection asynchronously (server read).
- `ablo.weatherReports.get(id)` reads one row synchronously from the local graph.
- `ablo.weatherReports.create({ data })` creates a row.
- `ablo.weatherReports.update({ id, data, ...options })` updates a row.
- `ablo.weatherReports.delete({ id, ...options })` deletes a row.

`retrieve`/`list` and `get`/`getAll`/`getCount` are not aliases. Use
`retrieve({ id })` or `list({ where })` when the row may not be local yet — they
hydrate pool → IndexedDB → network. Use `get(id)` / `getAll({ where })` /
`getCount({ where })` for a cheap synchronous snapshot of what is already in
the local graph.

| Method | Returns | Use when |
|---|---|---|
| `retrieve({ id })` | `Promise<T \| undefined>` | You need one row, hydrating from local store and server. |
| `list({ where })` | `Promise<T[]>` | You need to hydrate a collection from local store and server. |
| `get(id)` | `T \| undefined` | You want a synchronous snapshot of one local row. |
| `getAll(options?)` | `T[]` | You want a synchronous snapshot of a local collection. |
| `getCount(options?)` | `number` | You want a synchronous count of local rows. |
| `create({ data, ...options })` | `Promise<T>` | You want to create through the schema model. |
| `update({ id, data, ...options })` | `Promise<T>` | You want to update through the schema model. |
| `delete({ id, ...options })` | `Promise<void>` | You want to delete through the schema model. |

`retrieve`, `list`, `create`, `update`, and `delete` are the main path — they go
through the server. `get` / `getAll` / `getCount` are **synchronous reads**
off the rows a session has already synced, so a cheap re-read needs no round-trip.

## Protected Writes

Use `snapshot` when a write should reject if the row changed mid-flight:

```ts
const snap = ablo.snapshot({ weatherReports: 'report_stockholm' });

await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

Protected write options:

| Option | Purpose |
|---|---|
| `readAt` | The state cursor the write was based on. |
| `onStale` | Stale-state policy. Prefer `reject` for agent writes. |
| `wait` | `queued` resolves after local queueing; `confirmed` waits for server acceptance. |
| `idempotencyKey` | Stable key for retry-safe writes. The SDK generates one when omitted. |
| `timeout` | Maximum time to wait for the write call. |

## Claims

Before anyone writes a row, they can claim it so other people and agents see
who is editing it in real time. Claims don't lock. If another writer holds the
row, `claim` waits for them, re-reads the fresh row, then hands it to you — so
two writers serialize instead of clobbering. A claim is temporary: it expires
on its own if the holder stops, and is never saved as a row.

You coordinate a row with calls on its model, beside `create`/`update`/`retrieve`:
`ablo.<model>.claim({ id })` takes the claim and returns a handle,
`ablo.<model>.claim.state({ id })` reads who currently holds it (synchronous, never
blocks), and `ablo.<model>.claim.release({ id })` releases it early. The full
coordination surface is `claim.state({ id })` / `claim.queue({ id })` /
`claim.release({ id })` / `claim.reorder({ id, order })` hanging off `claim`.

### The Claim State Object

| Field | Type | Description |
|---|---|---|
| `object` | `'claim'` | String representing the object's type. |
| `id` | string | Unique identifier for the claim. |
| `status` | `'active' \| 'queued' \| 'committed' \| 'expired' \| 'canceled'` | The whole lifecycle, in one field. `active` is the holder; `queued` is a waiter in the FIFO line behind it. |
| `target` | `{ type, id, field? }` | What is being coordinated. |
| `action` | string | Human-readable phase — `'editing'`, `'writing'`, `'reviewing'`. |
| `heldBy` | string | Participant id holding the claim. |
| `participantKind` | `'user' \| 'agent' \| 'system'` | Who's behind it — a human (`user`), an AI (`agent`), or automated infrastructure (`system`). |
| `expiresAt` | string | Ms-epoch at which the server auto-expires it if the holder doesn't finish. |

```json
{
  "object": "claim",
  "id": "claim_3MtwBwLkdIwHu7ix",
  "status": "active",
  "target": { "type": "weatherReports", "id": "report_stockholm", "field": "status" },
  "action": "editing",
  "heldBy": "agent:report-writer",
  "participantKind": "agent",
  "expiresAt": "1716580000000"
}
```

### Lifecycle

```
            claim({ id })              update({ id }) lands
  (free) ───────────▶ active ───────────────────────▶ committed
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
        canceled                 expired
   (release w/o write)        (TTL; holder died)
```

A target is free when `ablo.<model>.claim.state({ id })` is `null`. Terminal
states drop out of the live stream, so a present claim is either `active` (the
holder) or `queued` (waiting in the FIFO line behind the holder; see
`claim.queue({ id })`).

### Reading and claiming

`claim.state({ id })` is the read side for observers: synchronous, never blocks, and
returns the live claim state object (or `null`). `claim({ id })` is the write
side: it takes the claim and returns a `ClaimHandle`. Claims don't lock — if someone else
already holds the row, `claim` waits for them to finish, re-reads the fresh row,
then hands it to you, so you always proceed from current state. Default reads
return the row even while someone is mid-edit; if a server read should not
return a row while it's claimed, pass `ifClaimed: 'fail'` to error out instead.
Reads never block on a claim — to wait for a row to free up, `claim({ id })` it
(the claim queues fairly behind the holder).

```ts
const claim = ablo.weatherReports.claim.state({ id: 'report_stockholm' });
if (claim) {
  claim.heldBy;
  claim.action;
}

const handle = await ablo.weatherReports.claim({
  id: 'report_stockholm',
  action: 'editing',
  ttl: '2m',
});
await ablo.weatherReports.update({ id: handle.data.id, data: { status: 'ready' } });
await handle.release();
```

Writes go through the normal `ablo.<model>.update({ id, data })`. While you hold
a claim on `id`, that `update` rejects with `AbloStaleContextError` if the row
changed underneath you since you took the claim, so you re-read before retrying.
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
(`/v1/models/task`, `/v1/models/deck`, …, generated from your schema) so each
endpoint documents that model's real field contract instead of a generic blob.

| SDK call | HTTP |
|---|---|
| `ablo.<model>.create({ data })` | `POST /v1/models/{model}` |
| `ablo.<model>.list({ where })` | `GET /v1/models/{model}` |
| `ablo.<model>.retrieve({ id })` | `GET /v1/models/{model}/{id}` |
| `ablo.<model>.update({ id, data })` | `PATCH /v1/models/{model}/{id}` |
| `ablo.<model>.delete({ id })` | `DELETE /v1/models/{model}/{id}` |
| `ablo.<model>.claim({ id })` | `POST /v1/models/{model}/{id}/claim` |
| (release a claim) | `DELETE /v1/models/{model}/{id}/claim` |

Auth is a bearer API key: `Authorization: Bearer sk_…`. Mutations take an
`Idempotency-Key` header — derive it from the business event, not a random
value, so a retry never double-writes. Writes return a `CommitReceipt`; a
rejected write carries an error `code` (e.g. `stale_context`, `intent_conflict`)
to act on. `GET /v1/models/{model}` is cursor-paginated (`limit`, `order`,
`order_by`, `starting_after`) and returns `{ data, has_more, next_cursor }`.

`POST /v1/commits` remains the path for **atomic multi-op** writes (several
operations across rows/models that must commit together) — the per-model routes
above are the one-record path. Both run the identical guarded-write engine.

The [coordination MCP server](./mcp.md) (`@ablo/mcp`) is this same surface
rendered as agent tools.

## Errors

All SDK errors extend `AbloError` and expose a stable `type` string.

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
