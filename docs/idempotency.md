# Idempotency

> Make a retried write safe: the same key never applies the same change twice.

An agent retries. A socket drops mid-commit, a worker restarts, a queue redelivers — and the write
you already sent arrives again. An idempotency key is how Ablo tells a retry from a new intention.

Every model write carries one. The SDK generates a key when you omit it, which makes an in-process
retry safe automatically. It cannot make a retry across a process restart safe, because a new
process generates a new key — so for anything that must survive a crash, supply your own.

```ts
await ablo.tasks.update({
  id: taskId,
  data: { status: 'done' },
  idempotencyKey: `task:${taskId}:mark-done:v1`,
  wait: 'confirmed',
});
```

## The one rule

**Derive the key from the business event, not from the attempt.** A key built from
`crypto.randomUUID()` at the call site is regenerated on every retry, so it protects nothing — each
attempt looks like a new intention and the write lands twice. A key built from the thing that
happened (`task:42:mark-done:v1`) is identical on every retry by construction, which is the whole
point.

The same rule stated as its failure: never derive a key from a timestamp, an attempt counter, or a
random value. If two retries of one operation can produce different keys, you have no idempotency.

## How it works

The key is not a lookup that happens before the write — it is the **execution lock on the write
itself**. Ablo inserts a pending row keyed by the caller and the key inside the same transaction as
the mutation, and a unique index makes that insert the lock:

- **Insert wins** — this transaction owns the execution and runs the write.
- **Insert conflicts** — someone else owns it. The second caller waits for the owner to finish and
  then replays its recorded result.
- **Insert conflicts, different request** — the key was reused to mean something else. Rejected.

Because the lock and the write share a transaction, there is no window in which a write has happened
but its key has not been recorded.

Keys are scoped to **the organization and the participant**, not globally. Two agents can use the
same key string without colliding, and one agent can never replay another's result.

## The four outcomes

| You send | Ablo does |
|---|---|
| A new key | Runs the write. |
| The same key, the same request, already finished | Replays the recorded result. The write does not run again. |
| The same key, the same request, still running | Waits for the in-flight attempt, then replays its result. If the original is still running after a short wait, rejects with `idempotency_conflict` (409) — retry the same key. |
| The same key, a **different** request | Rejects with `idempotency_conflict` (409). A key is bound to the request it first arrived with. |

Both conflict cases return the same code, so tell them apart by what your own
client did. If you retried an identical request, the original is still in flight
— wait and retry the same key. If you changed the request, that is a client bug:
use a new key.

## Failures are not replayed — they re-run

This is where Ablo deliberately differs from Stripe and from most payment APIs, and it is the
behaviour most likely to surprise you.

**Only successful writes are recorded.** A write that failed leaves no idempotency record, so
retrying it with the same key **executes fresh** rather than replaying the error.

That is the right default here because most failures are ones you can fix and legitimately want to
re-attempt — a validation error, a stale premise, a claim held by someone else. Replaying the
original error for 24 hours would strand the caller behind a decision that is no longer true.

The consequence to hold onto: a retry after a failure is a real execution. If a write failed in a
way that leaves you unsure whether it landed — a timeout, a dropped socket — do not assume the retry
is a no-op. Retry with the **same key**: if the original did land, the recorded success replays; if
it did not, the write runs now. That is exactly the case idempotency exists for.

## The window

A recorded result is retained for **24 hours**, then expires. Within that window a repeated key
replays. After it, the key is forgotten and reusing it starts a genuinely new write.

Treat 24 hours as *how long a retry is guaranteed safe*, not as permanent deduplication. A nightly
job that reuses yesterday's key will execute again.

Writes routed to a registered data source are the exception: their intent is retained **permanently**
rather than expiring, because letting that record lapse would make a reused key indistinguishable
from old work against your database. A key whose retained intent has expired is rejected with
`idempotency_key_expired` (409) rather than being silently re-executed.

## Route pinning

A key is bound to the route its first attempt took. If an earlier attempt was applied through a
direct data source and a retry arrives when the endpoint fallback is active, Ablo rejects it with
`source_transport_pinned` (409) instead of switching.

That refusal is deliberate: switching routes on a retry risks applying a write that the first route
may already have committed. Restore the original route and retry the same key.

## When to retry

| Situation | Do |
|---|---|
| Timeout or dropped connection, no response | Retry with the **same** key, with backoff. You get the recorded success, or the write runs now. |
| `source_unreachable` (503) | Retry with the **same** key once connectivity recovers. The write stays pinned to its route. |
| `replication_lag_timeout` (504) | The write may have materialized. Retry with the **same** key, or wait for source ingestion to catch up. |
| `AbloStaleContextError` | Re-read the row, regenerate, then write under a **new** key — the new write is a new intention. |
| `AbloClaimedError` | Someone else holds the row. Wait or yield; the key is unused, so reuse it when you retry. |
| `idempotency_conflict` (409) after an identical retry | The original is still in flight. Wait, then retry the **same** key. |
| `idempotency_conflict` (409) after changing the request | A client bug: a key is bound to the first request sent under it. Use a **new** key. |
| `idempotency_key_too_long` (400) | The key exceeds 255 characters. A UUID or a short business string works. |

## Keys

- Up to **255 characters**. Longer is rejected, not truncated.
- Unique per logical operation, identical across every retry of that operation.
- Generate a new one only when a genuinely new operation begins.
- Never put secrets in a key — it is stored and appears in support diagnostics.

## Related

- [Client Behavior](./client-behavior.md) — every write option, and which errors retry.
- [Guarantees](./guarantees.md) — what `queued` and `confirmed` promise.
- [Errors](./errors.md) — the full code registry, including every code named above.
