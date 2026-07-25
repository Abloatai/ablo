# Commit identifiers: the two axes

Maintainer reference. A commit carries several ids, and they are easy to
conflate because they travel together and are all "some number attached to a
write." They are not interchangeable. Each answers a different question, and
they split cleanly along **one line**: does this id help decide whether the
write *wins*, or does it only help *identify* the write after the fact?

Keeping the two axes separate is what lets each id be reasoned about — and
audited — on its own. This doc is the single place they sit side by side.

## The line

| axis | the question it answers | when it acts | if it's absent |
|---|---|---|---|
| **Conflict resolution** | *should this write land, given what else happened?* | at the commit chokepoint, before the row is written | the write is unguarded (last-writer-wins) |
| **Correlation / audit** | *which write is this, and have I seen it before?* | on receipt (dedup) and after the fact (attribution) | the write still lands; you just can't dedup or trace it as precisely |

A conflict-resolution id can **reject** a commit. A correlation id never does —
at most it makes a retried commit a no-op (idempotency). Never reach for one to
do the other's job: a correlation id can't fence a stale write, and a fence
can't dedup a retry.

## Axis 1: conflict resolution (does this write win?)

Evaluated inside `executeCommit`'s transaction, atomic with the delta write.
Three independent fences, each catching what the others can't; the full
narrative is [ADR 0009 §6](../../../../docs/decisions/0009-claim-durability-two-reclaim-clocks.md)
and the [coordination reference](../coordination.md).

| id | wire field | persisted to | what it asserts | rejects when |
|---|---|---|---|---|
| **read basis** | per-op `readAt` | `sync_deltas.read_at_sync_id` | "the state I reasoned **from**": a version watermark | the row moved since `readAt` (version-CAS), under `onStale: 'reject'` |
| **fencing token** | per-op `fenceToken` | `sync_deltas.fence_token` **and** `claim_fence_watermark.fence_token` | "the lease generation I was authorized **at**": a monotonic per-entity high-water | the token is below the entity's persisted high-water: a lapsed holder writing after its successor already claimed, wrote, and released |
| **claim / lease** | `claimId`, `heldBy` on the `WireClaim` | the coordination store (Redis), not `sync_deltas` | "I hold this row right now": live mutual exclusion | a non-holder writes a row another participant holds |

`onStale` (`notify` / `reject` / `overwrite`) is **not** an id — it's the
disposition that decides what a stale `readAt` *does*. It rides with the read
basis but is policy, not evidence, so it isn't persisted.

Why the token is a distinct id from `readAt`, and not just reused `sync_id`:
`readAt` advances on every **write** and asserts *from what data*; the token
advances on every **grant** and asserts *at what lease generation*. Their events
differ, so one can't stand in for the other — a lapsed holder that skips
version-CAS (no `readAt`, a blind write) is invisible to the read basis but
still carries a stale token. That is precisely fence (c) closing what (a) can't.
The reasoning in full lives in
[the fencing-token scope doc](../../../../docs/plans/claim-fencing-token-option-b-scope.md).

## Axis 2: correlation / audit (which write is this?)

Never decides a conflict. These are how a write is recognized — as a duplicate,
as your own echo, or as one row in a signed history.

| id | wire field | persisted to | purpose |
|---|---|---|---|
| **idempotency key** | batch `clientTxId` (public alias `idempotencyKey`) | dedup ledger keyed by it | a retried batch commits **once**: the second attempt is recognized and folded to a no-op, not re-applied |
| **per-op transaction id** | per-op `transactionId` | `sync_deltas.transaction_id` | echo detection: the broadcast delta arrives at the originating client carrying the **same** id its queue marked pending, so it reconciles its optimistic write instead of double-applying |
| **sync id** | assigned server-side (`next_sync_id`) | `sync_deltas.id` | the monotonic total order: the serialization order every reader tails and every `readAt` names. It is *assigned*, never client-supplied |
| **attribution** | actor / capability / delegation on the frame | `sync_deltas` actor columns + the signed audit chain | who acted, on whose behalf, under which key: the [audit log](../audit.md)'s who/when |

The batch key and the per-op id are deliberately separate: a multi-row commit is
**one** idempotent unit (one `clientTxId`) made of **many** individually-echoable
ops (each its own `transactionId`). Collapsing them would make echo detection
batch-coarse and break optimistic reconciliation for multi-op commits.

## The evidence tuple on a `sync_deltas` row

Both axes leave their mark on the delta, which is what makes a delta a complete,
self-describing audit record — you can reconstruct the full justification of a
write from the row alone, never from a live lease that has since vanished:

- **who:** `actor_id` / `capability_id` (+ the signed chain)
- **what:** `data` / `previous_data`
- **when:** `id` (`sync_id`) / `created_at`
- **from what known state:** `read_at_sync_id` (the read basis)
- **at what lease generation:** `fence_token` (the token the commit fenced)
- **as which client operation:** `transaction_id` (echo identity)

`read_at_sync_id` and `fence_token` are companions: the first records the data
version the write reasoned against, the second the lease generation it was
authorized at. Both are `NULL` when the write carried none (an unclaimed write, a
human `user` committer exempt under Law 7, or a legacy row) — **never fabricated
server-side**. The evidence derives only from what the write actually presented,
so the audit row can't drift from what the fence enforced.

## One-line test for "which id is this?"

> If removing it could turn an accepted commit into a rejected one, it's
> **Axis 1**. If removing it only costs you dedup, echo reconciliation, or
> traceability — while the write still lands — it's **Axis 2**.
