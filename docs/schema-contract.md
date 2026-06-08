# Schema Contract

Ablo's schema is the integration contract. Define it once, pass it to `Ablo(...)`,
and every actor gets the same typed model surface:

```txt
defineSchema(...) -> ablo.<model>.create/retrieve/update/claim(...)
```

That one object drives:

- typed model clients in trusted server runtimes,
- React selectors through `useAblo((ablo) => ablo.<model>.get(id))`,
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

## Reads and writes

Use async reads when the row may not be local:

```ts
const report = await ablo.weatherReports.retrieve({ id: reportId });
const ready = await ablo.weatherReports.list({ where: { status: 'ready' } });
```

Use synchronous local reads in render after data has synced:

```ts
const report = ablo.weatherReports.get(reportId);
const pending = ablo.weatherReports.getAll({ where: { status: 'pending' } });
```

Use model writes for every actor:

```ts
await ablo.weatherReports.update({ id: reportId, data: { status: 'ready' }, wait: 'confirmed' });
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

Every schema model needs a backing store:

- Use Ablo-managed state when the row can live in Ablo.
- Use a Data Source when your app database remains canonical.

Do not pass a database URL to `Ablo(...)`. Trusted runtimes use `ABLO_API_KEY`.
Browser code goes through `<AbloProvider>` or a scoped session route, never a raw
API key.

## Rules of thumb

- Start with fields and relations before load/index tuning.
- Import one schema into app code, server actions, agents, and Data Source routes.
- Keep direct database writes out of the coordinated path unless they are reported
  back through Data Source events.
- Use `claim` for slow read -> think -> write spans.
- Use `readAt` + `onStale: 'reject'` when a write must fail if the row changed
  after it was read.

For the shortest runnable path, start with [Quickstart](./quickstart.md). For a
production app, continue with [Integration Guide](./integration-guide.md).
