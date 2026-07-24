# Change Propagation

> How one row's change reaches the rows and actors that depend on it.

> How a change to one row reaches the rows and actors that depend on it, and how
> to keep a chain of dependent work fresh. This is the propagation half of sync
> groups; [`identity.md`](./identity.md) is the access half (who may read a
> group), and [`concurrency-convention.md`](./concurrency-convention.md) is the
> convention this rests on.

---

## Start from the problem

An agent reads workspace `A` to write document `B`. A moment later it reads `B` to write
block `C`. Between those steps someone else edits `A`. The agent is now building
`C` on a premise that has moved — and nothing about writing `C` looks wrong in
isolation. That is stale context, and it is the thing sync groups let you catch.

The recipe is one field on the commit: declare the group you read as a premise,
and say what should happen if it moved.

```ts
// The agent read everything under workspace:abc to compose this write.
await ablo.blocks.update({
  id: 'block-C',
  data: { text: revised },
  reads: [{ group: 'workspace:abc', readAt: watermark, onStale: 'notify' }],
});
```

At commit, inside the write transaction, the engine asks a single question: *did
any delta routed to `workspace:abc` land after `watermark`?* If nothing moved, the
write applies. If something moved, `onStale` decides — `notify` holds the write
and hands the agent a `StaleNotification` naming the group, so it re-reads
`workspace:abc` and regenerates; `reject` aborts the batch with a `409`. The agent
never persists work built on a premise it can no longer see.

---

## How you hear about it

Four channels carry "something changed", and they answer four different
questions. Pick by the question you have.

```ts
// A screen that stays current.
ablo.documents.onChange((docs) => render(docs));

// Who else is in here, and what are they holding.
await using room = await ablo.documents.join(documentIds, { ttl: '5m' });
room.peers;

// Stop this write if the thing I read moved while I composed it.
await ablo.blocks.update({ id, data, reads: [{ group: 'workspace:abc', readAt, onStale: 'notify' }] });

// Tell me later if this moves, even though I am not writing now.
await ablo.documents.track({ id: 's-1' });
```

| Question | Channel | Arrives |
| --- | --- | --- |
| What do the rows say right now? | `onChange` | As deltas land, on the socket |
| Who else is working here? | `join`, then `room.peers` and `room.claims` | As participants come and go, on the socket |
| Did the premise for **this** write move? | `reads` on the write | On that write's receipt, before it applies |
| Has anything I read moved since? | `track` | On your next commit's receipt |

Two distinctions do most of the work here.

**`join` is about people; `track` is about data.** Both open a subscription and
both are scoped by sync group, which is why they look alike. `join` reports
participants: who is present, what they are doing, which rows they hold. `track`
reports the rows themselves: something you said you cared about moved, here is
the watermark to re-read it at. A tool that wants to avoid duplicating a peer's
work needs `join`. A tool whose output goes stale when its inputs change needs
`track`.

**`reads` guards one write; `track` outlives it.** They speak the same
vocabulary and produce the same `StaleNotification`. A `reads` entry is checked
once, at the commit that carried it, and discarded. A `track` is persisted and
re-checked against every delta after it, so a long-running actor hears about a
change that landed while it was thinking, on the next commit it makes.

`onChange` and `join` need a live socket, so they are available on the default
WebSocket client. `reads` and `track` ride the commit, so they reach a socketless
actor over HTTP too, which is what makes them the notification path for agents
and workers.

---

## Three ways a change reaches other rows

"A affects B and C" means three different things. The engine does the first two
for you and leaves the third to you — on purpose.

**Routing — who hears about a change.** Every row belongs to one or more sync
groups, and a write fans out to all of them. A row also inherits its ancestors'
groups: editing a block stamps the delta with `block:…`, `document:…`, *and*
`workspace:…`, so everyone watching the workspace sees the block move. This is delivery,
resolved by walking the ownership tree at commit time. It routes the change; it
never recomputes a value.

**Structural cascade — what disappears with a change.** Deleting a workspace removes
its documents and blocks. The database does that through `ON DELETE CASCADE`, but a
database-level cascade emits no delta, so open clients would quietly hold rows
that no longer exist. The engine closes that gap: before the delete it snapshots
the subtree and emits a tombstone for each descendant, routed to the right
group. Watchers see the whole subtree vanish.

**Value recomputation — what a change implies for derived state.** If `B` holds a
number rolled up from `A`, the engine does not recompute `B` when `A` changes. It
surfaces that `A` moved and lets the actor decide what `B` should become. This is
the non-coercion principle: coordinate and report, resolve nothing by fiat.
Merging derived state is a judgment call, and for an agent in the loop that
judgment is the whole point.

---

## The chain: A → B → C

Model a dependency as shared group membership. Put `A` and `B` in one group, `B`
and `C` in another, and you have wired the edges of a chain. What travels along
those edges is a *signal*, one hop at a time — not a recomputation.

```
A writes ──▶ group {A,B} ──▶ B hears it
                                  │  B decides, B writes
                                  ▼
                             group {B,C} ──▶ C hears it
```

A's delta lands in `{A,B}` and stops there. `C` is not in that group, so `C`
learns nothing from A directly. `C` advances only when **B itself writes** and
that new delta lands in `{B,C}`. `B` is the translator: it takes "A moved,"
decides what that means for its own state, commits, and *its* commit is what
reaches `C`.

