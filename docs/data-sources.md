# Connect Your Database

Every schema model has a backing store.

Customer apps must define an Ablo schema. The schema is the contract between
the SDK, agents, realtime subscriptions, and the Data Source endpoint. Use
`defineSchema`, `model`, and Zod the same way a Prisma project starts with a
`schema.prisma`.

By default, Ablo stores the rows for the models you declare. That makes Ablo the
managed state store for those models, the same way Stripe stores `Customer`
and `PaymentIntent` objects that you create through Stripe's API.

If you already have application tables and want those tables to remain
canonical, attach a Data Source. Then Ablo coordinates the write and calls your
app to commit it.

Your app can keep using its own `DATABASE_URL`. Store that value in your app or
backend environment, not in Ablo. The integration boundary is the HTTPS
endpoint your app exposes. The happy path uses the same server-side
`ABLO_API_KEY` to verify Ablo calls.

Use the SDK with an API key:

```ts
import Ablo from '@abloatai/ablo';
import { schema } from './ablo.schema';

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
| Ablo-managed | Ablo | Writes directly to Ablo's managed state store, then returns the confirmed row and fans out realtime deltas. | New collaborative/agent state that can live in Ablo. |
| Data Source | Your app database | Sends a signed commit request to your route; your app writes its DB and returns canonical rows. | Existing app tables, regulated data, or teams that need their DB to stay canonical. |

The SDK call is the same in both modes:

```ts
await ablo.weatherReports.create({ location: 'Stockholm', status: 'pending' });
await ablo.weatherReports.update('report_stockholm', { status: 'ready' });
const report = ablo.weatherReports.retrieve('report_stockholm');
```

Only the backing store changes.

Multiplayer behavior is the same in both modes. Writes made through
`ablo.<model>.create/update/delete` are coordinated by Ablo, then confirmed rows
fan out to subscribers. Direct database writes outside Ablo need Data Source
events so connected humans and agents see the change.

## When To Use A Data Source

Use a Data Source only when your existing application database remains the
source of truth and Ablo should coordinate writes against it.

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
5. Write an outbox row when data changes outside Ablo.

## Route

```ts
// app/api/ablo/source/route.ts
import { dataSource } from '@abloatai/ablo';
import { schema } from '@/ablo.schema';
import { db } from '@/db';

export const POST = dataSource({
  schema,
  apiKey: process.env.ABLO_API_KEY,

  authorize() {
    return { db };
  },

  async commit({ operations, clientTxId, context }) {
    const rows = await context.auth.db.transaction(async (tx) => {
      await tx.idempotency.upsert({ key: clientTxId, operations });
      return applyOperations(tx, operations);
    });

    return { rows };
  },

  reports: {
    async load({ id, context }) {
      return context.auth.db.report.findUnique({ where: { id } });
    },

    async list({ query, context }) {
      return context.auth.db.report.findMany({
        take: query.limit ?? 100,
      });
    },
  },
});
```

Your app code still writes through the normal model API:

```ts
await ablo.weatherReports.update(
  'report_stockholm',
  { status: 'ready' },
  { wait: 'confirmed', readAt: snap.stamp, onStale: 'reject' },
);
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

## External Writes

If your app changes data outside Ablo, return those changes from an `events`
handler so connected humans and agents stay current:

```ts
export const POST = dataSource({
  schema,
  apiKey: process.env.ABLO_API_KEY,

  async events({ cursor, limit, context }) {
    const page = await context.auth.db.outbox.after(cursor, { limit });

    return {
      events: page.rows.map((row) => ({
        id: row.id,
        model: row.model,
        entityId: row.entityId,
        type: row.type,
        data: row.data,
        organizationId: row.organizationId,
        clientTxId: row.clientTxId,
        occurredAt: row.createdAt.getTime(),
      })),
      nextCursor: page.nextCursor,
    };
  },
});
```

`clientTxId` lets Ablo drop SDK echoes that already produced a realtime update.
Events without `clientTxId` are treated as external writes.

## Production Checklist

Before using a customer-owned database in production:

- Keep `DATABASE_URL` in the customer app or backend environment.
- Use only the Data Source endpoint and `ABLO_API_KEY` as the customer-facing integration boundary.
- Verify signatures before opening a database transaction.
- Store `clientTxId` in an idempotency table before applying writes.
- Return canonical rows after each commit.
- Write outbox events in the same transaction as non-Ablo writes.
- Dedupe outbox events by event `id`.
- Monitor last success, last error, retry count, event lag, and cursor.

Do not send the customer's database URL to Ablo for this path. Direct database
URL custody would be a separate connector product with encrypted secret storage,
rotation, least-privilege roles, connection limits, table allowlists, and clear
data-processing terms.

## Security

- Verify requests with `ABLO_API_KEY`.
- Keep database credentials in your app.
- Dedupe commits by `clientTxId`.
- Dedupe external events by event `id`.
- Use HTTPS in production.

The API key is not a database credential. It only lets your route verify that
the request came from Ablo and was not modified in transit.
