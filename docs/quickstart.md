# Quickstart

Build with Ablo on **the Postgres you already have**. You declare a small Ablo
schema for the models humans and agents edit together, connect Ablo to your
database with **logical replication** (`ablo connect`), and coordinate every read
and claim through `ablo.<model>`. Your database stays the system of record: your
app keeps writing through its own backend, Ablo tails your write-ahead log (WAL),
and the confirmed rows fan out to every connected client. Ablo **never runs DDL,
owns, or migrates your schema**.

> No database yet? The hosted **sandbox** can host rows in Ablo's test plane —
> pass an `apiKey` only and skip the database setup, like Stripe test mode — so
> you can try Ablo before connecting your Postgres.

## 1. Install and initialize

```bash
npm install @abloatai/ablo
npx ablo init
```

`ablo init` scaffolds your project (next step shows what it creates) and ends
by signing you in — one browser click, and a `sk_test_` key is saved locally
for the CLI. Later, `npx ablo push` (step 4) writes `ABLO_API_KEY` into your
`.env.local` so the SDK finds it too — no manual copy-paste. `npx ablo login`
also exists standalone. In CI, or to manage the key by hand, set it yourself
instead:

```bash
export ABLO_API_KEY=sk_test_...
```

Every SDK and CLI call needs a key. Test and live keys work like Stripe's:
`sk_test_*` for the sandbox, `sk_live_*` for production. In production a key
points at the database *you* own; in the sandbox you can skip the database
entirely and let Ablo's test plane host the rows (apiKey only). There is no
keyless mode — a key is always required. (The public `/sandbox` page is a
separate hosted demo, not your app.)

## 2. Your Ablo schema (init scaffolded it)

The schema is the contract — it generates `ablo.<model>` methods for app code,
server actions, agents, and React reads. Declare **only the synced models** Ablo
coordinates; your auth, billing, and other tables stay in your own Drizzle schema,
owned by your own migrations.

```ts
// ablo/schema.ts
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
    forecast: z.string().optional(),
  }),
});
```

**Reserved fields** — `id`, `createdAt`, `updatedAt`, `organizationId`, and
`createdBy` are provided by the SDK automatically. Don't declare them in your
`model(...)` fields; declare only your own.

The schema is registered once (init scaffolds `ablo/register.ts` for you), and
every type is one parameter away — no `typeof schema` re-stating, anywhere:

```ts
// ablo/register.ts — scaffolded by `npx ablo init`, sits beside ablo/schema.ts
import type { schema } from './schema';
declare module '@abloatai/ablo' {
  interface Register { Schema: typeof schema }
}
export {};
```

