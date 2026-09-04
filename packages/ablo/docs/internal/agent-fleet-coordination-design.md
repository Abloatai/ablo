# Coordination as Eyes and Ears for Agent Fleets

The design intent behind claims, presence, and stale-context — stated as one
picture so it can be argued about and built against, not re-derived each time
someone asks "how do the coordination agents work?"

## The thesis

Humans coordinating in a shared document already have everything they need:
they *see* each other's cursors, they *hover* to highlight the region they're
touching, and they *say* what they're doing ("I'm rewriting the intro"). Nobody
overwrites anybody because everybody has eyes and ears.

Agents don't. They work directly and silently, at machine speed, in fleets — say
100 agents across 10 groups, each group on its own area of the data. The
coordination layer's job is to give that fleet the same social awareness a room
of humans has, expressed as a protocol: **see who is working where, learn what
they are doing, and take a turn instead of a collision.**

At fleet scale the load-bearing property is that this stays *local*. The layer
does not lock "the fleet." It coordinates per row. 100 agents over 10
non-overlapping areas are 100 parallel tracks that only ever meet on the
handful of rows two agents genuinely both want. Cost is paid at the overlap, not
across the fleet — which is why adding agents on separate areas adds no
coordination cost.

## The one principle: two channels, never crossed

Awareness and safety are different channels, and keeping them apart is what makes
this safe *and* loop-free at machine speed.

- **Safety is pull, at write time.** An agent acts on its best read and its write
  is rejected if the row moved underneath it. The rejection is the signal, and it
  only ever fires when an agent actually chooses to write. A pull channel cannot
  loop — nothing is being pushed.
- **Awareness is push, and it is the only channel that can storm.** So it is the
  only channel we coalesce and rate-limit. Hot data that changes every
  millisecond lives entirely on the safe *pull* side and therefore generates zero
  awareness traffic — an agent that cares about a fast-ticking value just tries
  its write and re-reads if it lost, rather than being woken on every tick.

Collapse the two channels — "notify every reader on every change" — and a
millisecond-ticking field produces read → notify → re-read → act → notify →
forever. Keeping them separate is the whole reason that loop can't form.

## The six behaviors

### 1. Eyes: see who is working where

Presence broadcasts, live, which agent holds which row. Before an agent commits
to work, it can see the area is already taken. This is advisory: it informs, it
forces nothing.

```ts
const who = ablo.records.claim.state({ id: 'record_123' }); // holder or null
// who.heldBy      === 'agent:forecaster'
// who.description === 'rewriting the risk section to match Q3'
```

### 2. Ears: learn *what* they are doing

A claim carries a single `description` — the machine version of the
hover-highlight plus the spoken "what I'm doing," in one field. It is the
sentence a peer reads to decide whether to wait, work elsewhere, or move on. It
defaults to `'editing'` when a claim is taken without one.

```ts
await using claim = await ablo.records.claim({
  id: 'record_123',
  description: 'rewriting the risk section to match Q3 numbers',
});
```

### 3. Reject *before* the tokens are spent

The claim is a **cheap pre-flight, taken before the generation, not before the
write.** A human wastes nothing by starting to type into a locked paragraph; an
agent wastes a whole expensive completion. So the discipline is:

```txt
claim (cheap)  ->  if granted: generate the block  ->  write
             \->   if held:    never generate anything
```

An agent that is told "no" at the claim never produced the write that would have
lost — the large token spend simply did not happen. This is the single most
important reason the claim exists before the work, not after it.

### 4. Reject *with* the description, so the blocked agent can decide

A bare "taken" forces a blind retry. The rejection carries the holder's
`description`, and the SDK renders it into the `AbloClaimedError` message:
*"Claimed by agent:forecaster: rewriting the risk section to match Q3."* So the
blocked agent reasons on real information: wait for the turn, go work somewhere
else, or drop the record because the work is already being done. "No, because
someone is rewriting the risk section" is actionable in a way "no" is not.

### 5. Queue: take a turn, with an opt-out if the line is long

Contention is a fair FIFO queue: the blocked agent waits its turn and is
*notified* the moment it arrives (push, not poll — it does not sit and spin).
When promoted, it re-reads so it works from the latest, with the previous
holder's change already in place. And the queue has an opt-out: past a depth
bound, an agent is told the area is too busy and moves on rather than joining a
long line.

```ts
await using claim = await ablo.records.claim({
  id: 'record_123',
  description: '...',
  maxQueueDepth: 3, // don't join a line deeper than this
});
```

### 6. Notify on change: without acting on stale data, without looping

