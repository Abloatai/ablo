# Client Behavior

When several writers touch the same data at once — a person in the browser, a Server Action, an agent worker — the SDK decides whose write lands and how the others find out. This page is the reference for that: per-write options like `wait` and `onStale`, claiming a record so your slow work runs uninterrupted, and which errors are safe to retry.

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

Common options:

| Option | Purpose |
|---|---|
| `schema` | Required for typed model clients. |
| `apiKey` | Bearer credential for trusted server runtimes. Defaults to `ABLO_API_KEY` when available. |
| `databaseUrl` | Optional, server-only. Registers your Postgres directly (the connection-string path). Pass it explicitly — it is **not** auto-read from the environment. Omit it for a signed Data Source endpoint or the hosted sandbox. The SDK throws if it sees this in a browser. |
| `baseURL` | Override the hosted sync endpoint for staging or private deployments. |
| `persistence` | `memory` by default. Use `indexeddb` for a durable browser cache that survives reloads. |
| `transport` | `'websocket'` (default) is the live, stateful client — a persistent socket, a local synced pool, and `onChange` subscriptions. `'http'` returns the **stateless** client for server-side actors (agents, workers, serverless): the same `ablo.<model>` read/write/claim surface, but each call is one HTTP round-trip with no socket. Under `'http'` the return type narrows to `AbloHttpClient`, so stateful-only methods (`get`/`getAll`, `onChange`, `watch`) are compile errors rather than runtime gaps. |
| `fetch` | Custom fetch implementation for tests or non-standard runtimes. |
| `defaultHeaders` | Extra headers attached to every HTTP request. |
| `defaultQuery` | Extra query parameters attached to every HTTP request. |
| `dangerouslyAllowBrowser` | Required before sending an API key from browser code. Prefer a server route instead. |

`databaseUrl` is an optional, server-only constructor option. It is **not**
auto-read from the environment — pass it explicitly to register your Postgres
directly (the connection-string path). Omit it when you expose a signed
[Data Source](./data-sources.md) endpoint, or when trying Ablo against the hosted
sandbox.

## Model Methods

Each schema model becomes a typed model:

```ts
await ablo.ready();

const report = await ablo.weatherReports.retrieve({ id: 'report_stockholm' });
const local = ablo.weatherReports.get('report_stockholm');

await ablo.weatherReports.create({ data: { location: 'Stockholm', status: 'pending' } });
await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' }, wait: 'confirmed' });
await ablo.weatherReports.delete({ id: 'report_stockholm', wait: 'confirmed' });
```

Call `retrieve`/`list` first — they fetch from the server and you `await` them.
After that, `get`/`getAll`/`getCount` read the already-synced data instantly with
no `await`, and stay reactive in render. Use the async pair to load, the sync trio
to read.

`getAll` accepts the same practical read options the React selector path uses:
`where`, `filter`, `orderBy`, `limit`, `offset`, and `state`. The `state`
lifecycle filter defaults to `'live'`; pass `'archived'` or `'all'` when you
intentionally want non-live rows.

## Multiplayer Behavior

Two writers both try to mark `report_stockholm` ready at the same time. To stop
the second write from silently overwriting the first, every participant goes
through the same model client path. A human Server Action, a browser view, and an
agent worker can all use `ablo.weatherReports`:

```ts
const report = await ablo.weatherReports.retrieve({ id });
const snap = ablo.snapshot({ weatherReports: id });

await ablo.weatherReports.update({
  id,
  data: patch,
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

Once the server accepts the write, every other connected client gets the new row
automatically — no polling or manual refresh on your side. React clients that use
`useAblo((ablo) => ablo.weatherReports.get(id))` receive the new row, and selectors
such as `useAblo((ablo) => ablo.weatherReports.claim.state({ id }))`
receive active claim state. There is
no extra multiplayer setup beyond routing shared state through Ablo.

If an app writes directly to its database, Ablo cannot coordinate that write
until the app reports it through Data Source events.

## Per-Write Options

```ts
await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  wait: 'confirmed',
  readAt: snap.stamp,
  onStale: 'reject',
  idempotencyKey: 'report_stockholm:mark-ready:v1',
  timeout: 20_000,
});
```

| Option | Purpose |
|---|---|
| `wait` | `queued` resolves after local queueing; `confirmed` waits for server acceptance. |
| `readAt` | State cursor the write was based on. |
| `onStale` | Policy when the target changed after `readAt`. Prefer `reject`. |
| `idempotencyKey` | Stable key for retry-safe writes. The SDK generates one when omitted. |
| `timeout` | Maximum time for the write call. |

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
await ablo.weatherReports.update({ id: handle.data.id, data: { status: 'ready' } });
await handle.release();
```

`claim.state({ id })` returns the current holder (or nothing) without ever blocking.
When you call `claim({ id })`, the SDK queues other claimers behind you, re-reads
the latest row, then hands you the fresh row — so you can't overwrite a change you didn't
see. Options on the claim:

- default `claim` waits in the fair queue and re-reads before handing you the row;
- `{ wait: false }` rejects with `AbloClaimedError` instead of queuing;
- `{ maxQueueDepth }` rejects if the wait line is already too deep.

While waiting, schema clients learn when the claim clears from the live claim
stream, so they never poll.

## Errors

All SDK errors extend `AbloError` and carry a stable `type`.

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
| `AbloClaimedError` | An active claim conflicted with `{ wait: false }`, the queue was too deep, or a claim wait timed out. |

```ts
import { AbloClaimedError } from '@abloatai/ablo';

try {
  await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' }, wait: 'confirmed' });
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
- `@abloatai/ablo/testing`

`dataSource(...)` is exported from the root package for customer-owned storage
adapters. Everything outside the four import paths is internal to Ablo-owned
apps and infrastructure.
