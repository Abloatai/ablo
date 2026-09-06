# Coordination as Eyes and Ears for Agent Fleets

The design intent behind presence, model events, claims, and stale-context — stated as one
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
- **Awareness is push, and it is the only channel that can storm.** So it must
  stay bounded: durable notifications need coalescing and relevance gates, and
  transient cursor-style producers must throttle their own sends today. Hot
  data that changes every millisecond lives entirely on the safe *pull* side
  and therefore generates zero awareness traffic — an agent that cares about a
  fast-ticking value just tries its write and re-reads if it lost, rather than
  being woken on every tick.

Collapse the two channels — "notify every reader on every change" — and a
millisecond-ticking field produces read → notify → re-read → act → notify →
forever. Keeping them separate is the whole reason that loop can't form.

Awareness has two small surfaces under the same authenticated session and
model scope:

- **Presence** answers who is here and what authoritative read, claim, or write
  activity the session is performing.
- **Events** carry lossy application detail such as cursor coordinates or a
  live selection. They do not reserve anything and are not replayed.

Both humans and agents use the same participant shape. Events add detail to
presence; they do not replace claims or stale-write protection.

## The six behaviors

### 1. Eyes: see who is here and where

Presence projects the human and agent sessions reading or working on a row.
For interfaces, the record-bound React hook owns the read activity lifecycle:

```ts
const viewers = usePresence((ablo) => ablo.chats, chatId);
```

Events add transient location detail without turning it into durable model
state:

```ts
ablo.slideDecks.events.send(deckId, 'cursor', { slideId, x, y });
ablo.files.events.send(fileId, 'selection', { anchor, head });
```

The model namespace supplies the model and row. The server routes only inside
that active record group, excludes the sender, and attaches the authenticated
presence session and participant. This is advisory: it informs and forces
nothing.

Before a participant commits to slow work, claim state shows whether the area
is already taken:

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

## The surfaces, by role

The behaviors compose without merging awareness into safety. A participant
uses only the surface the interaction needs.

| Role | Surface | What it does | Forces anything? |
| --- | --- | --- | --- |
| Awareness | **Presence** | Shows which human and agent sessions are active on a row. | No. |
| Awareness | **Events** | Adds lossy cursor, selection, or similar live detail. | No. |
| Safety | **Stale-context** | Rejects a write built on a read the row has moved past. | Yes, at write time. |
| Safety | **Claim + queue** | Reserves a row across a slow gap; contenders take turns. | Yes, mutual exclusion. |

Most work is a quick write and needs only the safety layer. An agent reaches for
a claim only when it will *hold* a row across a slow gap (read → LLM → write) —
the case where taking a turn beats colliding.

## What's shipped, and what remains open

The shipped awareness path and the remaining notification problem are separate:

1. **Record-scoped presence and events — shipped.** A mounted model record can
   announce read presence and receive human or agent sessions through
   `usePresence`. Its `events` namespace sends lossy cursor, selection, and
   similar signals inside the same record group. The server stamps identity;
   callers do not send `userId`. Events have no reconnect replay, durable
   latest-value state, or per-event `maxHz` policy yet.

2. **Rich work surfaced at reject time — shipped.** A claim carries a single
   `description` (behavior 2) as a first-class field on the wire. It rides the
   presence broadcast, comes back inside the rejection's holder summary
   (`heldByClaim`), and the SDK's `formatClaimedErrorMessage` renders it into the
   `AbloClaimedError`. So "no" already becomes "no, because someone is rewriting
   the risk section" (behavior 4) — the piece that prevents the wasteful blind
   retry works today.

3. **Coalesced, relevance-gated notify — open.** The anti-loop guarantee
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
