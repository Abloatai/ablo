# Concurrency Convention

> The governing convention for how Ablo resolves concurrent writes to shared
> state, and the boundaries of that convention. This is the contract; the
> three-layer mechanics live in [`coordination.md`](./coordination.md).

---

## 1. The principle: non-coercion

**The engine surfaces the truthful current state and lets the intelligent actor —
agent or human — decide what to do. It does not force a resolution.**

That is the whole convention. Everything below is a consequence of it.

Classical concurrency control is *coercive*: it imposes the remedy. Two-phase
locking forces a block; optimistic concurrency forces an abort. Ablo's wager is
that the actor in the loop (an agent reasoning over the change, or a human
watching the row) is better placed to resolve a conflict than a fixed rule baked
into the storage layer. So the engine's job narrows to one thing: **report what
is true, on time, and get out of the way.**

There are two forms of non-coercion, and they are the same principle at two
moments in time:

| form | when | mechanism |
|---|---|---|
| **Claim** | *prospective* — before you act | reserve the row; others queue. Coordinate so the conflict never forms. |
| **Notification** | *in-flight* — after a concurrent change | surface the changed value; the actor resolves and re-issues. |

Use a claim when you will hold the row across a slow read→reason→write gap. Use a
notification when you didn't, and the premise moved under you.

---

## 2. The dispositions (`onStale`)

Every guarded write (and every read dependency, §4) declares how a stale premise
should be handled. Three modes, split by whether they **force** an outcome:

| mode | coercive? | what the engine does | who resolves | use when |
|---|---|---|---|---|
| `notify` | **No** — surface + delegate | Holds the write (does **not** apply it); returns a `StaleNotification` with the current value. | The actor (agent or human) reconciles and re-issues. | The aligned mode: tell the actor what changed, let it solve. |
| `reject` | **Yes** — force-abort | Throws `AbloStaleContextError`; the batch is discarded. | The caller retries from scratch. | Hard invariants; legacy/strict callers. The current default. |
| `overwrite` | **Yes** — force-clobber | Overwrites blindly last-writer-wins; **no** signal. | Nobody. | You genuinely own the field and concurrent values are noise. |

> `notify` is the convention. `reject` and `overwrite` are escape hatches for the
> two ends — "never let this be wrong" and "never bother me." They are not the
> spirit; they are the boundary of it.

---

## 3. What is checked: two footprints

A conflict is a **footprint intersection** — your operation's footprint overlaps
a concurrent delta. Ablo checks two footprints, and they are independent:

| footprint | declared by | question | scope |
|---|---|---|---|
| **Write-target** | per-op `readAt` | "did a row I'm **writing** change since I read it?" | the rows in `operations[]` |
| **Read-set** | batch-level `reads[]` | "did anything I **looked at** change since I read it?" | rows/groups in `reads[]`, even if not written |

The write-target check alone is the narrow case the canary anomaly defeats: an
agent reads `deal.stage`, writes `task.status`, and a peer moves `deal.stage` —
`task` never changed, so a write-target-only check waves it through. The read-set
closes that gap.

---

## 4. The read-set (`reads[]`)

A commit may declare, at the batch level, the premises its writes depended on.
Two granularities, developer's choice per entry:

```ts
reads: [
  { model: 'Slide', id: 's-1', readAt: N, fields?: ['title'] }, // ROW premise
  { group: 'deck:abc', readAt: N, onStale: 'notify' },          // GROUP premise
]
```

- **Row** — did this specific row (optionally these fields) change? The literal
  per-object premise.
- **Group** — did *anything* in this sync group change? `group` is a sync-group
  key (`deck:abc`, `slide:s1`, `org:X`) — the same unit a participant **watches
  and claims**. This is the more Ablo-native granularity.

**Boundary — a stale read fires over the whole batch.** A read dependency is a
premise for *all* the writes in the commit, so its disposition governs the batch:
`reject` aborts it, `notify` holds **every** write and notifies, `overwrite`
lets them land. Per-entry `onStale` defaults to `reject`.

---

## 5. The notification (`StaleNotification`)

The non-coercive modes hand back data instead of throwing. The signal is
delivered **twice**, by design — once as a value, once as an event:

- On the **commit receipt**: `receipt.notifications` (and `CommitResult.notifications`).
- On the **event channel**: `conflict:notified` (mirrors `reconciliation:needed` /
  `sync:rollback`).

Shape (canonical in `coordination/schema.ts`):

