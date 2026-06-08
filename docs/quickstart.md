# Quickstart

Start building with Ablo in two steps: install, then declare one model and write
through its generated client.

If you already have a backend and database, still start here. The SDK call shape
is the same; [Integration Guide](./integration-guide.md) explains when to use
Ablo-managed state versus a Data Source that calls your existing API service.

## 1. Install and set a sandbox key

```bash
npm install @abloatai/ablo
export ABLO_API_KEY=sk_test_...
```

`ABLO_API_KEY` is for trusted server runtimes. Browser apps should use the React
provider with a scoped session route, not a bundled API key.

## 2. Declare schema and write state

Your schema is the contract. It generates `ablo.<model>` methods for app code,
server actions, agents, React reads, and Data Source requests.

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
await ablo.ready();

const created = await ablo.weatherReports.create({
  data: {
    location: 'Stockholm',
    status: 'pending',
  },
});

const updated = await ablo.weatherReports.update({
  id: created.id,
  data: {
    status: 'ready',
    forecast: 'Light rain, 13C',
  },
});

console.log({ id: updated.id, status: updated.status });
```

Expected output:

```txt
{ id: '...', status: 'ready' }
```

## Run the example

```bash
cd packages/sync-engine
ABLO_API_KEY=sk_test_... npx tsx examples/quickstart.ts
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
