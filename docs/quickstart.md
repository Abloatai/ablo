# Quickstart

Declare your state, create one row, and make one confirmed update.

If you already have a backend and database, still start here. The SDK call shape
is the same; [Integration Guide](./integration-guide.md) explains when to use
Ablo-managed state versus a Data Source that calls your existing API service.

## 1. Install

```bash
npm install @ablo/sync-engine
```

## 2. Set a Sandbox Key

Use an Ablo sandbox key while integrating.

```bash
export ABLO_API_KEY=sk_test_...
```

`ABLO_API_KEY` is for trusted server runtimes. Browser apps should use the React
provider with a scoped capability/session route, not a bundled API key.

## 3. Declare a Schema

```ts
import Ablo from '@ablo/sync-engine';
import { defineSchema, model, z } from '@ablo/sync-engine/schema';

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

Pass `schema` for typed model resources. Omit it only for advanced server-side
resource clients such as custom agents and MCP routes.

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

Use `edit` when AI or background work will touch an existing row for more than a
quick write. Other participants can see the activity while your code runs. The
activity is cleared when `update` finishes; call `release` if the work ends
without a write.

```ts
const edit = await ablo.weatherReports.edit('weather_stockholm', {
  activity: 'checking_weather',
  field: 'forecast',
  ttl: '2m',
});

// Your existing weather tool or agent call. While this runs, other clients see
// that weather_stockholm is being checked.
const weather = await weatherAgent.getWeather(edit.current.location, {
  signal: edit.signal,
});

await edit.update({
  status: 'ready',
  forecast: weather.summary,
});
```

Ablo does not fetch the weather. It keeps the activity visible, gives the agent
call an abort signal if the row changes, and clears the activity when
`edit.update(...)` finishes.

## 7. Multiplayer and Busy Work

There is no separate multiplayer mode. Use the same schema client for human UI,
server actions, and agents; Ablo fans out confirmed writes and keeps active
intents visible on the same resource.

Intents tell you when another human or agent is active on the same target. For
schema clients, wait on the intent stream and then write through the model.

```ts
const busy = ablo.intents.list({
  resource: 'weatherReports',
  id: 'weather_stockholm',
});

if (busy.length > 0) {
  await ablo.intents.waitFor(
    { resource: 'weatherReports', id: 'weather_stockholm' },
    { timeout: 30_000 },
  );
}

await ablo.weatherReports.update('weather_stockholm', { status: 'ready' });
```

`ifBusy` controls what happens when another human or agent is already working
on the same target:

- `return` returns immediately with active intents.
- `wait` waits for the intent stream to clear.
- `fail` throws `AbloBusyError` with the active intents attached.

## 8. Next Steps

Keep using the schema client for app and agent writes. Reach for the advanced
schema-less agent wrapper only when a worker intentionally cannot import the
app schema.

- [Integration Guide](./integration-guide.md) explains the full app, React, Data Source, multiplayer, and agent path.
- [Guarantees](./guarantees.md) explains what confirmed writes and stale checks mean.
- [Client Behavior](./client-behavior.md) covers errors, retries, and public imports.
- [Connect Your Database](./data-sources.md) covers the optional route for teams keeping rows in their own database.
- [AI SDK Tool](./examples/ai-sdk-tool.md) shows the same write path inside a tool call.
