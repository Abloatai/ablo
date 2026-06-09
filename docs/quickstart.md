# Quickstart

Build with Ablo on **your own database**. You declare a small Ablo schema for the
models humans and agents edit together, point Ablo at your Postgres through a Data
Source adapter, and coordinate every write through `ablo.<model>`. You own the
`DATABASE_URL` — Ablo never connects to your database, it only calls an endpoint
you expose.

## 1. Install and get a key

```bash
npm install @abloatai/ablo
```

Sign up and copy a sandbox key from your org dashboard (or run `npx ablo login`),
then keep it in a trusted server runtime — never the browser:

```bash
export ABLO_API_KEY=sk_test_...
```

Every SDK and CLI call needs a key (`sk_test_*` for sandbox, `sk_live_*` for
production). There is no keyless mode; the public `/sandbox` page is a hosted demo,
not your app.

## 2. Declare your Ablo schema

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

## 3. Point Ablo at your database (Drizzle)

You own the connection. Keep `DATABASE_URL` in your app environment and expose one
endpoint that hands Ablo a `drizzleDataSource` adapter built from your Drizzle `db`
and the Ablo `schema`. Ablo signs a commit request; the adapter runs it in one
transaction against your Postgres and returns the canonical row.

```bash
# .env — both live in YOUR app, never inside Ablo(...)
DATABASE_URL=postgres://...
ABLO_API_KEY=sk_test_...
```

```ts
// app/api/ablo/source/route.ts
import { dataSourceNext } from '@abloatai/ablo/source/next';
import { drizzleDataSource } from '@abloatai/ablo/source/drizzle';
import { schema } from '@/ablo/schema';
import { db } from '@/db';

export const runtime = 'nodejs'; // the route touches your database

export const { POST } = dataSourceNext({
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  adapter: drizzleDataSource(db, schema),
});
```

Do not pass a database URL to `Ablo(...)` — the connection belongs to your app.
(On Prisma? Swap one line: `adapter: prismaDataSource(prisma, schema)`.)

## 4. Provision your tables, then push the schema

```bash
npx ablo migrate   # creates your synced-model tables + ablo_outbox / ablo_idempotency
                   # in YOUR database — your other tables are left untouched
npx ablo push      # uploads the schema to Ablo (REQUIRED before any write; or `ablo dev` to watch)
```

Skipping `push` makes every write to a new or changed model fail with
`server_execute_unknown_model` — that error literally means "run `npx ablo push`."

## 5. Write through the model

The client takes only your `ABLO_API_KEY`; the rows land in your Postgres.

```ts
// ablo/client.ts
import Ablo from '@abloatai/ablo';
import { schema } from './schema';

export const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
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
- [Connect Your Database](./data-sources.md) covers the optional route for teams keeping rows in their own database.
- [AI SDK Tool](./examples/ai-sdk-tool.md) shows the same write path inside a tool call.
