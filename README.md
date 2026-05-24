# Ablo

Ablo Sync is a schema-first state control layer for AI agents and collaborative apps.

Use it when human UI, server actions, and AI agents need to edit the same typed
state with realtime fanout, stale-write protection, active-work coordination,
and audit.

```txt
schema -> ablo.<model>.create/load/edit/update(...)
```

## Install

```bash
npm install @ablo/sync-engine
```

Requires Node 22+ and TypeScript 5+.

## Get a Test Key

Create an Ablo sandbox and copy an `sk_test_*` API key. Keep API keys in trusted
server runtimes only.

```bash
export ABLO_API_KEY=sk_test_...
```

Browser apps should use a scoped capability/session route through the React
provider. Do not ship `ABLO_API_KEY` in a browser bundle.

## Quick Start

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

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});

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

await ablo.dispose();
```

Expected output:

```txt
{ id: '...', status: 'ready' }
```

Pass `schema` for typed model resources. Omit it only for advanced server-side
resource clients such as custom agents and MCP routes.

Run the package example from this directory:

```bash
cd examples
ABLO_API_KEY=sk_test_... npx tsx quickstart.ts
```

For a production integration with React, an existing backend, Data Source, and
future agents, read [Integration Guide](./docs/integration-guide.md).

## AI Activity on Existing State

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

## Multiplayer

There is no separate multiplayer mode. When human UI, server actions, and agent
workers use the same schema client and write through `ablo.<model>`, they are on
the same shared resource stream.

- `ablo.<model>.create/update/delete` fan out confirmed deltas to subscribers.
- `useAblo(...)` gives React clients the live row plus active intents.
- `ablo.<model>.edit(...)` lets humans and agents see active work before a write lands.
- `ablo.intents` remains available for custom lower-level coordination.

If a team writes directly to its own database outside Ablo, that write bypasses
the multiplayer stream until the app reports it through Data Source events.

Under the hood, capabilities, tasks, leases, intents, commits, and receipts are
real protocol primitives. They exist so agent work is scoped, coordinated,
attributable, and cleaned up if a runtime disappears. They should not be
ceremony in the first integration.

## Load vs Retrieve

For schema clients, `load` and `retrieve` are intentionally different:

- `ablo.weatherReports.load({ where })` is async. It hydrates matching rows from the
  local store and server, then returns them.
- `ablo.weatherReports.retrieve(id)` is sync. It reads one already-loaded row from the
  local pool and returns `undefined` if it is not loaded yet.
- `ablo.resource('weatherReports').retrieve(id)` is the lower-level resource API. It
  returns `{ data, stamp, intents }` for custom runtimes that need raw read
  stamps and receipts.

## Activity and Busy State

Model edit activity is the live coordination signal. If another participant is
reading, editing, or updating an entity, Ablo can return that state, wait for it
to clear, or fail fast with `AbloBusyError`.

```ts
const busy = ablo.intents.list({
  resource: 'weatherReports',
  id: 'weather_stockholm',
});

if (busy.length > 0) {
  console.log(`${busy[0].actor} is ${busy[0].action}`);
}

await ablo.intents.waitFor(
  { resource: 'weatherReports', id: 'weather_stockholm' },
);
```

Policy names are literal:

- `ifBusy: 'return'` returns immediately with `intents`.
- `ifBusy: 'wait'` waits on the live intent stream. Plain HTTP callers must
  provide their own explicit polling policy instead of getting hidden SDK polling.
- `ifBusy: 'fail'` throws `AbloBusyError` with the active intents attached.

## Persistence

Ablo defaults to volatile local persistence. That keeps the SDK focused on shared
state coordination instead of silently adding an IndexedDB storage product to
every browser app.

Opt into browser durable local cache and offline queueing when you need it:

```ts
const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  persistence: 'indexeddb',
});
```

Node, SSR, tests, and agents use volatile in-memory persistence automatically.

## Connect Your Database

Every schema model has a backing store. By default, Ablo stores rows for the
models you declare, so `ablo.weatherReports.create(...)` and `ablo.weatherReports.update(...)`
write to Ablo-managed state.

If your existing database remains the source of truth, connect it with a signed
Data Source endpoint. Your app keeps the database credentials; Ablo sends signed
commit requests to your route.

```bash
ABLO_DATA_SOURCE_SIGNING_SECRET=whsec_...
```

See [Connect Your Database](./docs/data-sources.md) for the route and commit shape.

## Agent Runs

Most agent workers should import the same schema and use
`ablo.<model>.load(...)` plus `ablo.<model>.update(...)`. The schema-less
`agent.run(...)` wrapper exists for advanced workers that intentionally cannot
import the app schema.

## Production Reference

- [Guarantees](./docs/guarantees.md) — confirmed writes, stale-write protection, intent coordination, and agent lifecycle.
- [Integration Guide](./docs/integration-guide.md) — pick the backing mode and integrate React, Data Source, multiplayer, and agents.
- [Client Behavior](./docs/client-behavior.md) — options, errors, retries, timeouts, and public imports.
- [Connect Your Database](./docs/data-sources.md) — keep canonical rows in your app database without giving Ablo database credentials.
- [Existing Python Backend](./docs/examples/existing-python-backend.md) — migrate existing Python endpoints to multiplayer and agent-safe writes gradually.
- [AI SDK Tool](./docs/examples/ai-sdk-tool.md) — use Ablo inside an AI SDK tool call.
- [Server Agent](./docs/examples/server-agent.md) — schema-backed worker plus advanced schema-less run.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
