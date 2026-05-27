# API

Start with the schema client:

For end-to-end app setup across React, existing backends, Data Source, and
agents, read [Integration Guide](./integration-guide.md).


```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
  }),
});

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

await ablo.ready();
const [report] = await ablo.weatherReports.load({ where: { id: 'report_stockholm' } });
if (!report) throw new Error('Row not found');

await ablo.weatherReports.update('report_stockholm', { status: 'ready' }, { wait: 'confirmed' });
```

## Model Methods

Each schema model becomes a typed model on the client:

- `ablo.weatherReports.load({ where })` hydrates rows asynchronously.
- `ablo.weatherReports.retrieve(id)` reads one already-loaded row synchronously.
- `ablo.weatherReports.create(data)` creates a row.
- `ablo.weatherReports.update(id, data, options?)` updates a row.
- `ablo.weatherReports.delete(id, options?)` deletes a row.

`load` and `retrieve` are not aliases. Use `load` when the row may not be in the
local pool yet. Use `retrieve` after `ready()` or `load()` when you want a cheap
local read.

| Method | Returns | Use when |
|---|---|---|
| `load({ where })` | `Promise<T[]>` | You need to hydrate rows from local store and server. |
| `retrieve(id)` | `T \| undefined` | You already loaded the row and want a synchronous local read. |
| `list(options?)` | `T[]` | You want a synchronous local list. |
| `count(options?)` | `number` | You want a synchronous local count. |
| `create(data, options?)` | `Promise<T>` | You want to create through the schema model. |
| `update(id, data, options?)` | `Promise<T>` | You want to update through the schema model. |
| `delete(id, options?)` | `Promise<void>` | You want to delete through the schema model. |

`list` and `count` read the local pool. They default to live rows and accept:

```ts
const readyReports = ablo.weatherReports.list({
  where: { status: 'ready' },
  filter: (report) => !report.location.startsWith('[archived]'),
  orderBy: { updatedAt: 'desc' },
  limit: 20,
  scope: 'live', // 'live' | 'archived' | 'all'
});
```

## Protected Writes

Use `snapshot` when a write should reject if the row changed mid-flight:

```ts
const snap = ablo.snapshot({ weatherReports: 'report_stockholm' });

await ablo.weatherReports.update(
  'report_stockholm',
  { status: 'ready' },
  { readAt: snap.stamp, onStale: 'reject', wait: 'confirmed' },
);
```

Protected write options:

| Option | Purpose |
|---|---|
| `readAt` | The state cursor the write was based on. |
| `onStale` | Stale-state policy. Prefer `reject` for agent writes. |
| `wait` | `queued` resolves after local queueing; `confirmed` waits for server acceptance. |
| `idempotencyKey` | Stable key for retry-safe writes. The SDK generates one when omitted. |
| `timeout` | Maximum time to wait for the write call. |

## Claims

A claim tells humans and agents who is working on a target before the write
lands. One self-describing object carries the lifecycle in a single `status`
field. It lives on the coordination plane: ephemeral, TTL'd, broadcast to peers
in real time, and never persisted as a row.

Coordinate one through flat verbs on the model, beside `create`/`update`/`retrieve`:
`ablo.<model>.claim(id, ...)` to claim a row, `ablo.<model>.claimState(id)` to read
who holds it (synchronous; never blocks), and `ablo.<model>.release(id)` to release
early. Claims are **advisory** — they serialize on contention rather than locking.

### The Claim State Object

| Field | Type | Description |
|---|---|---|
| `object` | `'claim'` | String representing the object's type. |
| `id` | string | Unique identifier for the claim. |
| `status` | `'active' \| 'committed' \| 'expired' \| 'canceled'` | The whole lifecycle, in one field. |
| `target` | `{ type, id, field? }` | What is being coordinated. |
| `action` | string | Human-readable phase — `'editing'`, `'writing'`, `'reviewing'`. |
| `heldBy` | string | Participant id holding the claim. |
| `participantKind` | `'human' \| 'agent'` | Whether a human session or an agent holds it. |
| `expiresAt` | string | Ms-epoch at which the server auto-expires it if the holder doesn't finish. |

```json
{
  "object": "claim",
  "id": "claim_3MtwBwLkdIwHu7ix",
  "status": "active",
  "target": { "type": "weatherReports", "id": "report_stockholm", "field": "status" },
  "action": "editing",
  "heldBy": "agent:report-writer",
  "participantKind": "agent",
  "expiresAt": "1716580000000"
}
```

### Lifecycle

```
            claim(id)                  update(id) lands
  (free) ───────────▶ active ───────────────────────▶ committed
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
        canceled                 expired
   (release w/o write)        (TTL; holder died)
```

A target is free when `ablo.<model>.claimState(id)` is `null`. Terminal
states drop out of the live stream, so a present claim is active.

### Reading and claiming

`claimState(id)` is the read side for observers: synchronous, never blocks, and
returns the live claim state object (or `null`). `claim(id, ...)` is the write side:
it claims the row and returns the row. Because the claim is **advisory**, if
someone else already holds the row, `claim` waits for them to finish, then
re-reads the row before handing it back — so you always proceed from fresh state.
Default reads stay open; server/model reads can opt into `ifClaimed: 'wait'` or
`ifClaimed: 'fail'` when they should not read through active work.

```ts
// Read side — who is working on this target right now?
const claim = ablo.weatherReports.claimState('report_stockholm');
if (claim) {
  claim.heldBy; // 'agent:report-writer'
  claim.action; // 'editing'
}

// Write side — claim for the duration of the callback.
const updated = await ablo.weatherReports.claim(
  'report_stockholm',
  async (report) => ablo.weatherReports.update(report.id, { status: 'ready' }),
  { action: 'editing', ttl: '2m' },
);
updated.status; // 'ready'
```

Writes go through the normal flat `ablo.<model>.update(id, data)`. While you hold
a claim on `id`, that `update` is automatically stale-guarded: it rejects with
`AbloStaleContextError` if the row advanced past your claim point, so you re-read
before retrying. The callback form releases automatically when the callback
returns or throws, or call `ablo.weatherReports.release(id)` if you claimed manually and
need to release early.

## Agent

Most agents should import the same schema as the app and call
`ablo.<model>.load(...)`, `ablo.<model>.claim(...)`, and
`ablo.<model>.update(...)`.

## Errors

All SDK errors extend `AbloError` and expose a stable `type` string.

| Error | Meaning |
|---|---|
| `AbloAuthenticationError` | Missing, invalid, or expired credential. |
| `AbloPermissionError` | Credential is valid but the action is outside scope. |
| `AbloRateLimitError` | Rate limit or quota exceeded. |
| `AbloIdempotencyError` | Idempotency key was reused with a different request. |
| `AbloConnectionError` | Network, timeout, abort, or transport failure. |
| `AbloValidationError` | Invalid input. |
| `AbloServerError` | Server-side 5xx. |
| `AbloStaleContextError` | `readAt` no longer matches current state. |
| `AbloClaimedError` | Active claim conflict or claim wait timeout. |

See [Client Behavior](./client-behavior.md) for retry and timeout guidance.
