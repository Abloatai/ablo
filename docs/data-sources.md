# Connect Your Database

**In production, your database is the system of record.** Every synced model is
backed by your own Postgres; Ablo is the transaction layer on top of it. There
are two ways to connect, and they are the same product with the same writes — the
only difference is where your database credential lives:

| | How Ablo reaches your Postgres | Use when |
|---|---|---|
| **Connection string** (primary) | You pass `databaseUrl` to `Ablo(...)` explicitly (it is never auto-read from the environment); Ablo registers the connection and commits each write directly, behind row-level security. | You can hand over a scoped connection string. |
| **Signed endpoint** | Your app exposes one route built from an ORM adapter; Ablo sends signed commit requests and your app writes its own database. | Database credentials must never leave your infrastructure. |

> Just trying Ablo? You don't need a database at all to start: the hosted
> **sandbox** can host rows in Ablo's test plane — pass an `apiKey` only and omit
> `databaseUrl`, like Stripe test mode. Connect your Postgres (either shape
> below) when you're ready for it to be the system of record.

Either way, you define an Ablo schema with `defineSchema`, `model`, and Zod. The
Ablo schema describes **only your synced, collaborative models** — the rows Ablo
coordinates and fans out in realtime. It is *not* your whole-database schema and
does *not* replace your `schema.prisma` (or your Drizzle schema). Your auth,
billing, and any other non-synced tables stay in your own ORM schema, owned by
your own migrations. One database, two schemas, side by side: Ablo owns the
synced models; you keep owning everything else. `ablo check` reflects this — it
reports your other tables as "ignored / owned by you," which is exactly right.

What Ablo stores, in both shapes: your schema *definition* (model names, fields,
types — pushed with `ablo push`), your hashed API keys, a safe projection of the
connection registration (host, database, schema — the connection string itself
is sealed and never echoed back), and the commit log that drives sync. Never
your rows.

## Connection String (default)

The canonical client carries all three values:

```ts
import Ablo from '@abloatai/ablo';
import { schema } from './ablo/schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  databaseUrl: process.env.DATABASE_URL, // your Postgres, passed explicitly — rows live here
});
```

```bash
# .env — server runtime only, never the browser
DATABASE_URL=postgres://ablo_app:...@host:5432/db
ABLO_API_KEY=sk_live_...
```

On first connect the SDK registers the connection — sent once over TLS, stored
sealed, never returned by any API. From then on Ablo commits every confirmed
write directly to your database and reads canonical rows from it.

### A localhost Postgres can't be the system of record

This is the connection-string fact people hit first. Ablo's **cloud** registers
your connection string and connects to your Postgres **over the network**. A
`localhost` / private-range database (`127.0.0.1`, `192.168.*`, Docker's
`db:5432`) is unreachable from Ablo's side, so such connection strings are
**rejected**. Two escape hatches for local development against your own DB:

- **Expose a signed Data Source endpoint.** Your app — which *can* reach your
  local DB — proxies Ablo's commits to it. See [Signed Endpoint](#signed-endpoint)
  below. This is the right answer for "my dev DB stays on my machine."
- **Use the hosted sandbox.** Skip the database entirely: pass an `apiKey` only,
  omit `databaseUrl`, and let Ablo's test plane host the rows while you build.

Safety requirements, enforced server-side before the first write:

- **Non-superuser role.** The connection must not be a superuser or hold
  `BYPASSRLS` — Ablo's tenant isolation is row-level security, and a role that
  can bypass it is rejected outright.
- **Row-level security on synced tables.** `npx ablo migrate` provisions your
  synced-model tables with `FORCE ROW LEVEL SECURITY` already applied; tables
  you create yourself must do the same.
- **Network-reachable host.** As above, connection strings resolving to loopback
  or private address ranges are rejected — Ablo connects from its cloud.

`databaseUrl` is server-only: the SDK throws if it sees one in a browser-like
environment, and `dangerouslyAllowBrowser` does not override that. It is also
never auto-read from the environment — pass it explicitly to `Ablo(...)`.

## Signed Endpoint

When a connection string must not leave your infrastructure, keep
`DATABASE_URL` in your app and expose one HTTPS endpoint instead. Ablo signs a
commit request; an ORM adapter in your route runs it in one transaction against
your Postgres and returns the canonical rows. Omit `databaseUrl` from
`Ablo(...)` in this setup — the client takes only the schema and the API key:

```ts
export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

The SDK call is identical in both shapes:

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

## Production Checklist (signed endpoint)

Before using the signed-endpoint shape in production:

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

In this shape, leave `databaseUrl` out of `Ablo(...)` — the endpoint *is* the
connection, and registering both would point Ablo at your database twice.

## Security

- Verify requests with `ABLO_API_KEY`.
- Keep database credentials in your app.
- Dedupe commits by `clientTxId`.
- Dedupe external events by event `id`.
- Use HTTPS in production.

The API key is not a database credential. It only lets your route verify that
the request came from Ablo and was not modified in transit.