It's a regular `.ts` module, not a hand-authored `.d.ts`. The top-level
`import type { schema }` makes the `declare module` block *merge* into (augment)
the SDK's `Register` interface instead of colliding with it — the same shape
[TanStack Router uses in `src/router.tsx`](https://tanstack.com/router/latest/docs/framework/react/guide/type-safety). Any `.ts` file in your
`tsconfig` `include` works; it never needs to be imported.

```ts
import type { Model } from '@abloatai/ablo/schema';

type WeatherReport = Model<'weatherReports'>; // fully typed from YOUR schema
```

(The same `Register` binding types every hook and client — it's the
TanStack-Router pattern: declare the source of truth once, everything
infers from it.)

When you need to name the client type — to pass it to a function or store it in
a context — **infer it from the value**: `type Sync = typeof sync`. That's the
same idiom as tRPC's `typeof appRouter` and Drizzle's `typeof db`; it resolves
the typed overload at the call site. Avoid `ReturnType<typeof Ablo>`, which
collapses to the untyped client.

## 3. Connect your database with `ablo connect`

Connecting a real database = Postgres logical replication, and `ablo connect` is
the one way to set it up. Ablo **reads** your WAL and never runs DDL, owns, or
migrates your schema — your app keeps writing through its own backend.

```bash
# 1. Enable logical decoding (then RESTART Postgres — wal_level is not reloadable)
#    ALTER SYSTEM SET wal_level = 'logical';
#    On RDS/Aurora: set rds.logical_replication = 1 in the parameter group, reboot.

# 2. Print the exact publication + replication-role SQL for YOUR Postgres, run it:
npx ablo connect

# 3. Put the replication role's connection string in DATABASE_URL, then validate:
npx ablo connect --check
```

`ablo connect` prints the copy-pasteable SQL (a publication named
`ablo_publication` and a least-privilege `ablo_replicator` role with
`REPLICATION` + `SELECT`, password you choose). `ablo connect --check` connects to
`DATABASE_URL` and verifies `wal_level=logical`, the publication, the role's
`REPLICATION` attribute, and that every published table has a usable
`REPLICA IDENTITY` — a green checklist or the precise fix per item.

```bash
# .env — server runtime only, never the browser
DATABASE_URL=postgres://ablo_replicator:<password>@host:5432/db?sslmode=require
ABLO_API_KEY=sk_test_...
```

```ts
// ablo/client.ts
import Ablo from '@abloatai/ablo';
import { schema } from './schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

The full setup, the honest footprint (publication + slot + `REPLICATION` role +
the `wal_level` restart + slot/WAL retention Ablo monitors), and the Preview
status of the WAL runtime are in [Connect Your Database](./data-sources.md).

## 4. Push the schema, then map it to tables

```bash
npx ablo push      # pushes the schema definition and writes ABLO_API_KEY to
                   # .env.local. Add --watch to re-push on every save.
```

`ablo push` uploads the schema *definition* — model names, fields, types. That
metadata is what tells Ablo which models to coordinate. Skipping it makes every
write to a new or changed model fail with `server_execute_unknown_model` — that
error literally means "run `npx ablo push`."

Now map those models to your real Postgres tables. **Your migration tool owns the
tables** — Ablo reads them, it does not create or migrate them:

- Run `npx ablo pull` to import the shape of your existing tables (created by
  Prisma, Drizzle, or hand-written migrations) into your schema, or
  `npx ablo check` to verify your schema and the live tables agree. Keep managing
  the tables with your own migration tool; Ablo syncs the subset of models you
  declared and reports the rest as "ignored / owned by you."

> **Optional escape hatch:** if you have no tables yet and want Ablo to scaffold
> them, `npx ablo migrate` can create your synced-model tables for you. This is
> not the happy path — connecting a real database is `ablo connect` (step 3), and
> your own migrations stay in charge of your schema.

Nothing runs locally — there is no dev server to start. Your app talks to Ablo's
hosted API; the rows live in your database.

## 5. Write through the model

The rows land in your Postgres; every connected client sees them live.

```ts
import { ablo } from './ablo/client';

await ablo.ready();

const created = await ablo.weatherReports.create({
  data: { location: 'Stockholm', status: 'pending' },
});

const updated = await ablo.weatherReports.update({
  id: created.id,
  data: { status: 'ready', forecast: 'Light rain, 13C' },
});

console.log({ id: updated.id, status: updated.status }); // { id: '...', status: 'ready' }
```

## Add coordination for slow work

When AI or background work will touch an existing row for more than a quick
write, coordinate through `claim({ id })`. It claims the row and hands a handle
back; `claim.state({ id })` reads who is currently working on it without blocking;
and you write the usual way with `ablo.<model>.update({ id, data })`.

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize instead
of clobbering. Normal reads still work while the claim is held. If a server read
should not return a row while someone else is mid-edit, pass `ifClaimed: 'fail'`
to error out instead. Reads never block on a claim — to wait for a row to free
up, `claim({ id })` it (the claim queues fairly behind the holder).
Call `handle.release()` when your work is done.

```ts
// Claim the row so other participants serialize behind us while we work.
const handle = await ablo.weatherReports.claim({
  id: 'weather_stockholm',
  reason: 'checking_weather',
  ttl: '2m',
});

// Your existing weather tool or agent call. While this runs, other clients
// see that weather_stockholm is being checked.
const weather = await weatherAgent.getWeather(handle.data.location);

await ablo.weatherReports.update({
  id: handle.data.id,
  data: {
    status: 'ready',
    forecast: weather.summary,
  },
});

await handle.release();
```

Ablo does not fetch the weather. If another participant already holds the row,
`claim` waits for them to finish, re-reads, and then hands you the fresh row.
While you hold the claim, `update({ id, data })` rejects with `AbloStaleContextError`
if someone else changed the row first — so you never overwrite work you didn't
see. Call `handle.release()` once your work is done.

## Multiplayer and claimed work

There is no separate multiplayer mode. Use the same schema client for human UI,
server actions, and agents; Ablo fans out confirmed writes and keeps active
claims visible on the same model row.

`claim.state({ id })` tells you when another human or agent is active on the same row.
For schema clients, `claim({ id })` waits fairly, re-reads, and then lets you
write through the model.

```ts
const active = ablo.weatherReports.claim.state({ id: 'weather_stockholm' });
if (active) {
  console.log(`${active.heldBy} is ${active.reason}`);
}

const handle = await ablo.weatherReports.claim({ id: 'weather_stockholm' });
await ablo.weatherReports.update({ id: handle.data.id, data: { status: 'ready' } });
await handle.release();
```

Use `{ queue: false }` on `claim` when work should be skipped instead of queued
behind an active holder.

## Next steps

Keep using the schema client for app and agent writes.

- [Integration Guide](./integration-guide.md) explains the full app, React, Data Source, multiplayer, and agent path.
- [Schema Contract](./schema-contract.md) explains what the schema drives across SDK, React, agents, Data Source, and schema push.
- [Guarantees](./guarantees.md) explains what confirmed writes and stale checks mean.
- [Client Behavior](./client-behavior.md) covers errors, retries, and public imports.
- [Connect Your Database](./data-sources.md) covers the logical-replication connect path end to end — `ablo connect`, the honest footprint, and the WAL runtime's Preview status.
- [AI SDK Tool](./examples/ai-sdk-tool.md) shows the same write path inside a tool call.
