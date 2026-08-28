# Client Behavior

> Guarded writes, claim behavior, and which errors are safe to retry.

When several writers touch the same data at once — an agent worker, a Server
Action, a person in the browser — the SDK protects explicit read dependencies
and claims records across slow work. This page describes those guarantees and
which errors are safe to retry.

Claims don't lock. If another writer holds the row, `claim` waits for them, re-reads the fresh row, then hands it to you — so two writers serialize instead of clobbering.

## Constructor

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
  }),
});

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

The package-root export is the stateless HTTP client for agents, workers, route
handlers, and other server operations. See [Options](./options.md) for its exact
constructor reference. Live state and local reads are added through the
[React client](./react.md).

Your database connects out of band — through logical replication (`npx ablo
connect`), or the signed [Data Source](./data-sources.md) endpoint as the
fallback for databases that can't grant replication — so the client holds only
`apiKey`, never a connection string. See
[Connect Your Database](./data-sources.md) for the full setup.

## Model Methods

Each schema model becomes a typed model:

```ts
await ablo.ready();

const report = await ablo.weatherReports.read({ id: 'report_stockholm' });
const local = ablo.weatherReports.local.get('report_stockholm');

await ablo.weatherReports.create({ data: { location: 'Stockholm', status: 'pending' } });
await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' } });
await ablo.weatherReports.delete({ id: 'report_stockholm' });
```

On the reactive client, each model write changes local state optimistically
before the call returns. Its promise always waits for authoritative
confirmation, so `await update(...)` is the confirmation barrier.

Call `get`/`list` to observe, or `read` when a later mutation depends on the row.
After that, `local.get`/`local.list`/`local.count` read the already-synced data instantly with
no `await`, and stay reactive in render. Use the async pair to load, the sync trio
to read.

`local.list` accepts the same practical read options the React selector path uses:
`where`, `filter`, `orderBy`, `limit`, `offset`, and `state`. The `state`
lifecycle filter defaults to `'live'`; pass `'archived'` or `'all'` when you
intentionally want non-live rows.

## Multiplayer Behavior

Two writers both try to mark `report_stockholm` ready at the same time. To stop
the second write from silently overwriting the first, every participant goes
through the same model client path. A human Server Action, a browser view, and an
agent worker can all use `ablo.weatherReports`:

```ts
const report = await ablo.weatherReports.read({ id });
if (!report) throw new Error('Row not found');

await ablo.weatherReports.update({
  id,
  data: patch,
  reads: [report],
});
```

Once the server accepts the write, every other connected client gets the new row
automatically — no polling or manual refresh on your side. React clients that use
`useAblo((ablo) => ablo.weatherReports.local.get(id))` receive the new row, and selectors
such as `useAblo((ablo) => ablo.weatherReports.claim.state({ id }))`
receive active claim state. There is
no extra multiplayer setup beyond routing shared state through Ablo.

Writes flow through Ablo's commit chokepoint and land in your database, so every
actor routing through Ablo is coordinated. The one write it can't coordinate is
one made directly against your database, around Ablo — the WAL echo still catches
it for reads, but it bypasses claims and ordering.

## Guarded Writes

```ts
const report = await ablo.weatherReports.read({ id: 'report_stockholm' });
if (!report) throw new Error('report not found');

await ablo.weatherReports.update({
  id: report.id,
  data: { status: 'ready' },
  reads: [report],
  idempotencyKey: 'report_stockholm:mark-ready:v1',
});
```

| Option | Purpose |
|---|---|
| `reads` | Exact rows returned by `read` that this mutation depends on. |
| `idempotencyKey` | Stable key for retry-safe writes. The SDK generates one when omitted. |

A stale premise always rejects with `AbloStaleContextError`. Omit `reads` only
when the assignment is intentionally unconditional.

## Claimed Behavior

If your update involves a slow step — an API call, an LLM round-trip — and someone
else might write the same record meanwhile, claiming the record stops you from
overwriting their change. Check who holds the record with `claim.state({ id })`, then
take it with `claim({ id })`:

```ts
const active = ablo.weatherReports.claim.state({ id: 'report_stockholm' });

if (active) {
  return { status: 'claimed', active };
}

const handle = await ablo.weatherReports.claim({ id: 'report_stockholm' });
await ablo.weatherReports.update({
  id: handle.data.id,
  data: { status: 'ready' },
  claim: handle,
});
await handle.release();
```

`claim.state({ id })` returns the current holder (or nothing) without ever blocking.
When you call `claim({ id })`, the SDK queues other claimers behind you, re-reads
the latest row, then hands you the fresh row — so you can't overwrite a change you didn't
see. Options on the claim:

- default `claim` waits in the fair queue and re-reads before handing you the row;
- `{ queue: false }` resolves `null` when another participant already holds the
  target; two clients with the same participant identity are re-entrant, not
  contenders;
- `{ maxQueueDepth }` rejects if the wait line is already too deep.

While waiting, schema clients learn when the claim clears from the live claim
stream, so they never poll.

## Errors

All SDK errors extend `AbloError`. `type` is the class-name discriminator, such
as `AbloStaleContextError`; `code` is the wire condition, such as
`stale_context`. Use `instanceof` in-process and `type` after serialization.

| Error | Typical cause |
|---|---|
| `AbloAuthenticationError` | Missing, invalid, or expired credential. |
| `AbloPermissionError` | Valid credential, denied operation or scope. |
| `AbloRateLimitError` | Rate limit or quota exceeded. Check `retryAfterSeconds`. |
| `AbloIdempotencyError` | Same idempotency key reused with a different request. |
| `AbloConnectionError` | Network, timeout, abort, or transport failure. |
| `AbloValidationError` | Invalid input or unsupported request shape. |
| `AbloServerError` | Server-side 5xx. Retry with backoff if the operation is idempotent. |
| `AbloStaleContextError` | Write was based on stale `readAt` state. Re-read and retry. |
| `AbloClaimedError` | A write conflicted with another participant's active claim, the queue was too deep, or a claim wait timed out. |

```ts
import { AbloClaimedError } from '@abloatai/ablo';

try {
  await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' } });
} catch (error) {
  if (error instanceof AbloClaimedError) {
    return { status: 'claimed' };
  }
  throw error;
}
```

## Retries and Idempotency

Model writes are retry-safe by default because the SDK attaches an idempotency
key. If you provide your own key, keep it stable for retries of the same logical
operation and never reuse it for a different payload.

Retry transport failures and 5xx with backoff. Do not blindly retry validation,
permission, idempotency, or stale-context errors without changing the request.

## Logging

Pass a logger when you need SDK logs in your own observability pipeline:

```ts
const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  logger,
});
```

The logger receives lifecycle, sync, retry, and rollback events. Avoid logging
request bodies that may contain customer data.

## Public Imports

Only these imports are public SemVer surface:

- `@abloatai/ablo`
- `@abloatai/ablo/schema`
- `@abloatai/ablo/react`

`dataSource(...)` is exported from the root package for customer-owned storage
adapters. Everything outside the three import paths is internal to Ablo-owned
apps and infrastructure. For adapter authors, `@abloatai/ablo/source/conformance`
is the suite that proves a storage adapter behaves correctly.
