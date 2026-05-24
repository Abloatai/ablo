# Connect Your Database

Every schema model has a backing store.

By default, Ablo stores the rows for the models you declare. That makes Ablo the
managed state store for those resources, the same way Stripe stores `Customer`
and `PaymentIntent` objects that you create through Stripe's API.

If you already have application tables and want those tables to remain
canonical, attach a Data Source. Then Ablo coordinates the write and calls your
app to commit it.

Use the SDK with an API key:

```ts
import Ablo from '@ablo/sync-engine';
import { schema } from './ablo.schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

Do not pass a database URL to `Ablo(...)`.

## Backing Modes

| Mode | Where rows live | What `create/update/delete` does | Use when |
|---|---|---|---|
| Ablo-managed | Ablo | Writes directly to Ablo's managed state store, then returns the confirmed row and fans out realtime deltas. | New collaborative/agent state that can live in Ablo. |
| Data Source | Your app database | Sends a signed commit request to your route; your app writes its DB and returns canonical rows. | Existing app tables, regulated data, or teams that need their DB to stay canonical. |

The SDK call is the same in both modes:

```ts
await ablo.tasks.create({ title: 'Draft launch plan', status: 'todo' });
await ablo.tasks.update('task_123', { status: 'done' });
const task = ablo.tasks.retrieve('task_123');
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
| Data Source URL | The public HTTPS route in your app that Ablo will call. |
| Signing secret | Stored in your app as `ABLO_DATA_SOURCE_SIGNING_SECRET`; used to verify Ablo calls. |
| Push events URL | Ablo endpoint your app can call when rows change outside Ablo. |
| Status | Last successful request, last error, and delivery attempts. |

The shape is the same as a production webhook integration:

1. Add a Data Source URL in Ablo.
2. Store the signing secret in your app.
3. Expose one signed HTTP route from your app.
4. Keep your database credentials in your app.

```bash
ABLO_DATA_SOURCE_SIGNING_SECRET=whsec_...
```

## Route

```ts
// app/api/ablo/source/route.ts
import { dataSource } from '@ablo/sync-engine';
import { schema } from '@/ablo.schema';
import { db } from '@/db';

export const POST = dataSource({
  schema,
  signingSecret: process.env.ABLO_DATA_SOURCE_SIGNING_SECRET,

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

  tasks: {
    async load({ id, context }) {
      return context.auth.db.task.findUnique({ where: { id } });
    },

    async list({ query, context }) {
      return context.auth.db.task.findMany({
        take: query.limit ?? 100,
      });
    },
  },
});
```

Your app code still writes through the normal model API:

```ts
await ablo.tasks.update(
  'task_123',
  { status: 'done' },
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
      model: 'tasks',
      id: 'task_123',
      input: { status: 'done' },
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
    { id: 'task_123', title: 'Fix docs', status: 'done' },
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
  signingSecret: process.env.ABLO_DATA_SOURCE_SIGNING_SECRET,

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

## Security

- Verify requests with `ABLO_DATA_SOURCE_SIGNING_SECRET`.
- Keep database credentials in your app.
- Dedupe commits by `clientTxId`.
- Dedupe external events by event `id`.
- Use HTTPS in production.

The signing secret is not a database credential and does not give Ablo access to
your database. It only lets your route verify that the request came from Ablo
and was not modified in transit.
