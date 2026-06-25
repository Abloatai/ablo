# Debugging & Logs

By default the SDK is quiet — it logs only warnings and errors. When you're building a human + agent flow and want to *see* the coordination happen (who claimed what, who's waiting in line, who got preempted), turn on Ablo's diagnostic logging. Every line is prefixed `[Ablo]` so it's obvious which output is ours in a console full of other tools.

## Turn it on

```ts
import Ablo from '@abloatai/ablo';
import { schema } from './ablo/schema';

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY, debug: true });
```

`debug: true` is the simple switch. For finer control use `logLevel`, or set it without touching code via the `ABLO_LOG_LEVEL` environment variable.

```ts
Ablo({ schema, apiKey })                       // quiet — warnings + errors only (default)
Ablo({ schema, apiKey, debug: true })          // everything (coordination + lifecycle)
Ablo({ schema, apiKey, logLevel: 'info' })     // coordination + connection, no per-model noise
```

```bash
ABLO_LOG_LEVEL=debug npm run dev               # same, from the environment
```

### Levels

| Level | What it shows |
|---|---|
| `silent` | nothing |
| `error` | failures only |
| `warn` | **default** — warnings + errors |
| `info` | the above + the **coordination trace** (claims, grants, queueing) + connection state |
| `debug` | the above + internal lifecycle (per-model registration, store hydration) — the full firehose |

Precedence: an explicit `logLevel` wins, then `debug: true` (⇒ `debug`), then `ABLO_LOG_LEVEL`, then the `warn` default. `debug: false` (or omitting it) just means "don't raise the level."

> For watching coordination, **`logLevel: 'info'` is the sweet spot** — you get the claim trace without the per-model registration chatter that `debug` adds.

## What you'll see — the coordination trace

These lines (all at `info`) let you watch the human + agent handover you built:

```
[Ablo] claim: requesting documents:doc_42 for "editing" (will queue if contended)
[Ablo] claim: queued for documents:doc_42 — position 2 of 3, waiting
[Ablo] claim: granted 7f3c… — your turn (waited in queue)
[Ablo] claim: rejected documents:doc_42 — held by agent_writer
[Ablo] claim: lost documents:doc_42 (preempted or expired)
[Ablo] claim: released documents:doc_42
```

Read it as the lifecycle of one claim:

- **`requesting`** — your code (or an agent) called `ablo.<model>.claim(...)`. `(will queue if contended)` appears when you passed `{ queue: true }`.
- **`queued … position N of M`** — the row was held, so you're waiting in the FIFO line. This is the "an agent is waiting behind a claim" moment; it re-logs only when your position changes, so you can watch it advance.
- **`granted … your turn`** — you reached the head of the line; the lease is now yours and the row may have changed while you waited.
- **`rejected … held by <who>`** — your claim was refused because someone else holds it (and the model's policy didn't let you in).
- **`lost`** — you held the lease and it was taken (preempted by a higher-priority writer, or it expired).
- **`released`** — you (or `await using`'s scope exit) gave the lease back.

## Where the logs run

The coordination trace and the proactive credential refresh run **in the browser** (and any client that holds a live socket) — that's where the human + agent activity is. Server-side code that mints credentials or does one-shot reads won't emit the trace; it has no live session to narrate.

## Bring your own logger

Pass a `logger` to route Ablo's output into your own logging stack (Pino, Sentry breadcrumbs, etc.). A custom logger bypasses `debug`/`logLevel` entirely — you decide what to do with each level.

```ts
Ablo({
  schema,
  apiKey,
  logger: {
    debug: (...a) => {},
    info: (...a) => myLogger.info({ ablo: a }),
    warn: (...a) => myLogger.warn({ ablo: a }),
    error: (...a) => myLogger.error({ ablo: a }),
  },
});
```

## Read the coordination in code — the activity log

The console trace above is for *you*, at a terminal. To put the same activity **inside your app** — an activity feed, a "who's editing" badge, a Sentry breadcrumb trail — read it programmatically. Same events, three layers; pick by audience:

| Layer | You get | Best for |
|---|---|---|
| `logger` (above) | `[Ablo]` text lines | watching a terminal |
| `observability` | typed `ClaimEvent` / `ConflictEvent` objects | dashboards, alerting (Sentry / Datadog / OTel) |
| `ClaimLog` | an ordered, **reactive** list of both | rendering an activity feed on a page |

### The events

Every claim state change is a `ClaimEvent`; every notify-instead-of-abort stale write (a write that succeeded but whose premise had moved) is a `ConflictEvent`:

```ts
interface ClaimEvent {
  phase: 'acquired' | 'queued' | 'granted' | 'lost' | 'rejected' | 'expired';
  model?: string; id?: string; field?: string;          // the claimed row
  actor?: string; participantKind?: 'user' | 'agent' | 'system';
  position?: number;   // FIFO position, when queued
  reason?: string;     // why, on rejected
  claimId?: string;
}

interface ConflictEvent {
  clientTxId: string;
  rows: { model: string; id: string; fields: string[]; writtenBy?: 'user' | 'agent' | 'system' }[];
}
```

`phase` is past-tense — the state the claim just entered — and maps one-to-one to what arrives on the wire.

### Collect them — `ClaimLog`

`ClaimLog` records both into an ordered list. Hand it to `observability`, then read it back:

```ts
import Ablo, { ClaimLog } from '@abloatai/ablo';

const log = new ClaimLog();
const ablo = Ablo({ schema, apiKey, observability: log });

// …run the agents…
console.log(`${log}`);   // a printable, ⚠-marked timeline
log.entries;             // ClaimLogEntry[] — every event, in order, with a `.line`
log.collisions();        // just the rejected/lost claims + stale writes
```

It's also the simplest way to **assert** coordination in a test — no log scraping:

```ts
expect(log.collisions()).toHaveLength(0);   // no one stepped on anyone
```

### Show it on a page — reactive

`ClaimLog.onChange` fires on every event and returns an unsubscribe — the exact shape `useSyncExternalStore` wants, so a live feed is a few lines:

```tsx
import { useSyncExternalStore } from 'react';
import { ClaimLog } from '@abloatai/ablo';

function ActivityFeed({ log }: { log: ClaimLog }) {
  const entries = useSyncExternalStore(log.onChange, () => log.entries);
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.seq} className={e.collision ? 'text-amber-600' : undefined}>{e.line}</li>
      ))}
    </ul>
  );
}
```

> `ClaimLog` lives in browser memory: it starts empty on load and shows events that arrive while mounted. For a feed that survives reload, persist `entries` yourself — but for a live coordination panel, the in-memory log is exactly right.

For **"who holds *this* row right now"** (a badge, not a feed), don't use `ClaimLog` — read the reactive claim state directly. It re-renders on change with no extra wiring:

```tsx
const holder = useAblo((ablo) => ablo.documents.claim.state({ id }));   // Claim | null
```

See [React](./react.md) and [Coordination](./coordination.md) for the claim-read APIs.

### Route to your own backend

`ClaimLog` is one implementation of the `observability` slot. To push events into Sentry, Datadog, or OpenTelemetry instead, spread `noopObservability` and override just the two coordination hooks:

```ts
import Ablo, { noopObservability } from '@abloatai/ablo';

const ablo = Ablo({
  schema, apiKey,
  observability: {
    ...noopObservability,
    captureClaim: (e) => {
      if (e.phase === 'rejected') Sentry.captureMessage(`claim blocked: ${e.model}/${e.id} by ${e.actor}`);
    },
    captureConflict: (e) => Sentry.captureMessage(`stale write tx ${e.clientTxId} on ${e.rows.length} row(s)`),
  },
});
```

## Errors

Ablo's thrown errors are typed and self-describing — `String(err)` (or logging it) yields one clean line, never a stack dump:

```
AbloValidationError [model_required_field_missing]: A required field was absent. (see https://docs.abloatai.com/errors#model_required_field_missing) [request_id: req_8Fk2aQ]
```

Branch on `err.code` (stable) — never on the message (rewordable). See [Client Behavior](./client-behavior.md) for the full error model and which codes are safe to retry.
