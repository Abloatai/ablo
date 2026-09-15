# Concurrency Convention

> A write either declares what it read or deliberately does not.

Use a captured read when a write must be rejected because an earlier premise
changed.

Read the authoritative premise, carry
that exact evidence into the write, and handle the documented failure code.

Ablo does not put a configurable stale mode between your code and a
commit. The public choice is visible at the call site:

- `get` and `list` observe state. They do not create a write premise.
- `read` returns a row that can guard its own update or delete with
  `ifUnchanged`, or another mutation through `reads`.
- a mutation with `ifUnchanged` or `reads` rejects with
  `AbloStaleContextError` if any declared premise changed;
- a mutation without either option is an unconditional, last-write-wins
  assignment when no active claim applies.

## Guarded writes

Use `read` for the target row, then pass the exact returned object as
`ifUnchanged`:

```ts
const record = await ablo.records.read({ id });
if (!record) return;

await ablo.records.update({
  id: record.id,
  data: decide(record),
  ifUnchanged: record,
});
```

`read` returns `undefined` when the id is absent or outside the caller's
subject scope. Those cases deliberately look identical, so the lookup cannot
be used as an existence oracle.

When other rows also influenced the decision, pass them in `reads`:

```ts
const record = await ablo.records.read({ id });
const rules = await ablo.rules.read({ id: rulesId });
if (!record || !rules) throw new Error('required input is missing');

await ablo.records.update({
  id: record.id,
  data: decide(record, rules),
  ifUnchanged: record,
  reads: [rules],
});
```

Ablo records only the evidence needed for the check: model, id, and the
watermark at which the row was read. It does not retain the row's contents.
The exact object identity matters for `ifUnchanged` and `reads`, so clones,
fabricated rows, and rows from a different client are rejected locally.

The server validates every declared premise inside the write transaction. If
one is stale, the entire mutation rejects before any write applies. Re-read,
recompute, and submit a new mutation when that is the behavior you want.

```ts
import { AbloStaleContextError } from '@abloatai/ablo';

try {
  await submitGuardedWrite();
} catch (error) {
  if (error instanceof AbloStaleContextError && error.code === 'stale_context') {
    return rebuildFromFreshReads();
  }
  throw error;
}
```

`error.type` is the class-name discriminator (`AbloStaleContextError`);
`error.code` is the wire condition (`stale_context`).

## Unguarded writes

Use `get` or `list` when you only need to observe, and omit `ifUnchanged` and
`reads` when the new value should win regardless of what was previously observed:

```ts
const visible = await ablo.records.get({ id });
await ablo.records.update({ id, data: { status: 'done' } });
```

This is deliberately unconditional, not an implicit fallback. It is suitable
for independent assignments and inappropriate for read-modify-write decisions.

## Functional updates

For a pure calculation based on one current row, use the functional form:

```ts
await ablo.counters.update(counterId, (current) => ({
  value: current.value + 1,
}));
```

The SDK reads, attempts a guarded write, and retries from fresh state within a
bounded budget. Because the updater may run more than once, do not perform
side effects inside it.

## Claims

A claim protects a target across a slower read → decide → write interval.
Foreign writers are rejected while the claim is active; contenders that ask
to queue wait in order. Ordinary reads stay open.

When the final effect remains in an existing application path—such as its API,
database transaction, filesystem, or Git merge—start with
[Coordinate existing work](./coordinate-existing-work.md). Use the
row-backed claim below when the target and final write belong to an Ablo model.

Claims and stale reads answer different questions:

| Mechanism | Lifetime | Question |
|---|---|---|
| `ifUnchanged` | One mutation | Is the target row still current? |
| `reads` | One mutation | Is every input to this decision still current? |
| claim | Slow work interval | Who may write this target while work is underway? |
| database transaction | One apply | Can this physical change commit atomically? |
| idempotency key | Retries | Has this same mutation already been applied? |

Claims do not hold a Postgres transaction open while an agent thinks. The
database transaction remains short and owns only validation plus apply.

## Cross-row and batch premises

A write may depend on rows other than its target. Put every influential row in
`reads`; if any one changed, Ablo rejects the whole mutation so atomicity is
preserved. Declare only material dependencies, because broader premises create
more contention.

Low-level runtimes can also declare row or group watermarks directly. They have
the same fixed result: stale rejects, fresh applies.

## Live change delivery is separate

Model `onChange` is not a stale-write disposition. It streams committed changes
to a stateful WebSocket client. `context().onChange` has the narrower job of
calling once when one of that context's exact reads changes; HTTP delivers it
through a response held open for that listener. Neither replaces passing target
evidence through `ifUnchanged` or other premises through `reads`.

## Boundaries

Concurrency control does not replace authorization, database constraints,
transactions, or idempotency. The rule at the SDK boundary is intentionally
small: `read` captures evidence, `ifUnchanged` or `reads` enforces it, and
omission means an unconditional write.
