# Connect Your Database

The default integration keeps your rows in **your own database**. You define an
Ablo schema for the models humans and agents edit together, expose one Data Source
endpoint, and Ablo coordinates each write and calls your app to commit it to your
Postgres. Ablo never stores the data and never sees your `DATABASE_URL` — it only
calls the endpoint you expose.

Either way, you define an Ablo schema with `defineSchema`, `model`, and Zod. The
Ablo schema describes **only your synced, collaborative models** — the rows Ablo
coordinates and fans out in realtime. It is *not* your whole-database schema and
does *not* replace your `schema.prisma` (or your Drizzle schema). Your auth,
billing, and any other non-synced tables stay in your own ORM schema, owned by
your own migrations. One database, two schemas, side by side: Ablo owns the
synced models (plus the small `ablo_outbox` / `ablo_idempotency` bookkeeping
tables its adapter needs); you keep owning everything else. `ablo check` reflects
this — it reports your other tables as "ignored / owned by you," which is exactly
right.

Your app can keep using its own `DATABASE_URL`. Store that value in your app or
backend environment, not in Ablo. The integration boundary is the HTTPS
endpoint your app exposes. The happy path uses the same server-side
`ABLO_API_KEY` to verify Ablo calls.

Use the SDK with an API key:

```ts
import Ablo from '@abloatai/ablo';
import { schema } from './ablo/schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

Do not pass a database URL to `Ablo(...)`.

For the first production integration, prefer this shape:

```bash
# Stored only in your app/backend
DATABASE_URL=postgres://...

# The only Ablo credential in the customer app
ABLO_API_KEY=sk_live_...
```

## Backing Modes

| Mode | Where rows live | What `create/update/delete` does | Use when |
|---|---|---|---|
| Data Source | Your own database | Sends a signed commit request to your route; your app writes its DB in one transaction and returns canonical rows. | Always — you own the data: your app tables, regulated data, anything that lives in your Postgres. |

The SDK call:

```ts
await ablo.weatherReports.create({ data: { location: 'Stockholm', status: 'pending' } });
await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' } });
const report = ablo.weatherReports.get('report_stockholm');
```

Multiplayer behavior is built in. Writes made through
`ablo.<model>.create/update/delete` are coordinated by Ablo, then confirmed rows
fan out to subscribers. If something writes to your database without going
through Ablo (a cron job, an admin tool), Ablo can't know about it
automatically. To keep everyone's screen up to date, your app reports those
outside changes back through the outbox feed — shown below in
[Outbox Events](#outbox-events).

## Your Database Stays Canonical

Your application database remains the source of truth and Ablo coordinates writes
against it.

If you are migrating an app where every button already calls a backend endpoint,
read [Integration Guide](./integration-guide.md) first, then
[Existing Python Backend](./examples/existing-python-backend.md) for a concrete
service-owned database example.

## What Ablo Gives You

When you add a Data Source in Ablo, you get:

| Field | Purpose |
|---|---|
| Data Source endpoint | The public HTTPS endpoint in your app that Ablo calls. |
| API key | Stored in your app as `ABLO_API_KEY`; used by the SDK and the Data Source endpoint. |
| External-write feed | Optional `events` handler on the same Data Source endpoint. |
| Status | Last successful request, last error, and delivery attempts. |

The shape is the same as a production webhook integration:

1. Expose one Data Source endpoint in your app.
2. Store `ABLO_API_KEY` in your app.
3. Verify signed HTTP calls before opening a database transaction.
4. Keep your database credentials in your app.
5. Write an outbox row in the same transaction as every app-row change.

## Route

You don't hand-write the commit transaction, the idempotency upsert, or the
outbox writes. You pass an ORM **adapter** and it does all of that for you —
transaction, exactly-once idempotency, and outbox — driven by the same Ablo
schema. The whole route is three fields:

```ts
// app/api/ablo/source/route.ts
import { dataSourceNext } from '@abloatai/ablo/source/next';
import { prismaDataSource } from '@abloatai/ablo/source';
import { schema } from '@/ablo/schema';
import { prisma } from '@/lib/prisma';

