# Connect Your Database

By default, Ablo stores the rows for the models you define, so you don't need a
database to get started. But if you already have your own application database
and want it to stay the source of truth, you can attach it as a Data Source —
then Ablo coordinates each write and calls your app to commit it, instead of
storing the data itself.

That default makes Ablo the managed state store for your models, the same way
Stripe stores `Customer` and `PaymentIntent` objects that you create through
Stripe's API.

Either way, you define an Ablo schema with `defineSchema`, `model`, and Zod —
the same way a Prisma project starts with a `schema.prisma`. Your schema
describes your data once, and everything else (the SDK, agents, and your
database connection) relies on that one definition.

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
| Ablo-managed | Ablo | Writes directly to Ablo's managed state store, then returns the confirmed row and fans out realtime deltas. | New collaborative/agent state that can live in Ablo. |
| Data Source | Your app database | Sends a signed commit request to your route; your app writes its DB and returns canonical rows. | Existing app tables, regulated data, or teams that need their DB to stay canonical. |

The SDK call is the same in both modes:

```ts
await ablo.weatherReports.create({ data: { location: 'Stockholm', status: 'pending' } });
await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' } });
const report = ablo.weatherReports.get('report_stockholm');
```

Only the backing store changes.

Multiplayer behavior is the same in both modes. Writes made through
`ablo.<model>.create/update/delete` are coordinated by Ablo, then confirmed rows
fan out to subscribers. If something writes to your database without going
through Ablo (a cron job, an admin tool), Ablo can't know about it
automatically. To keep everyone's screen up to date, your app reports those
outside changes back through an events feed — shown below in
[External Writes](#external-writes).

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
5. Write an outbox row in the same transaction as every app-row change.

## Route

```ts
// app/api/ablo/source/route.ts
import { dataSource, sourceEventForOperation } from '@abloatai/ablo';
import { schema } from '@/ablo/schema';
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
      const changes = await applyOperations(tx, operations);
      await tx.outbox.createMany({
        data: changes.map(({ eventId, operation, entityId, data }) =>
          sourceEventForOperation({
            eventId,
            operation,
            entityId,
            data,
            ...(clientTxId ? { clientTxId } : {}),
            ...(context.scope?.organizationId
              ? { organizationId: context.scope.organizationId }
              : {}),
            occurredAt: Date.now(),
          }),
        ),
      });
      return changes.map(({ row }) => row);
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

Return your outbox feed from an `events` handler so connected humans and agents
stay current. Include SDK-origin events too. If Ablo already appended the commit
directly, `clientTxId` lets Ablo filter the echo; if the direct append failed,
the same outbox row repairs it on the next poll or push.

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

Events without `clientTxId` are treated as external writes.

## Production Checklist

Before using a customer-owned database in production:

- Keep `DATABASE_URL` in the customer app or backend environment.
- Use only the Data Source endpoint and `ABLO_API_KEY` as the customer-facing integration boundary.
- Verify signatures before opening a database transaction.
- Store `clientTxId` in an idempotency table before applying writes.
- Return canonical rows after each commit.
- Write outbox events in the same transaction as every app-row write, including
  Data Source `commit` writes.
- Dedupe outbox events by event `id`.
- Monitor last success, last error, retry count, event lag, and cursor.

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
