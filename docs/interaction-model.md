# Interaction Model

Ablo's public model is the path every human UI, server action, and agent uses on
every write:

```
Schema -> Model load -> Claim -> Model update -> Confirmation
```

## Primitives

| Primitive | Plane | Purpose |
|---|---|---|
| `Schema` | State | Declares typed models the app and agents can read and write. |
| `Model` | State | The generated `ablo.<model>` model. Use `load`, `retrieve`, `create`, `update`, and `delete`. |
| `Claim` | Coordination | Who is working on a target. Claimed via `ablo.<model>.claim(id, ...)` and read via `ablo.<model>.claimState(id)`. Ephemeral — never persisted. |
| `Commit` | Protocol | The durable write underneath model updates. Most users do not call it directly. |
| `Receipt` | Protocol | The lower-level durable result for custom runtimes. Schema writes use `wait: 'confirmed'`. |

### Why each primitive is separate

The plane separation isn't ceremony — collapsing any two of these would
lose a property that's hard to recover later. A reader coming from
Replicache or Yjs would expect just `Commit`; here's what the others buy
you over that minimum:

- **`Claim` is not a read lock.** Reads stay open. Claims serialize
  acting-on-the-row, so slow work can wait in FIFO order, re-read, and write
  from fresh state.
- **`Receipt` is not a `200 OK`.** It's the durable artifact a commit
  produced — accepted commit id, server-assigned timestamps, stale-check
  outcome — addressable after the fact and replayable into a different
  client. A status code can't be re-read by a sub-agent that wasn't on
  the original call.

The shape is borrowed from systems that learned the cost of collapse:
coordination from operational-transform CRDTs and Linear's optimistic
multiplayer model, and receipts from durable write protocols.

## Run Loop

A normal schema-backed run is:

```
const [report] = await ablo.weatherReports.load({ where: { id } });
const active = ablo.weatherReports.claimState(id);
await ablo.weatherReports.claim(id, async (report) => {
  await ablo.weatherReports.update(report.id, patch, { wait: 'confirmed' });
});
```

## Coordination

> Loop view only. Full claim reference — methods, the claim-state object, the
> `queue`, errors — is [Coordination](./coordination.md).

Claims broadcast across the org. Claim a row through the flat model verb, write
through the normal `update`, and the claim releases when the callback returns:

```ts
await ablo.weatherReports.claim(
  'report_stockholm',
  async (report) => {
    await ablo.weatherReports.update(report.id, { status: 'ready' }); // stale-guarded under the claim
  },
  { action: 'editing' },
);
```

`ablo.weatherReports.claimState('report_stockholm')` reads the live claim (or `null`) without
blocking. The claim is **advisory**: if another participant holds the row,
`claim` waits for them to finish and re-reads before handing back the row. The
same signal is visible to every schema client through `claimState(id)` and the live
claim stream.

## Conflict resolution

Schema updates can carry `readAt` and `onStale`. If the state advanced past
`readAt`, Ablo applies the `onStale` policy:

- `reject` — fail the commit (first writer wins).
- `merge` — apply the write if it does not overlap with concurrent changes.
- `force` — apply the write unconditionally.

The choice is per-commit. No CRDT default; the policy is explicit.

## The contract in one sentence

Declare schema, load state, coordinate a claim, update the model, and wait for confirmation.