The direction matters. The signal flows forward, A to B to C, and each hop is a
real write an actor chose to make. The engine supplies the edges (group
membership) and a stale signal on each edge (the premise check); the actors are
the runtime that walks them. It is closer to a spreadsheet an analyst
recalculates cell by cell than to a reactive engine that recomputes the whole
column for you.

Two consequences worth designing around:

- **The chain runs as fast as actors react.** If `B` never acts on its signal,
  the chain stops at `B` and `C` stays as it was. Freshness is an actor
  responsibility; the engine guarantees the signal, not the follow-through.
- **Cycles don't settle themselves.** If `C` writes back to `A`, each hop is a
  separate commit with its own stale check, and nothing damps the oscillation.
  Keep the dependency graph acyclic, or give one actor the job of reaching a
  fixpoint. Convergence lives above the engine.

---

## Declaring the batch premise

`reads[]` declares what the commit was based on. Each entry is a premise, and
each governs the *whole* commit: if one goes stale, its disposition applies to
every write in the batch, not just one operation. You choose the granularity per
entry.

```ts
reads: [
  { group: 'workspace:abc', readAt: N, onStale: 'notify' },      // did anything in the workspace move?
  { model: 'Document', id: 's-1', readAt: N, fields: ['title'] }, // did this row (this field) move?
]
```

A **group** premise asks "did anything I was watching change?" — the native
Ablo granularity, and the right tool for the chain above. A **row** premise is
literal: this object, optionally these fields. A row premise with `fields`
conflicts only on real field overlap, so two actors editing disjoint fields of
the same row don't collide.

`onStale` has three settings, defaulting to `reject`:

- **`notify`** holds every write in the batch and returns a `StaleNotification`.
  For a group premise it carries the group name and the new watermark
  (`observedSyncId`); re-read the group at that point and regenerate. This is the
  setting a chain wants — the actor gets the truth and resolves it.
- **`reject`** aborts the batch with a `stale_context` error (`409`). The right
  default when there is nothing to reconcile and the write should simply not
  land.
- **`overwrite`** skips the check and lets the write land — last-write-wins, the
  explicit escape hatch.

---

## Staying subscribed across commits: `track`

A batch premise guards a single commit: you state what you read, the engine
checks it, the premise is gone. That fits an actor that reads and writes in one
breath. It does not fit a long-running one — an agent that reads a row now,
works for a few minutes, and writes much later. By the time it commits, the
premise it would have declared is stale, and there was no commit in between on
which to hear that the ground had shifted.

`track` is the durable half of the same idea. Register what you are watching and
it persists on the server; the next time you commit anything, a change that
landed on the tracked target since you registered rides back on your receipt —
the same `StaleNotification` an `onStale: 'notify'` premise would have handed
you, arriving on the write you were going to make anyway.

```ts
// Register interest and walk away — no write required.
await ablo.documents.track({ id: 's-1' });

// …minutes of other work later, on your next commit…
const res = await ablo.blocks.update({ id: 'block-C', data: { text: revised } });
res.notifications; // populated if s-1 moved under you in the meantime
```

The target is a row (`{ id }` on the model verb) or a sync group (as a write
option, below). A track is an idempotent registration: calling it again refreshes
the same subscription rather than stacking duplicates, and once a change fires the
track re-baselines, so the same change notifies once. Your own writes to a target
you track never notify you — the signal is about what *others* did.

You can also register a track as part of a write you are already making, the
persisted companion to `reads`:

```ts
await ablo.documents.update({
  id: 's-1',
  data: { title: revised },
  reads: [{ group: 'workspace:abc', readAt: N, onStale: 'notify' }], // guards THIS commit
  track: [{ group: 'workspace:abc' }],                               // and keeps watching after it
});
```

So `reads` is the premise for the commit in hand; `track` is a standing
subscription that outlives it. Both speak the same notification vocabulary, and
both leave the resolution to you — the engine reports that the target moved and
lets the actor decide what that means. Delivery is on your next commit's receipt;
a track does not yet push out of band between commits.

---

## Sizing groups

A group is the unit of both delivery and staleness, so its size is a real
tradeoff. A change fans out to every subscriber of every group it touches, and a
group premise fires when *anything* in the group moves — so a group that is too
broad wakes actors for changes they don't care about, and one that is too narrow
misses the dependency you meant to track.

The rule of thumb: **make a group the smallest set of rows that must stay
mutually consistent.** A workspace and its documents belong together because editing one
changes what the others mean; two unrelated workspaces do not. Reach for finer,
overlapping groups when you genuinely have a dependency chain to track, and keep
them coarse everywhere else.

---

## Where this is defined

- **Access**, meaning who may read or write a group, is
  [`identity.md`](./identity.md).
- **The convention** behind non-coercion, the premise, and the notification is
  [`concurrency-convention.md`](./concurrency-convention.md) (§4 and §5).
- **The mechanics**, the three coordination blocks underneath, are
  [`coordination.md`](./coordination.md).
- **`join` and presence**, the participant half of the table above, are
  [`coordination.md`](./coordination.md) for the claim stream and
  [`react.md`](./react.md) for `useJoin`.
