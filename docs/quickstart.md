# Quickstart

Declare your state, create one row, and make one confirmed update.

If you already have a backend and database, still start here. The SDK call shape
is the same; [Integration Guide](./integration-guide.md) explains when to use
Ablo-managed state versus a Data Source that calls your existing API service.

## 1. Install

```bash
npm install @abloatai/ablo
```

## 2. Set a Sandbox Key

Use an Ablo sandbox key while integrating.

```bash
export ABLO_API_KEY=sk_test_...
```

`ABLO_API_KEY` is for trusted server runtimes. Browser apps should use the React
provider with a scoped session route, not a bundled API key.

## 3. Declare a Schema

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
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
```

Customer apps should always pass `schema`. Treat it like Prisma's schema file:
it is the source of truth for typed model clients, realtime subscriptions,
agent writes, and Data Source requests.

## 4. Create and Update

```ts
await ablo.ready();

const created = await ablo.weatherReports.create({
  location: 'Stockholm',
  status: 'pending',
});

const updated = await ablo.weatherReports.update(created.id, {
  status: 'ready',
  forecast: 'Light rain, 13C',
});

console.log({ id: updated.id, status: updated.status });
```

Expected output:

```txt
{ id: '...', status: 'ready' }
```

## 5. Run the Example

```bash
cd examples
ABLO_API_KEY=sk_test_... npx tsx quickstart.ts
```

## 6. AI Activity on Existing State

When AI or background work will touch an existing row for more than a quick
write, coordinate through the flat model verbs: `ablo.<model>.claim(id, ...)` to
claim the row (returns the row), `ablo.<model>.claimState(id)` to read who's working
on it (synchronous; never blocks), and the normal `ablo.<model>.update(id, ...)`
to write. Normal reads still work while the claim is held; server reads can opt
into `ifClaimed: 'wait'` or `ifClaimed: 'fail'` when they should not read through
active work. The callback form releases the claim when the callback returns or
throws.

```ts
// Claim the row so other participants serialize behind us while we work.
await ablo.weatherReports.claim(
  'weather_stockholm',
  async (report) => {
    // Your existing weather tool or agent call. While this runs, other clients
    // see that weather_stockholm is being checked.
    const weather = await weatherAgent.getWeather(report.location);

    await ablo.weatherReports.update(report.id, {
      status: 'ready',
      forecast: weather.summary,
    });
  },
  { action: 'checking_weather', ttl: '2m' },
);
```

Ablo does not fetch the weather. The claim is **advisory**: if another
participant already holds the row, `claim` waits for them to finish and re-reads
before handing back the row. While you hold the claim, `update(id, ...)` is
stale-guarded and rejects with `AbloStaleContextError` if the row changed under
you. The claim releases automatically once the callback returns or throws.

## 7. Multiplayer and Claimed Work

There is no separate multiplayer mode. Use the same schema client for human UI,
server actions, and agents; Ablo fans out confirmed writes and keeps active
claims visible on the same model row.

`claimState(id)` tells you when another human or agent is active on the same row.
For schema clients, `claim(id, work)` waits fairly, re-reads, and then lets you
write through the model.

```ts
const active = ablo.weatherReports.claimState('weather_stockholm');
if (active) {
  console.log(`${active.heldBy} is ${active.action}`);
}

await ablo.weatherReports.claim('weather_stockholm', async (report) => {
  await ablo.weatherReports.update(report.id, { status: 'ready' });
});
```

Use `{ wait: false }` on `claim` when work should be skipped instead of queued
behind an active holder.

## 8. Next Steps

Keep using the schema client for app and agent writes.

- [Integration Guide](./integration-guide.md) explains the full app, React, Data Source, multiplayer, and agent path.
- [Guarantees](./guarantees.md) explains what confirmed writes and stale checks mean.
- [Client Behavior](./client-behavior.md) covers errors, retries, and public imports.
- [Connect Your Database](./data-sources.md) covers the optional route for teams keeping rows in their own database.
- [AI SDK Tool](./examples/ai-sdk-tool.md) shows the same write path inside a tool call.