// Data Source routes touch the database, so they run on the Node runtime.
export const runtime = 'nodejs';

export const { POST } = dataSourceNext({
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  adapter: prismaDataSource(prisma, schema),
});
```

Using Drizzle instead of Prisma is the same shape — swap the adapter for
`drizzleDataSource(db, schema)`:

```ts
// app/api/ablo/source/route.ts
import { dataSourceNext } from '@abloatai/ablo/source/next';
import { drizzleDataSource } from '@abloatai/ablo/source/drizzle';
import { schema } from '@/ablo/schema';
import { db } from '@/db';

export const runtime = 'nodejs';

export const { POST } = dataSourceNext({
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  adapter: drizzleDataSource(db, schema),
});
```

The adapter is constructed from your ORM client and the Ablo `schema` —
`prismaDataSource(prisma, schema)` or `drizzleDataSource(db, schema)`. It maps
each synced model to your table, wraps every commit in one transaction, dedupes
on `clientTxId` via `ablo_idempotency`, and appends `ablo_outbox` rows for the
external-write feed — the bookkeeping you used to write by hand.

Your app code still writes through the normal model API:

```ts
await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  wait: 'confirmed',
  readAt: snap.stamp,
  onStale: 'reject',
});
```

## Commit Request

When Ablo calls your Data Source, it sends a signed JSON request:

```ts
{
  type: 'commit',
  clientTxId: 'tx_...',
  operations: [
    {
      type: 'UPDATE',
      model: 'weatherReports',
      id: 'report_stockholm',
      input: { status: 'ready' },
      readAt: 1042,
      onStale: 'reject',
    },
  ],
  scope: {
    participantId: 'agent:triage',
    participantKind: 'agent',
    organizationId: 'org_123',
    requiredSyncGroups: ['org:org_123'],
    mode: 'live',
  },
}
```

Return canonical rows:

```ts
{
  rows: [
    { id: 'report_stockholm', location: 'Stockholm', status: 'ready' },
  ],
}
```

Use explicit `deltas` only when your source already computes canonical change
events.

## Outbox Events

The adapter serves the outbox feed for you. Every `commit` it runs appends one
`ablo_outbox` row per operation in the same transaction, and the adapter's
built-in events handler streams those rows back to Ablo by cursor — so connected
humans and agents stay current with no extra code. If Ablo already appended the
commit directly, `clientTxId` lets Ablo filter the echo; if the direct append
failed, the same outbox row repairs it on the next poll or push.

Events without `clientTxId` are treated as external writes. The only thing you
add by hand is recording *outside* writes — changes made to your tables by a
cron job or admin tool that never went through Ablo. Append an `ablo_outbox` row
(with no `clientTxId`) for those in the same transaction as the change, and the
adapter's feed carries them to every connected screen.

## Production Checklist

Before using a customer-owned database in production:

- Keep `DATABASE_URL` in the customer app or backend environment.
- Use only the Data Source endpoint and `ABLO_API_KEY` as the customer-facing integration boundary.
- Run the adapter migrations so `ablo_outbox` and `ablo_idempotency` exist
  alongside your synced tables (`ablo migrate`).
- Set `export const runtime = 'nodejs'` on the route so it can reach the database.
- For writes that bypass Ablo (cron, admin tools), append an `ablo_outbox` row
  (no `clientTxId`) in the same transaction as the change.
- Monitor last success, last error, retry count, event lag, and cursor.

The adapter already handles the rest — signature verification, the commit
transaction, `clientTxId` idempotency, returning canonical rows, the outbox
append per operation, and deduping the feed by event `id`. You don't write any of
that by hand.

Don't give Ablo your database URL for this integration — Ablo never connects to
your database directly. (Direct database access would be a separate product with
its own security model.)

## Security

- Verify requests with `ABLO_API_KEY`.
- Keep database credentials in your app.
- Dedupe commits by `clientTxId`.
- Dedupe external events by event `id`.
- Use HTTPS in production.

The API key is not a database credential. It only lets your route verify that
the request came from Ablo and was not modified in transit.
