# Client Behavior

This page covers the SDK behavior around options, errors, retries, and runtimes.

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
| `baseURL` | Override the hosted sync endpoint for staging or private deployments. |
| `persistence` | `volatile` by default. Use `indexeddb` for browser durable cache and offline queueing. |
| `fetch` | Custom fetch implementation for tests or non-standard runtimes. |
| `defaultHeaders` | Extra headers attached to every HTTP request. |
| `defaultQuery` | Extra query parameters attached to every HTTP request. |
| `dangerouslyAllowBrowser` | Required before sending an API key from browser code. Prefer a server route instead. |

There is intentionally no `databaseURL` constructor option. Teams that keep
canonical rows in their own database use a signed [Data Source](./data-sources.md)
endpoint.

## Model Methods

Each schema model becomes a typed model:

```ts
await ablo.ready();

const [report] = await ablo.weatherReports.load({ where: { id: 'report_stockholm' } });
const local = ablo.weatherReports.retrieve('report_stockholm');

await ablo.weatherReports.create({ location: 'Stockholm', status: 'pending' });
await ablo.weatherReports.update('report_stockholm', { status: 'ready' }, { wait: 'confirmed' });
await ablo.weatherReports.delete('report_stockholm', { wait: 'confirmed' });
```

`load` is async hydration from local store and server. `retrieve`, `list`, and
`count` are synchronous local reads after data is loaded.

`list` accepts the same practical read options the React selector path uses:
`where`, `filter`, `orderBy`, `limit`, `offset`, and `scope`. Scope defaults to
`'live'`; pass `'archived'` or `'all'` when you intentionally want non-live
rows.

## Multiplayer Behavior

Multiplayer works when every participant uses the same model client path. A
human Server Action, a browser view, and an agent worker can all use
`ablo.weatherReports`:

```ts
const [report] = await ablo.weatherReports.load({ where: { id } });
const snap = ablo.snapshot({ weatherReports: id });

await ablo.weatherReports.update(id, patch, {
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

The confirmed write fans out over realtime subscriptions. React clients that use
`useAblo((ablo) => ablo.weatherReports.retrieve(id))` receive the new row, and selectors
such as `useAblo((ablo) => ablo.weatherReports.claimState(id))`
receive active claim state. There is
no extra multiplayer setup beyond routing shared state through Ablo.

If an app writes directly to its database, Ablo cannot coordinate that write
until the app reports it through Data Source events.

## Per-Write Options

```ts
await ablo.weatherReports.update(
  'report_stockholm',
  { status: 'ready' },
  {
    wait: 'confirmed',
    readAt: snap.stamp,
    onStale: 'reject',
    idempotencyKey: 'report_stockholm:mark-ready:v1',
    timeout: 20_000,
  },
);
```

| Option | Purpose |
|---|---|
| `wait` | `queued` resolves after local queueing; `confirmed` waits for server acceptance. |
| `readAt` | State cursor the write was based on. |
| `onStale` | Policy when the target changed after `readAt`. Prefer `reject`. |
| `idempotencyKey` | Stable key for retry-safe writes. The SDK generates one when omitted. |
| `timeout` | Maximum time for the write call. |

## Claimed Behavior

```ts
const active = ablo.weatherReports.claimState('report_stockholm');

if (active) {
  return { status: 'claimed', active };
}

await ablo.weatherReports.claim('report_stockholm', async (report) => {
  await ablo.weatherReports.update(report.id, { status: 'ready' });
});
```

Reads never silently block. For schema model calls, use `claimState(id)` to observe
current work and `claim(id, work)` to serialize a write across a slow step:

- default `claim` waits in the fair queue and re-reads before invoking `work`;
- `{ wait: false }` rejects with `AbloClaimedError` instead of queuing;
- `{ maxQueueDepth }` rejects if the wait line is already too deep.

Schema clients use the realtime stream for waits.

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
  await ablo.weatherReports.update('report_stockholm', { status: 'ready' }, { wait: 'confirmed' });
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
