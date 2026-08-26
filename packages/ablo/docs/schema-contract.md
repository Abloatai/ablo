# Schema Contract

> One schema becomes typed clients, agent writes, interface reads, and the hosted push.

Ablo's schema is the integration contract. Define it once, pass it to `Ablo(...)`,
and every actor gets the same typed model surface:

```txt
defineSchema(...) -> ablo.<model>.create/get/update/claim(...)
```

That one object drives:

- typed model clients in trusted server runtimes,
- React selectors through `useAblo((ablo) => ablo.<model>.local.get(id))`,
- agent and background-worker writes,
- Data Source request/response shape when your database stays canonical,
- hosted schema push, migration planning, and schema-version gating.

## Minimal shape

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
    forecast: z.string().optional(),
  }),
});

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});

await ablo.ready();

const report = await ablo.weatherReports.create({
  data: {
    location: 'Stockholm',
    status: 'pending',
  },
});
```

The model key (`weatherReports`) becomes the client namespace
(`ablo.weatherReports`). The Zod fields become the create/update/read type
contract. You should not create a parallel string-keyed write path for the same
data.

### The one field you don't declare

`id` is supplied on every row, so leave it out of your `model(...)` fields. That
is the whole list.

Two things look like framework territory and are not. **Audit fields are yours to
declare and yours to fill.** Add `createdAt`, `updatedAt` or `createdBy` and
`ablo migrate` gives each a column, which your own write or a database default
then populates; Ablo records who changed what in its transaction log and does not
write these columns for you. Omit them and no column is created at all; the model
still reads and writes, it just orders and attributes its history less precisely.

**The tenancy column** (`organizationId` by default) comes from the model's
`policy` rather than its field list, so you neither declare it nor lose it.

## Reads and writes

Use async reads when the row may not be local:

```ts
const report = await ablo.weatherReports.read({ id: reportId });
const ready = await ablo.weatherReports.list({ where: { status: 'ready' } });
```

Use synchronous local reads in render after data has synced:

```ts
const report = ablo.weatherReports.local.get(reportId);
const pending = ablo.weatherReports.local.list({ where: { status: 'pending' } });
```

Use model writes for every actor:

```ts
await ablo.weatherReports.update({ id: reportId, data: { status: 'ready' } });
```

## Coordination

Agents and background jobs often read, call a tool or model, then write later.
Wrap that slow span in `claim`:

```ts
const handle = await ablo.weatherReports.claim({ id: reportId });
const forecast = await getForecast(handle.data.location);
await ablo.weatherReports.update({ id: handle.data.id, data: { status: 'ready', forecast } });
await handle.release();
```

If another writer already holds the row, `claim` waits, re-reads, and hands you
the fresh row. Reads stay open; only acting on the row serializes.

## Storage boundary

Every schema model is backed by your own database, and you write to it through
`ablo.<model>`. There are three start states, all covered in [Connect Your
Database](./data-sources.md) (the single source of truth): a development branch
with no database yet (`apiKey` only — Ablo keeps that branch's rows in its own
log), `npx ablo connect` (a scoped writer role plus logical replication, so Ablo
writes your rows and confirms them over the WAL), or a signed Data Source
endpoint when your database can't grant replication.

Your database connects out of band, so the client holds only `ABLO_API_KEY` —
never a connection string. Browser code goes through `<AbloProvider>` or a scoped
session route, never a raw API key.

## Rules of thumb

- Start with fields and relations before load/index tuning.
- Import one schema into app code, server actions, agents, and Data Source routes.
- Keep direct database writes out of the coordinated path unless they are reported
  back through Data Source events.
- Use `claim` for slow read -> think -> write spans.
- Use `read` and pass its exact row in `reads` when a write must fail if the row
  changed after it was read.

For the shortest runnable path, start with [Quickstart](./quickstart.md). For a
production app, continue with [Integration Guide](./integration-guide.md).
