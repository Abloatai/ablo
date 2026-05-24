# Guarantees

This page is the short contract for what Ablo Sync guarantees at the state
boundary.

## Confirmed Writes

`wait: 'confirmed'` resolves only after the server accepts the write and returns
the authoritative sync cursor.

```ts
const updated = await ablo.tasks.update(
  'task_123',
  { status: 'done' },
  { wait: 'confirmed' },
);
```

If the call resolves, the write was accepted by the server. If it rejects, the
error explains whether the write was rejected for auth, validation, stale state,
active intent conflict, idempotency, rate limit, or transport failure.

Schema model writes return the updated model row. Advanced resource writes and
`commits.create(...)` return a receipt with the commit status and sync cursor.

## Optimistic Local State

Schema model writes update local state optimistically. This keeps UI and agent
tools responsive while the commit is sent to the server.

- With `wait: 'queued'` or omitted, the promise resolves after the local mutation
  is queued.
- With `wait: 'confirmed'`, the promise waits for server confirmation.
- If the server rejects the write, the SDK rolls back the optimistic change and
  raises a typed error.

The server remains the source of truth.

## Stale-Write Protection

Use `snapshot(...)` and `readAt` when a write depends on state the agent already
read:

```ts
const snap = ablo.snapshot({ tasks: 'task_123' });

await ablo.tasks.update(
  'task_123',
  { status: 'done' },
  { readAt: snap.stamp, onStale: 'reject', wait: 'confirmed' },
);
```

`onStale: 'reject'` prevents lost updates. If the target changed after the
snapshot, the server rejects the write instead of applying stale reasoning.

Advanced policies exist for controlled product flows:

- `reject` fails the write when state moved.
- `force` applies the write without stale protection.
- `flag` accepts the write and marks it for product review.
- `merge` is reserved for server-defined merge behavior.

## Intent Coordination

Intents are live coordination signals. They are not database locks.

When another human or agent is active on the same target, the caller chooses the
behavior:

- `ifBusy: 'return'` returns active intents immediately.
- `ifBusy: 'wait'` waits until the matching intent clears.
- `ifBusy: 'fail'` throws `AbloBusyError` with the active intents attached.

Schema clients wait from the realtime intent stream. Schema-less HTTP callers
must pass an explicit `busyPollInterval` if they choose `ifBusy: 'wait'`; Ablo
does not hide a hard-coded polling loop. `busyTimeout` is only a maximum wait.

## Agent Runs

`agent.run(...)` is the advanced schema-less run envelope for workers that cannot
import the app schema. It returns one of three statuses:

- `done` — the handler returned successfully.
- `failed` — the handler threw or the commit failed.
- `cancelled` — the run signal aborted.

Normal schema-backed agents should import the same schema as the app and write
through `ablo.<model>.update(...)`. The lower-level run envelope exists for
platform runtimes that need capability and task management without app code.

## Capabilities and Tasks

Capabilities scope what an agent is allowed to do. Tasks group a run for audit
and cost attribution.

Most users do not create either one manually. The SDK and hosted API manage the
common case. Manual capability and task APIs are for platform builders, custom
agent runtimes, and internal infrastructure.

Use `lease` as a crash cleanup window. A successful agent run still closes when
the handler returns, fails, or is cancelled.

## Audit Trail

Accepted writes can be attributed to:

- the actor that wrote,
- the human or system the actor worked on behalf of,
- the capability that scoped the write,
- the task or run that caused it,
- the resource, operation, and state cursor.

For agent work, this is what lets an audit surface answer: "what changed, who
authorized it, which run did it, and what state was it based on?"

## Persistence

Ablo defaults to volatile local persistence. That keeps the SDK focused on
coordination and audit instead of silently becoming a browser storage product.

Opt into durable browser cache and offline queueing when you need it:

```ts
const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  persistence: 'indexeddb',
});
```

Node, SSR, tests, and agents use volatile in-memory persistence automatically.

## Storage Boundary

Ablo does not need a customer database URL. When your own database is canonical,
Ablo calls a signed Data Source endpoint and records the coordination result for
receipts, realtime fanout, and audit. See [Connect Your Database](./data-sources.md).

## Batches

Most apps should use `ablo.<model>.create/update/delete`. Use
`commits.create(...)` only when you need a low-level batch or a schema-less
runtime.

Each operation in the commit carries its own target, data, stale policy, and
idempotency context. The server validates authorization, stale state, active
intent conflicts, and idempotency before accepting the commit.