An agent that read a row and is about to act on it is stopped if the row moved
since the read; it re-reads instead of acting stale. Where a genuine
notification is wanted, it is **coalesced** (one settled signal, not a stream)
and **relevance-gated** (only the fields a decision depends on can wake the
agent). A fast-ticking value never wakes anyone; a rarely-changing value that
matters can push one settled signal. Same primitive, two behaviors, chosen by
whether reacting is worth it — see the two-channel principle above.

## The three layers, as a rising scale

The behaviors above compose into three layers of increasing firmness. An agent
climbs only as high as the situation needs.

| Layer | Kind | What it does | Forces anything? |
| --- | --- | --- | --- |
| **Presence** | awareness (push) | Shows who holds what, and why, live. | No: informs only. |
| **Stale-context** | safety (pull) | Rejects a write built on a read the row has moved past. | Yes: at write time. |
| **Claim + queue** | reservation (push) | Reserves a row across a slow gap; contenders take turns. | Yes: mutual exclusion. |

Most work is a quick write and needs only the safety layer. An agent reaches for
a claim only when it will *hold* a row across a slow gap (read → LLM → write) —
the case where taking a turn beats colliding.

## What's shipped, and the one open point

One piece of the fleet story that once read as future design work is already
built; one is genuinely still open. Both are called out so neither is misjudged.

1. **Rich work surfaced at reject time — shipped.** A claim carries a single
   `description` (behavior 2) as a first-class field on the wire. It rides the
   presence broadcast, comes back inside the rejection's holder summary
   (`heldByClaim`), and the SDK's `formatClaimedErrorMessage` renders it into the
   `AbloClaimedError`. So "no" already becomes "no, because someone is rewriting
   the risk section" (behavior 4) — the piece that prevents the wasteful blind
   retry works today.

2. **Coalesced, relevance-gated notify — open.** The anti-loop guarantee
   (behavior 6) depends on the awareness channel being coalesced and gated by
   relevance, and on hot data staying on the pull side. This is the sharp one,
   and it is the one not yet built: what exists is the write-time pull guard
   (fixed stale rejection) and operation-level batching, not a coalesced, relevance-gated
   *push* on the presence broadcast. Get it wrong and a millisecond-ticking field
   storms the fleet. The rule to hold: an agent is *rejected at write time* on
   hot data, never *subscribed-and-woken* by it.

## Coordination performance ledger

The fast staging rung is fixed at 20 HTTP agents, three lifecycles per agent,
and four shared rows. A lifecycle is claim → protected write → release. Change
the workload shape and it is a new benchmark, not a faster result.

The first correct baseline is staging run `aws-20260904133532-9219` on
2026-09-04: 60 of 60 lifecycles completed, with zero unexpected errors and zero
mutual-exclusion violations. Lifecycle throughput was 0.310/s. Claim
p50/p95/p99 was 18.1/90.5/103.7s, protected-write p50/p95/p99 was
1.97/20.4/22.3s, release p50/p95/p99 was 0.07/1.26/2.02s, and whole-lifecycle
p50/p95/p99 was 25.6/92.8/103.8s. This closes the correctness gate and becomes
the denominator-preserving speed baseline; it does not meet the first speed
goal.

For comparison, the last run before claim continuation received established
admission priority completed only 58 of 60 at 0.262/s and had release p95
20.2s. Preserving admitted lifecycle traffic cut release p95 by about 94% and
the correct baseline holds that gain, but queue acquisition and protected-write
tail latency still dominate.

Performance work advances through ordered gates:

1. **Correct baseline:** 60/60 lifecycles, zero mutual-exclusion violations,
   zero unexpected errors, and natural process exit. Speed claims start here.
2. **First speed goal:** at least 1.0 completed lifecycle/s, protected-write
   p95 at most 3s, release p95 at most 1s, and lifecycle p95 at most 45s.
3. **Stretch goal:** at least 2.0 completed lifecycles/s and lifecycle p95 at
   most 20s, with the same correctness and drain gates.

Every accepted result records the runner source release, serving image digest,
agent/operation/shared-row counts, completed denominator, every phase
percentile, lifecycle throughput, unexpected errors, and drain duration. This
keeps “faster” tied to the same correct work rather than to abandoned waiters.

## Related

- [`coordination.md`](../coordination.md) — the public claim/queue/stale-context
  reference this note motivates.
- [`agent-orchestration.md`](./agent-orchestration.md) — parent/child agent work
  modeled through claimed job rows; this note is the coordination substrate under
  it.
- ADR 0009 (`docs/decisions/0009-claim-durability-two-reclaim-clocks.md`) — what a
  claim survives when a holder vanishes, and why liveness can be best-effort while
  correctness is fenced at commit.
