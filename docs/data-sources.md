# Connect Your Database

**Connect your database = Postgres logical replication.** That is the one way.
Ablo reads your write-ahead log (WAL) and **never runs DDL, never owns your
schema, and never migrates it**. Your application keeps writing to its own
Postgres through its own backend, exactly as it does today; Ablo only tails the
changes and fans the confirmed rows out to every connected human and agent. This
is the same model ElectricSQL, PowerSync, and Zero use — a publication plus a
replication slot, read-only.

> **Just trying Ablo?** You don't need a database at all to start. The hosted
> **sandbox** can host rows in Ablo's test plane — pass an `apiKey` only and omit
> any database setup, like Stripe test mode. Connect your Postgres with logical
> replication (below) when you're ready for it to be the system of record.

Your database stays the system of record. Ablo never becomes a second source of
truth and never takes over operating your Postgres.

## The five steps (mirrors Zero's install flow)

You run the setup once against your own database, then point Ablo at it. The CLI
prints the exact SQL and validates it for you — you never hand-craft replication
internals.

### 1. Enable logical decoding

Turn on logical WAL so Ablo can decode row changes:

```sql
ALTER SYSTEM SET wal_level = 'logical';
```

`wal_level` is **not reloadable** — you must **restart Postgres** for it to take
effect. On Amazon RDS / Aurora you can't `ALTER SYSTEM`; set
`rds.logical_replication = 1` in the instance's parameter group instead, then
reboot.

### 2. Run `ablo connect` to get the publication / slot / role SQL

```bash
npx ablo connect
```

`ablo connect` prints the exact, copy-pasteable setup SQL for **your** Postgres
and nothing else — it does not ask for a connection-string flavor, an adapter, or
a driver, because logical replication is how you connect. Run the printed SQL
against your database (as a superuser / the DB owner). It does three things:

- **A publication** naming the tables Ablo should read (`ablo_publication`, the
  single canonical name the runtime subscribes to):

  ```sql
  CREATE PUBLICATION "ablo_publication" FOR ALL TABLES;
  ```

  Scope it to a subset with `npx ablo connect --tables a,b,c`.

- **A least-privilege replication role** — it can stream replication and `SELECT`,
  nothing more. You choose the password; it never passes through Ablo's CLI or
  servers:

  ```sql
  CREATE ROLE "ablo_replicator" WITH REPLICATION LOGIN PASSWORD '<password>';
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO "ablo_replicator";
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "ablo_replicator";
  ```

  Rename it with `--role <name>`. On Amazon RDS the `REPLICATION` attribute is
  granted, not set directly: `GRANT rds_replication TO "ablo_replicator";`.

The **replication slot** is created and owned by Ablo's runtime when it first
subscribes with this role — you don't pre-create it. The publication and the role
are the only objects the recipe asks you to create.

### 3. Validate with `ablo connect --check`

Put the replication role's connection string in `DATABASE_URL`, then verify the
database is replication-ready:

```bash
npx ablo connect --check
```

This connects and checks the four invariants, printing a green checklist or the
precise per-item fix:

- `wal_level` is `logical`
- the `ablo_publication` publication exists
- the `DATABASE_URL` role has the `REPLICATION` attribute
- every published table has a usable `REPLICA IDENTITY` (a primary key, or
  `REPLICA IDENTITY FULL`) so `UPDATE`/`DELETE` can replicate

Re-run it until every item is green.

### 4. Point Ablo at the database with the replication role

Give Ablo the connection string for the **replication role** you created. This is
a read-only WAL connection — the same value `--check` validated:

```bash
# .env — server runtime only, never the browser
DATABASE_URL=postgres://ablo_replicator:<password>@host:5432/db?sslmode=require
ABLO_API_KEY=sk_live_...
```

