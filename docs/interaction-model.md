# Interaction Model

When a person, a server action, and an AI agent can all write to the same row,
you need one write path that stops them from clobbering each other. Ablo gives
you exactly one: load the row, claim it while you work, update it, and wait for
confirmation. This page walks through that path and the few primitives behind it.

Here's the whole path in one block — claim a row, update it inside the claim, and
let the claim release when your callback returns:

```ts
const report = await ablo.weatherReports.retrieve({ id: 'report_stockholm' });

await using claim = await ablo.weatherReports.claim({ id: 'report_stockholm' });
await ablo.weatherReports.update({ id: claim.data.id, data: { status: 'ready' }, wait: 'confirmed' });
```

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize instead
of clobbering.

## Primitives

| Primitive | Plane | Purpose |
|---|---|---|
| `Schema` | State | Declares typed models the app and agents can read and write. |
| `Model` | State | The generated `ablo.<model>` model. Use `retrieve`/`list` (async server reads), `get`/`getAll`/`getCount` (synchronous local reads), `create`, `update`, and `delete`. |
| `Claim` | Coordination | Who is working on a target. Taken via `ablo.<model>.claim({ id })` and read via `ablo.<model>.claim.state({ id })`. Ephemeral — never persisted. |
| `Commit` | Protocol | The durable write underneath model updates. Most users do not call it directly. |
| `Receipt` | Protocol | The lower-level durable result for custom runtimes. Schema writes use `wait: 'confirmed'`. |

### Why each primitive is separate

Why are `Claim`, `Commit`, and `Receipt` separate things instead of one? Each
does a job the others can't. If you're coming from Replicache or Yjs you'd
expect just `Commit`; here's what the other two buy you over that minimum:

- **`Claim` is not a read lock.** Reads stay open. Claims serialize
  acting-on-the-row, so slow work can wait in FIFO order, re-read, and write
  from fresh state.
- **`Receipt` is not a `200 OK`.** It's the durable artifact a commit
  produced — accepted commit id, server-assigned timestamps, stale-check
  outcome — addressable after the fact and replayable into a different
  client. A status code can't be re-read by a sub-agent that wasn't on
  the original call.

## Run Loop

A normal schema-backed run is:

```ts
const report = await ablo.weatherReports.retrieve({ id });
const active = ablo.weatherReports.claim.state({ id });
await using claim = await ablo.weatherReports.claim({ id });
await ablo.weatherReports.update({ id: claim.data.id, data: patch, wait: 'confirmed' });
```

`retrieve({ id })` is an async server read (await it). `claim.state({ id })` is a
synchronous local read of who currently holds the row — it never blocks.

## Coordination

> Loop view only. Full claim reference — methods, the claim-state object, the
> `claim.queue`, errors — is [Coordination](./coordination.md).

Claims broadcast across the org. Call `claim({ id })`, do your writes with the
normal `update` inside the `await using` scope, and the claim releases
automatically when the scope exits:

```ts
await using claim = await ablo.weatherReports.claim({
  id: 'report_stockholm',
  reason: 'editing',
});
await ablo.weatherReports.update({ id: claim.data.id, data: { status: 'ready' } }); // rejected if the row changed under the claim
```

`ablo.weatherReports.claim.state({ id: 'report_stockholm' })` reads the live claim (or
`null`) without blocking. Claims don't lock: if another participant holds the
row, `claim` waits for them to finish, re-reads, and then hands you the fresh
row. The same signal is visible to every schema client through `claim.state({ id })`
and the live claim stream.

## Conflict resolution

Schema updates can carry `readAt` and `onStale`. If the state advanced past
`readAt`, Ablo applies the `onStale` policy:

- `reject` — fail the commit (first writer wins).
- `merge` — apply the write if it does not overlap with concurrent changes.
- `force` — apply the write unconditionally.

The choice is per-commit. No CRDT default; the policy is explicit.

## The contract in one sentence

Declare schema, load state, coordinate a claim, update the model, and wait for confirmation.