| field | meaning |
|---|---|
| `object` | Stripe-style type tag — `'stale_notification'` |
| `model`, `id` | the conflicting row (for a group dep, both are the group key) |
| `group?` | set when this is a group-scoped notification |
| `readAt` | the watermark the committer reasoned against |
| `observedSyncId` | the newest delta on the premise — re-read at/after this |
| `conflictingFields` | fields that moved (empty for group / whole-entity) |
| `currentValues` | the live values of those fields — the premise to reconcile against (empty for group) |
| `writtenBy` | `{ kind, id }` of the concurrent author, reported faithfully |

Only `notify` produces a notification (the write was held). `reject` throws and
`overwrite` is silent — neither notifies.

### 5.1 The receive → reconcile loop

You receive the signal two ways (same payload), then re-commit against the fresh
watermark. The engine never re-issues for you — the actor decides.

```ts
// Trigger: a guarded write under the non-coercive mode.
const receipt = await ablo.task.update({
  id, data: { status: 'blocked' },
  readAt: myWatermark,
  onStale: 'notify',
});

// Receive — pull: the held write surfaces on the receipt.
for (const n of receipt.notifications ?? []) reconcile(n);

// Receive — push: the same StaleNotification[] fires ambiently on the socket.
ws.subscribe('conflict:notified', ({ notifications }) => notifications.forEach(reconcile));

function reconcile(n: StaleNotification) {
  // n.currentValues — what's actually there now (e.g. { status: 'done' })
  // n.writtenBy     — who moved it (e.g. { kind: 'agent', id: 'agent-b' })
  if (!stillValid(n.currentValues)) return;       // premise gone → drop the write

  return ablo.task.update({
    id: n.id,
    data: { status: 'blocked' },
    readAt: n.observedSyncId,   // adopt the new high-water mark — this is what terminates the loop
    onStale: 'notify',
  });
}
```

The loop **terminates** because each retry advances `readAt` to `observedSyncId`;
a peer that keeps writing only ever notifies you against a *newer* baseline, never
the same one twice. A group read-dep reconciles identically, except `group` is set
and `currentValues` is empty (re-read the group).

---

## 6. Boundaries & invariants

What the convention **guarantees**, and where it **stops**:

1. **Engine surfaces, actor decides.** For `flag`/`merge` the engine never
   repairs, merges, or re-plans. It reports `currentValues` and the actor (agent
   or human) owns the resolution. The engine does not distinguish them — it is
   actor-neutral by design.

2. **Truthfulness.** `currentValues` / `observedSyncId` reflect committed state at
   detection time, inside the same transaction as the write. A notification is
   never speculative.

3. **Termination (no livelock).** The monotonic `sync_id` landing order is the
   serialization order. The stale committer always yields/recomputes — an
   asymmetry that rules out the symmetric notify-rewrite livelock. Unbounded
   retry is bounded by the client's reconciliation retry cap.

4. **Scope: reversible DB state only.** The convention governs writes to the
   shared database, which are inherently reversible (prior value in
   `sync_deltas`). **Irreversible external side-effects** (emails, payments,
   third-party calls) are *out of scope* — the engine cannot hold or undo them,
   so they must not be gated by `flag`/`merge`.

5. **Defaults.** A plain write (no `readAt`) is last-writer-wins with **no**
   check. A guarded write with `readAt` but no `onStale` defaults to `reject`
   (back-compat). *Open decision (§7).*

6. **Policy seam.** Custom `ConflictPolicy` functions see **write-target**
   conflicts (`stale_context` / `claim_held`). **Read-set** conflicts are
   currently resolved directly via each entry's `onStale`, not through the policy
   seam. *Open decision (§7).*

7. **Claims win when held.** A non-holder writing to a claimed row is rejected
   (`AbloClaimedError`) regardless of `readAt` — the prospective form takes
   precedence over the in-flight form. Only `user`/`system` principals may
   `bypass` a foreign claim; agents may not.

---

## 7. Open decisions (bounded, not yet made)

These are deliberately left open; they change behavior and are the user's call.

- **Default disposition for agents.** Should an agent-participant guarded write
  default to `flag` (philosophy-aligned: surface, don't force) instead of
  `reject` (back-compat)? Trade-off: alignment vs. a behavior change for existing
  agent callers.
- **Read-deps through the policy seam.** Should read-set conflicts also pass
  through `ConflictPolicy` (requires a group-aware conflict shape), or stay on
  the direct `onStale` mapping?

---

## 8. Out of scope

- Irreversible external side-effects (§6.4) — not gated by this convention.
- Cross-object *serializability proof*. The read-set is a sound premise check,
  not a full precedence-graph guarantee; it needs declared reads to catch a
  premise, and a caller that declares none gets only write-target checking.
- Identity → participant-kind mapping. `writtenBy.kind` reports whatever
  authenticated (an `sk_` key resolves to `system`, not `agent`); how identities
  map to kinds is a separate concern.