```ts
import Ablo from '@abloatai/ablo';
import { schema } from './ablo/schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

You define an Ablo schema with `defineSchema`, `model`, and Zod. The Ablo schema
describes **only your synced, collaborative models** — the rows Ablo coordinates
and fans out in realtime. It is *not* your whole-database schema and does *not*
replace your `schema.prisma` (or your Drizzle schema). Your auth, billing, and
any other tables stay in your own ORM schema, owned by your own migrations.
`ablo check` reflects this — it reports tables you didn't declare as "ignored /
owned by you," which is exactly right.

### 5. Writes go through your own backend

Your application writes to its Postgres the way it always has — its own ORM, its
own backend, its own transactions. Ablo does not intercept or proxy those writes.
It observes them on the WAL and fans the confirmed rows out to connected clients.
The read, claim, and coordination surface (`ablo.<model>`) layers on top:

```ts
const report = ablo.weatherReports.get('report_stockholm');
const active = ablo.weatherReports.claim.state({ id: 'report_stockholm' });
```

For the typed read/claim/write surface itself, see
[Quickstart](./quickstart.md) and [Schema Contract](./schema-contract.md).

## What Ablo touches in your database — the honest footprint

This is the complete list. Nothing else.

| Object | What it is | Owned by |
|---|---|---|
| `ablo_publication` | A Postgres publication naming the tables Ablo reads. | You create it (step 2). |
| Replication slot | A logical slot Ablo subscribes through to track its WAL position. | Ablo's runtime creates it on first connect. |
| `ablo_replicator` role | A least-privilege `REPLICATION` + `SELECT` role. | You create it (step 2). |
| `wal_level = logical` | A server setting that **requires a restart**. | You set it (step 1). |

Operational reality you should know up front:

- **`wal_level = logical` needs a restart.** It is a one-time, server-wide change
  and is not reloadable.
- **A replication slot retains WAL.** While Ablo is connected, the slot holds the
  WAL it hasn't yet acknowledged. If Ablo is disconnected for a long time, that
  WAL accumulates and consumes disk. **Ablo monitors slot lag and WAL retention**
  and surfaces it so you're never surprised by disk pressure; an abandoned slot is
  dropped rather than left to grow unbounded.
- **The role is read-only.** It can stream replication and `SELECT`. It cannot
  write, and the recipe never grants it more.

What Ablo explicitly does **not** do:

- It **never runs DDL** against your database.
- It **never owns or migrates your schema** — your migration tool stays in charge.
- It **never writes your rows** — writes are yours, through your backend.

## What Ablo stores on its side

Your schema *definition* (model names, fields, types — pushed with `ablo push`),
your hashed API keys, a safe projection of the connection registration (host,
database, schema — the connection string itself is sealed and never echoed back),
the replication slot position, and the commit log that drives sync. Never your
rows.

> **Logical-replication runtime status: Preview.** The setup path above
> (`ablo connect` and `ablo connect --check`) is real and shipping. The
> server-side component that consumes your WAL and turns it into sync deltas is in
> **Preview** — it is implemented and tested but **not yet GA / boot-wired in the
> hosted runtime**. Treat WAL consumption as not-yet-deployed until this note is
> removed. Maintainers: see
> [internal/byo-wal-consumer.md](./internal/byo-wal-consumer.md) for the
> architecture and remaining slices.

## Next steps

- [Quickstart](./quickstart.md) — connect and write through `ablo.<model>`.
- [Schema Contract](./schema-contract.md) — what the schema drives across SDK,
  React, and agents.
- [Guarantees](./guarantees.md) — what confirmed writes and stale checks mean.
- [Integration Guide](./integration-guide.md) — the full app, React, multiplayer,
  and agent path.

---

## Legacy / not recommended

> **Use logical replication instead** (top of this page). The shapes below
> predate the single connect path. They are documented only so existing
> integrations can be read and understood — do **not** reach for them when
> connecting a new database. They are the seams that caused painful onboarding,
> and `ablo connect` exists precisely to replace them.

These older shapes connected Ablo to a database two other ways: by handing Ablo a
**connection string** to operate directly (`databaseUrl` on the client, committing
writes itself behind row-level security), or by exposing a **signed Data Source
endpoint** built from an ORM adapter (`prismaDataSource` / `drizzleDataSource`,
with `ablo_outbox` / `ablo_idempotency` bookkeeping and a reverse-channel
connector for VPCs). Both required Ablo to either operate your database or proxy
every write, and both have been superseded by logical replication, where Ablo only
reads your WAL. If you are maintaining one of these integrations, migrate it to
`ablo connect` at the next opportunity.
