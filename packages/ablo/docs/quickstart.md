# Quickstart

> Make your first coordinated write, on the Postgres you already have.

Build with Ablo on **the Postgres you already have**. You declare a small Ablo
schema for the models your agents edit together, connect Ablo to your
database (`ablo connect`), and read and write every one of those models through
`ablo.<model>`. You write through Ablo; it lands the change in your Postgres and
confirms it by tailing your write-ahead log (WAL). Your rows live in your database,
which stays the system of record. Ablo writes rows but **runs no DDL and owns no
schema** — your migration tool stays in charge of the shape of your database.

> No database yet? Pass an `apiKey` only and Ablo keeps your rows in its own log,
> so you can build the whole app today — like Stripe test mode. Point it at a
> separate or local Postgres for a throwaway sandbox, or at your production
> database when you're ready.

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

The same block is where you name the metadata your claims carry. Add a
`ClaimMeta` key and every `claim.state`, `claim.queue`, and held claim reads
`target.meta` as that shape:

```ts
declare module '@abloatai/ablo' {
  interface Register {
    Schema: typeof schema;
    ClaimMeta: { blocks: string[] };
  }
}

const holder = ablo.weatherReports.claim.state({ id });
holder?.target.meta?.blocks.length; // typed, no guard
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

`ablo connect` sets your database up so Ablo can write your rows (a scoped DML
role) and read them back to confirm (logical replication). It writes rows through
that role but runs no DDL and owns no schema — your migration tool stays in charge.

You run `ablo connect` once, out of band — it provisions the roles and hands them
to Ablo. From then on Ablo does the connecting; your app never opens a database
connection.

```bash
# Point it at an admin connection once — it does the whole ceremony: creates the
# roles + publication, turns on logical decoding where it can, registers both
# scoped roles with Ablo, and proves it by reading back. Nothing lands in your .env.
npx ablo connect apply --url postgres://admin:...@host:5432/db

# ...or print the SQL and run it yourself, then register:
#   npx ablo connect            # prints the publication + two scoped roles
#   npx ablo connect check    # validates the database is ready
#   npx ablo connect register # hands the two scoped roles to Ablo
```

`ablo connect apply` generates two roles and their passwords — an
`ablo_replicator` role (`REPLICATION` + `SELECT`, for reads and confirmation) and
an `ablo_writer` role (scoped row DML, for writes) — and registers both connection
strings with Ablo's control plane, encrypted. Ablo's runtime uses them to read and
write your database. The admin credential you pass to `--url` is used on this
machine only and never persisted. The role passwords are generated for you and
never printed — rotate them any time with `ablo connect rotate`.

Your **app** holds only the API key — never a connection string:

```bash
# .env — server runtime only, never the browser
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

The full setup, the honest footprint (publication + slot + the `REPLICATION` and
writer roles + the `wal_level` restart + slot/WAL retention Ablo monitors), and the
Preview status are in [Connect Your Database](./data-sources.md).

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

> **Starting from an empty database?** `npx ablo migrate` creates the tables
> your schema needs. Once they exist, your own migration tool stays in charge
> of them — Ablo adopts whatever shape you evolve.

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

Read a single row back with `get({ id })`. It resolves to the row, or to
`undefined` when no row has that id — so narrow it once, then the fields are
fully typed:

```ts
const report = await ablo.weatherReports.get({ id: created.id });
if (!report) throw new Error(`weatherReports ${created.id} not found`);

console.log(report.status); // 'ready'
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
Bind the handle with `await using` and the claim releases itself when the scope
exits — on success or on a throw, so a failing agent call never leaves the row
locked.

```ts
// Claim the row so other participants serialize behind us while we work.
await using handle = await ablo.weatherReports.claim({
  id: 'weather_stockholm',
  description: 'checking_weather',
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
// scope exit releases the claim — no manual release, even if the work threw
```

Ablo does not fetch the weather. If another participant already holds the row,
`claim` waits for them to finish, re-reads, and then hands you the fresh row.
While you hold the claim, `update({ id, data })` rejects with `AbloStaleContextError`
if someone else changed the row first — so you never overwrite work you didn't see.

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

await using handle = await ablo.weatherReports.claim({ id: 'weather_stockholm' });
await ablo.weatherReports.update({ id: handle.data.id, data: { status: 'ready' } });
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
