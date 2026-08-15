# Coordination

> Choose plain writes, functional updates, stale guards, or claims without losing concurrent work.

Ablo gives you several concurrency tools because not every write has the same
meaning. Choose the narrowest one that matches the operation.

| Situation | Use | Result |
|---|---|---|
| Set an independent value | `update({ id, data })` | Last-write-wins when no claim applies. |
| Compute a value from the current row | `update(id, current => next)` | Re-reads and retries if the row changes concurrently. |
| Write only if earlier rows are still current | `reads: [record, policy]` | Rejects when an explicitly named dependency changed. |
| Read, call a model, then write | `claim({ id })` | Other participants cannot write the claimed target by default until your claim ends. |

**If a model call sits between the read and the write, take a claim.** A stale
guard tells you the row moved after you have already paid for the turn. A claim
makes the contender wait before it spends anything, and it reads the winner's
result rather than reasoning against state that has since moved.

The important boundary is explicit: a plain update does not claim a row and
does not carry a stale premise. It is intentionally last-write-wins.

## Explicit read dependencies

Pass the exact rows that produced a decision on the write:

```ts
const record = await ablo.records.get({ id: recordId });
const policy = await ablo.policies.get({ id: policyId });
if (!record || !policy) throw new Error('required input is missing');

const result = await model({ record, policy });

await ablo.records.update({
  id: record.id,
  data: result,
  reads: [record, policy],
});
```

This means “apply this update only if the rows used to produce it have not
changed.” The exact returned objects carry opaque evidence; no watermark is
exposed. Same-row and cross-row dependencies use one shape. Incidental reads do
nothing, and cloned, fabricated, or cross-client rows fail locally.

When one decision needs several Ablo reads plus application-owned memory or
retrieval results, [Context](./context.md) assembles those values and returns
the exact authoritative rows as `ctx.reads`.

An `undefined` result cannot carry evidence. Guarded absence therefore remains
a separate low-level design; do not treat a missing read as an automatic
create-if-absent condition.

## Functional updates

When the next value is a function of the current one, pass an updater rather
than fixed data:

```ts
const document = await ablo.records.update(recordId, (current) => ({
  revision: current.revision + 1,
  content: revise(current.content),
}));
```

The SDK reads the current row, runs the updater, and writes only if that row is
still current. If another write wins first, it re-reads and runs the updater
again. This prevents the usual lost-update race without holding a claim across
your application code.

Use this form only for a pure calculation. Because the updater may run more than
once, do not send email, charge a card, call a model, or perform another side
effect inside it.

You can bound or cancel reconciliation:

```ts
await ablo.records.update(
  recordId,
  (current) => ({ revision: current.revision + 1 }),
  { retries: 8, signal: request.signal },
);
```

If contention continues beyond the retry budget, the call rejects with
`AbloContentionError` and does not apply a stale calculation.

## Stale guards

Use explicit returned rows when application code reads first and writes later,
but does not need to reserve the row:

```ts
const report = await ablo.reports.get({ id: reportId });
if (!report) throw new Error('report missing');

await ablo.reports.update({
  id: report.id,
  data: { status: 'ready' },
  reads: [report],
});
```

The dispositions are:

| `onStale` | Behavior |
|---|---|
| `reject` | Reject the write if its premise is stale. |
| `notify` | Leave the row unchanged and return the current value for reconciliation. |
| `overwrite` | Apply the write without a stale check. |

See [Concurrency Convention](./concurrency-convention.md) for guarded batches
and notifications.

### Decide the model's conflict policy

Who yields is a design decision about the model, not something to restate on
every write. Declare it once, in the schema, and it travels to the server with
the rest of the model:

```ts
import { coordination, model, z } from '@abloatai/ablo/schema';

const cards = model(
  { title: z.string() },
  {
    conflict: coordination.humansOverwrite().agentsReject(),
  },
);
```

An omitted participant kind uses the engine default, `reject`. A per-write
`onStale` states the disposition for that one write. Keep the policy simple, and
document any rule that lets a participant overwrite a held claim.

## Claims

Use a claim when work must remain exclusive across a slow gap such as an LLM
call or another external service:

```ts
await using claim = await ablo.reports.claim({
  id: reportId,
  description: 'generating forecast',
});

const forecast = await generateForecast(claim.data.location);

await ablo.reports.update({
  id: claim.data.id,
  data: { forecast, status: 'ready' },
});
```

If another participant already holds the target, `claim` waits its turn and
then resolves with a fresh row in `claim.data`. Ordinary reads remain open. By
default, a write from a participant that does not hold the active claim is
rejected; an explicit model conflict policy can choose otherwise.

Bind claims with `await using` whenever possible. The claim then releases when
the scope exits, including when the external call or write throws. For runtimes
without explicit resource management, use `try/finally` and
`await claim.release()`.

### One identity per participant

Explicit claims coordinate authenticated participants. Two clients using the
same credential represent the same participant and do not exclude one another.
Mint a distinct scoped session for each independently coordinated agent:

```ts
const { token } = await server.sessions.create({
  agent: { id: `forecast-agent-${workerId}` },
});

const agent = Ablo({ schema, apiKey: token });
```

Functional updates do not require distinct participant identities because they
protect the row version rather than a participant-held claim.

### Skip instead of wait

For deduplicated jobs, skip work when another participant already owns it:

```ts
const claim = await ablo.records.claim({
  id: recordId,
  contention: { mode: 'skip' },
});

if (!claim) return;

try {
  await processTask(claim.data);
} finally {
  await claim.release();
}
```

To wait with limits, keep the policy together:

```ts
const claim = await ablo.records.claim({
  id: recordId,
  contention: {
    mode: 'wait',
    maxDepth: 3,
    timeoutMs: 30_000,
    signal: request.signal,
  },
});
```

### Claim part of a row

Narrow a claim when independent fields may be edited concurrently:

```ts
await using claim = await ablo.records.claim({
  id: recordId,
  fields: (record) => record.status,
});
```

Claims on disjoint fields can coexist. A whole-row claim conflicts with every
field claim on that row.

The target options are:

| Option | Purpose |
|---|---|
| `options.field` | Claim one field by its wire-level name. Prefer the typed selector in application code. |
| `options.fields` | Claim one or more schema fields with a typed selector. |
| `options.meta` | Attach application-defined metadata observers may display. |

## Observe coordination

Read current claim state without blocking:

```ts
const holder = ablo.records.claim.state({ id: recordId });
const queue = ablo.records.claim.queue({ id: recordId });
```

Use this state for presence and progress UI. Do not use an observed `null` as a
substitute for claiming: another participant can acquire the row immediately
after your read.

The main methods are:

| Method | Purpose |
|---|---|
| `claim({ id })` | Acquire the target, waiting by default. |
| `claim.state({ id })` | Read the current holder without blocking. |
| `claim.queue({ id })` | Read the current wait order. |
| `claim.release({ id })` | Release early when you do not hold a handle. |
| `join({ scope })` | Observe presence for a broader scope. |

## Choosing correctly

- Prefer a plain update for values that do not depend on an earlier read.
- Prefer a functional update for a quick, pure read-modify-write calculation.
- Prefer a stale guard when your caller should decide how to reconcile.
- Prefer a claim when you must hold exclusivity across slow or side-effecting
  work.
- Prefer idempotency for safe retries; it solves a different problem from
  concurrency.

For exact error codes and recovery guidance, see [Errors](./errors.md). For what
a confirmed write promises, see [Guarantees](./guarantees.md).
