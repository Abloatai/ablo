# Quickstart

Build with Ablo on **your own database**. You declare a small Ablo schema for the
models humans and agents edit together, hand the client your Postgres
`DATABASE_URL`, and coordinate every write through `ablo.<model>`. Your database
is the system of record — Ablo never hosts your data. It is the transaction
layer on top: it registers your connection, commits every write there behind
row-level security, and fans the confirmed rows out to every connected client.

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

Every SDK and CLI call needs a key. Test and live keys work like Stripe's —
except both point at databases *you* own: `sk_test_*` for your dev database,
`sk_live_*` for production. There is no keyless mode; the public `/sandbox` page
is a hosted demo, not your app.

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


Register the schema once (init scaffolds this `ablo.d.ts`), and every type
is one parameter away — no `typeof schema` re-stating, anywhere:

```ts
// ablo.d.ts — once per project
import type { schema } from './ablo/schema';
declare module '@abloatai/ablo' {
  interface Register { Schema: typeof schema }
}
export {};
```

```ts
import type { Model } from '@abloatai/ablo/schema';

type WeatherReport = Model<'weatherReports'>; // fully typed from YOUR schema
```

(The same `Register` binding types every hook and client — it's the
TanStack-Router pattern: declare the source of truth once, everything
infers from it.)

## 3. Point Ablo at your database

The client takes your schema, your key, and your `DATABASE_URL`. On first
connect Ablo registers the connection (sent once over TLS, stored sealed, never
echoed back) and from then on commits every write directly to your Postgres.

```bash
# .env — server runtime only, never the browser
DATABASE_URL=postgres://ablo_app:...@host:5432/db
ABLO_API_KEY=sk_test_...
```

```ts
// ablo/client.ts
import Ablo from '@abloatai/ablo';
import { schema } from './schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  databaseUrl: process.env.DATABASE_URL, // your Postgres — rows live here, never with Ablo
});
```

Use a dedicated **non-superuser role** for the connection — Ablo enforces
tenant isolation with row-level security, so the server rejects superuser or
`BYPASSRLS` roles outright (`database_role_cannot_enforce_rls`).

> **Neon / Supabase note:** the connection string those dashboards hand you
> uses the database OWNER role (e.g. `neondb_owner`), which is `BYPASSRLS` —
> Ablo will reject it. You don't have to fix that by hand: `npx ablo dev`
> (next step) detects the unsafe role and offers to create the scoped one for
> you — from your machine, so the owner credential never reaches Ablo. It
> writes the new `DATABASE_URL` into your env file (the generated password is
> never printed).
>
> Prefer to do it manually? The equivalent SQL:
>
> ```sql
> CREATE ROLE ablo_app LOGIN PASSWORD '<strong password>'
>   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
> GRANT CREATE, CONNECT ON DATABASE <your_db> TO ablo_app;
> GRANT CREATE, USAGE ON SCHEMA public TO ablo_app;
> ```
>
> Then swap the user/password in the dashboard's string:
> `postgres://ablo_app:<password>@<same-host>/<same-db>?sslmode=require`.

Don't want a connection string to leave your infrastructure? Keep
`DATABASE_URL` in your app only and expose one signed **Data Source endpoint**
built from an ORM adapter instead — same product, same writes, see
[Connect Your Database](./data-sources.md). In that setup, omit `databaseUrl`
from `Ablo(...)`.

## 4. Push — Ablo provisions your tables for you

```bash
npx ablo push      # checks your DATABASE_URL role, pushes the schema (sandbox),
                   # provisions your synced-model tables (with row-level
                   # security) IN YOUR database, and writes ABLO_API_KEY to
                   # .env.local. Add --watch to re-push on every save.
```

Nothing runs locally — there is no dev server to start. Your app talks to
Ablo's hosted API with the sandbox key; the rows land in your database.

There is no separate migration step: the push provisions your synced-model
tables in the registered database server-side — your other tables are left
untouched. (`npx ablo migrate` still exists for the signed Data Source
endpoint mode, where Ablo never touches your database and DDL must run from
your side.)

`ablo push` uploads the schema *definition* —
model names, fields, types. That metadata is the only thing Ablo keeps; the
rows stay in your database. Skipping the push makes every write to a new or
changed model fail with `server_execute_unknown_model` — that error literally
means "run `npx ablo push`."

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
should not return a row while someone else is mid-edit, pass `ifClaimed: 'wait'`
to wait for the claim to clear, or `ifClaimed: 'fail'` to error out instead.
Call `handle.release()` when your work is done.

```ts
// Claim the row so other participants serialize behind us while we work.
const handle = await ablo.weatherReports.claim({
  id: 'weather_stockholm',
  action: 'checking_weather',
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
  console.log(`${active.heldBy} is ${active.action}`);
}

const handle = await ablo.weatherReports.claim({ id: 'weather_stockholm' });
await ablo.weatherReports.update({ id: handle.data.id, data: { status: 'ready' } });
await handle.release();
```

Use `{ wait: false }` on `claim` when work should be skipped instead of queued
behind an active holder.

## Next steps

Keep using the schema client for app and agent writes.

- [Integration Guide](./integration-guide.md) explains the full app, React, Data Source, multiplayer, and agent path.
- [Schema Contract](./schema-contract.md) explains what the schema drives across SDK, React, agents, Data Source, and schema push.
- [Guarantees](./guarantees.md) explains what confirmed writes and stale checks mean.
- [Client Behavior](./client-behavior.md) covers errors, retries, and public imports.
- [Connect Your Database](./data-sources.md) covers both connection shapes — `databaseUrl` and the signed Data Source endpoint.
- [AI SDK Tool](./examples/ai-sdk-tool.md) shows the same write path inside a tool call.
