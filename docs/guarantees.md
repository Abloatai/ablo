# Guarantees

When an Ablo write succeeds, the server has accepted it — and when two people or
agents touch the same row, Ablo coordinates them instead of letting one silently
overwrite the other. This page is the precise list of what you can count on:
confirmed writes, stale-write protection, claims, and the audit trail behind
every change.

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize instead
of clobbering.

## Confirmed Writes

`wait: 'confirmed'` resolves only after the server accepts the write and returns
the authoritative sync cursor.

```ts
const updated = await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  wait: 'confirmed',
});
```

If the call resolves, the write was accepted by the server. If it rejects, the
typed error tells you exactly why — the most common reasons being failed
authorization, a schema validation error, or a stale-state or claim conflict
(each covered below).

Schema model writes return the updated model row.

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
const snap = ablo.snapshot({ weatherReports: 'report_stockholm' });

await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

`onStale: 'reject'` prevents lost updates. If the target changed after the
snapshot, the server rejects the write instead of applying stale reasoning.

Advanced policies exist for controlled product flows:

- `reject` fails the write when state moved.
- `force` applies the write without stale protection.
- `flag` accepts the write and marks it for product review.

`merge` is not yet available.

## Claim Coordination

> The guarantee, not the how-to. Methods, the claim-state object, and the `claim.queue`
> live in [Coordination](./coordination.md).

Claims are live coordination signals. They are not database locks.

`ablo.<model>.claim({ id })` serializes on contention: if another human or agent
already holds the row, the claim waits for them to finish, then re-reads the row
before handing it back, so you proceed from fresh state. Reads stay open while a
claim is held — `ablo.<model>.claim.state({ id })` returns the current claim state
(or `null`) without ever blocking. A server read can pass `ifClaimed: 'wait'` to
wait for the claim to clear, or `ifClaimed: 'fail'` to error out, when it should
not return a row while someone else is mid-edit.

A claim does not reject or block other writers; it announces work so peers
serialize behind it rather than racing. While you hold a claim, the matching
`ablo.<model>.update({ id, ... })` is rejected with `AbloStaleContextError` if the row
changed underneath you after your claim point.

## Agent Runs

Agents should import the same schema as the app and write through
`ablo.<model>.claim(...)` plus `ablo.<model>.update(...)`.

## Audit Trail

Accepted writes can be attributed to:

- the actor that wrote,
- the human or system the actor worked on behalf of,
- the model, operation, and state cursor.

For agent work, this is what lets an audit surface answer: "what changed, who
authorized it, which run did it, and what state was it based on?"

## Persistence

Ablo defaults to volatile in-memory persistence, so nothing is written to disk
unless you ask for it.

Opt into a durable browser cache that survives reloads when you need it:

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

## Writes

Use `ablo.<model>.create/update/delete` for state changes. The server validates
authorization, stale state, active claim conflicts, and idempotency before
accepting the write.
