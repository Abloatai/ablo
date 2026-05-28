# Coordination Reference

Coordinate long-running work on a row so humans and agents don't clobber each
other. Most writes need none of this — `ablo.<model>.update(id, …)` is optimistic
and the server rejects it if the row moved. Reach for `claim` only when you'll
**hold a row across a slow gap** (read → LLM call → write).

Claims are **fair**: on contention a second claimer joins a **server-side FIFO
queue** and blocks until promoted to the head of the line — it does not fail and
does not poll. Reads are open by default; reading a claimed row is allowed unless
the caller explicitly asks for claimed gating. A claim carries a TTL so a crashed
holder is auto-released and the queue advances.

This reference opens with [the model](#the-model--three-layers-one-decision) — the
one answer to "how do two agents not clobber each other" — then covers the
[claim state object](#the-claim-state-object), the SDK [methods](#methods)
(`claim` · `claimState` · `queue` · `release` · [writing under a
claim](#writing-under-a-claim)), and the [errors](#errors) you can catch.

---

## The model — three layers, one decision

Ablo has exactly **three** coordination layers. They are **not** three competing
answers to the same question — they stack, and only one of them is a decision you
make:

| layer | kind | what it does | enforces? |
|---|---|---|---|
| **Presence** (`claimState`, observers) | observation | Broadcasts who is working where, live. Renders cursors / "agent X is editing." | **No.** Advisory only — it never blocks or rejects a write. |
| **Claim** (`claim`/`queue`/`release`) | pessimistic | Reserves a row for one participant. Foreign writers are rejected server-side; contenders join a fair FIFO queue. | **Yes**, between participants — mutual exclusion. |
| **Stale-context** (`readAt` + `onStale`) | optimistic (LWW) | On commit, rejects a write whose snapshot is older than the row's latest delta. Last-writer-wins detection. | **Yes**, against time — lost-update detection. |

**The one decision: do you hold the row across a slow gap (read → LLM call →
write)?**

- **No** (the common case — a single quick `update`): do nothing. `ablo.<model>.update`
  is optimistically guarded by stale-context already; it rejects with
  `AbloStaleContextError` if the row moved under you. This is the default and
  needs no ceremony.
- **Yes** (you'll reason for seconds while holding the row): `claim` it. The claim
  excludes other participants for the duration, queues contenders fairly, and —
  see below — your own writes under it stay stale-guarded too.

**How they compose (what wins):**

1. **Claim supersedes stale-context for *foreign* writers.** A non-holder writing
   to a claimed row is rejected by the claim guard (`AbloClaimedError`,
   `claim_conflict`/`entity_claimed`) *before* any watermark check — `readAt` is
   irrelevant when you don't hold the lease. Pessimistic exclusion is the outer
   gate.
2. **Stale-context is the always-on backstop for *unclaimed* writes.** No claim
   held → the watermark check is the only protection, and it's automatic. This is
   why the no-claim path is safe by default.
3. **Inside a claim, both apply.** A claim is not a license to clobber yourself:
   writes under a held claim carry the claim's snapshot as `readAt` with
   `onStale: 'reject'` (see [Writing under a claim](#writing-under-a-claim)), so a
   `bypass` write or a row that moved between snapshot and write still rejects.
   Claim = "no one else"; stale-context = "and not against a moved snapshot."
4. **Presence never decides.** It is the visualization of (1)–(3), not a fourth
   gate. Never branch enforcement logic on `claimState` — read it to render, act
   on the errors above.

Claims and stale-context are **orthogonal by construction**, not wired into each
other on the server: the claim guard runs pre-transaction; the watermark check
runs inside it. The SDK attaches `readAt`/`onStale` for you when writing under a
claim — that coupling lives in the SDK, deliberately, so the server's two checks
stay independent and individually testable.

---

## The claim state object

The claim state object is the live record that a participant is coordinating work on
a model row. It's what `claimState()` returns and what observers render.

| field | type | description |
|---|---|---|
| `id` | `string` | The claim id (distinct from the target row id). |
| `status` | `ClaimStatus` | `'active' \| 'queued' \| 'committed' \| 'expired' \| 'canceled'`. `active` = the holder; `queued` = waiting in line behind it. |
| `target` | `EntityRef` | What is being coordinated (`{ model, id, field? }`). |
| `action` | `string` | Human-readable phase — `'editing'`, `'writing'`, `'reviewing'`. |
| `heldBy` | `string` | Participant holding (or waiting on) it (e.g. `'agent:forecaster'`). |
| `participantKind` | `'human' \| 'agent'` | Who's behind it. |
| `position` | `number?` | 0-based place in the FIFO line — present only when `status: 'queued'` (`0` = next behind the holder). |
| `createdAt` | `string?` | Ms-epoch the holder opened it. Optional — derived shapes may omit it. |
| `expiresAt` | `string` | Ms-epoch the server reclaims it if the holder goes **silent**. Renewed automatically while the holder's connection stays alive — a crash-cleanup floor, not a duration you size. |

```jsonc
{
  "id": "claim_8fJ2",
  "status": "active",
  "target": { "model": "weatherReports", "id": "report_stockholm" },
  "action": "editing",
  "heldBy": "agent:forecaster",
  "participantKind": "agent",
  "createdAt": "1748160000000",
  "expiresAt": "1748160030000"
}
```

---

## Methods

Each method below follows one fixed shape: **signature · what it does ·
parameters · returns · example**.

### `claim`

```ts
ablo.<model>.claim(id, work, options?): Promise<R>   // callback form
ablo.<model>.claim(id, options?): Promise<ClaimedRow<T>>
```

Claim a row so other writers serialize behind you until you're done; reads stay
open by default. The claim acquires through the server's fair FIFO queue: if the
target is free the lease is yours immediately, and if another participant holds
it your claim **waits in line** and resolves only once it reaches the head —
then re-reads so the claimed snapshot reflects what the previous holder
committed. There's no client-side poll and no TOCTOU gap: the server orders
contenders.

**Parameters**

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id — same id as `retrieve` / `update`. |
| `options.action` | `string` | no | Phase shown to observers (default `'editing'`). |
| `options.field` | `string` | no | Field-level target, for fine-grained claimed-state badges. |
| `options.wait` | `boolean` | no | `true` (default) queues and waits for the lease. `false` is fail-fast — if another participant holds the row, reject immediately with `AbloClaimedError('entity_claimed')` instead of queuing (claim-or-skip, for work dedup where waiting would double-process). |
| `options.maxQueueDepth` | `number` | no | Backpressure: reject with `AbloClaimedError('queue_too_deep')` instead of joining a line already `>= maxQueueDepth` deep. Omit to wait however deep the queue is. |
| `options.ttl` | `Duration` | no | Crash-cleanup floor. Rarely set — the lease renews while your connection is alive, so it only matters once you go silent. |
| `work` | `(row) => …` | no | Callback form: hold the claim for the callback, release when it returns. |

The high-level `claim` queues by default, so on contention you either get the row
when your turn arrives or one of the [queue errors](#errors) (`claim_lost`,
`grant_timeout`).

**Returns** — with the callback form, returns whatever `work` returns and
releases after the callback returns or throws. The manual form returns the
claimed row (`ClaimedRow<T> = T & AsyncDisposable`): the row data plus a
release hook for manual scopes.

**Example**

```ts
const forecast = await ablo.weatherReports.claim('report_stockholm', async (report) => {
  const weather = await weatherAgent.getWeather(report.location);
  await ablo.weatherReports.update(report.id, { forecast: weather });
  return weather;
});
```

The manual scoped form is still available for wider TS 5.2+ scopes, but ordinary
held work should use the callback form above.

### Claim-gated reads

`claimState(id)` always returns immediately. Model reads such as
`ablo.<model>.retrieve(id)` are local reads and stay available while a claim is
held. Server/model reads can choose a claimed policy:

```ts
await ablo.model('weatherReports').retrieve('report_stockholm', {
  ifClaimed: 'wait',
  claimedTimeout: 30_000,
});
```

- `ifClaimed: 'return'` reads now and includes active work metadata.
- `ifClaimed: 'wait'` waits for the active claim to clear before reading.
- `ifClaimed: 'fail'` throws `AbloClaimedError` if the row is claimed.

### `claimState`

```ts
ablo.<model>.claimState(id)
```

Read who's currently working on a row, for observers and UI. Synchronous and
reactive (it reads the local coordination snapshot). Never blocks.

**Parameters**

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id. |

**Returns** — the active [claim state object](#the-claim-state-object), or `null` when the row
is free.

**Example**

```ts
const who = ablo.weatherReports.claimState('report_stockholm');
if (who) console.log(`${who.heldBy} is ${who.action}`);
```

Returns the active claim state when the row is held, or `null` when it's free:

```jsonc
{
  "id": "claim_8fJ2",
  "status": "active",
  "target": { "model": "weatherReports", "id": "report_stockholm" },
  "action": "editing",
  "heldBy": "agent:forecaster",
  "participantKind": "agent",
  "expiresAt": "1748160030000"
}
```

### `queue`

```ts
ablo.<model>.queue(id)
```

Read the **wait line** behind a row — the FIFO of claims queued behind the
current holder, in promotion order. Like `claimState`, it's synchronous and
reactive (it reads the local coordination snapshot, kept current by the server's
queue-mutation frames), and reading never blocks. Where `claimState` answers "who
holds it," `queue` answers "who's lined up next" — render "3rd in line", or
decide the wait isn't worth it.

**Parameters**

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id. |

**Returns** — a list envelope. `data` contains the queued
[claim state objects](#the-claim-state-object) in promotion order (head first), excluding
the active holder; `[]` when no one is waiting.

**Example**

```ts
const { data: waiting } = ablo.weatherReports.queue('report_stockholm');
console.log(`${waiting.length} ahead of you`);
console.log(waiting.map((i) => i.heldBy));
```

### `release`

```ts
ablo.<model>.release(id): Promise<void>
```

Release a claim you hold. Usually **implicit** — the callback returning releases
for you, and TTL cleans up a crashed holder.
Call this only to give a manually held claim back early (claimed, then decided
not to write).
Releasing **promotes the head of the queue**: the next waiter receives the claim.

**Parameters**

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id you hold a claim on. No-op if you don't hold it. |

**Returns** — resolves once the claim is released.

**Example**

```ts
const report = await ablo.weatherReports.claim('report_stockholm', { action: 'reviewing' });
try {
  const ok = await reviewExternally(report);
  if (!ok) return; // abandon, no write
  await ablo.weatherReports.update(report.id, { status: 'ready' });
} finally {
  await ablo.weatherReports.release(report.id);
}
```

### Writing under a claim

There is no separate "write" method on a claim — use the normal flat
`ablo.<model>.update(id, data)`. While you hold a claim on `id`, that `update` is
automatically stale-guarded against the snapshot the claim took (`readAt` =
snapshot watermark, `onStale: 'reject'`) and attributed to the claim's lease, so
it rejects with [`AbloStaleContextError`](#errors) if the row changed under you.

```ts
await ablo.weatherReports.claim(id, async (report) => {
  await ablo.weatherReports.update(report.id, { status: 'ready' }); // guarded by the claim
});
```

Claims are **enforced server-side**: if you `update`/`delete` a row that *another*
participant holds, the commit is rejected with [`AbloClaimedError`](#errors) (`code:
'entity_claimed'`). To proceed, `claim` the row yourself — the claim queues
behind the current holder and re-reads once it's yours, so your `update` lands
on fresh data. You never conflict with your own claim, and reads are never gated.

```ts
try {
  await ablo.weatherReports.update(id, { status: 'ready' });
} catch (err) {
  if (err instanceof AbloClaimedError) {
    // someone else holds it — claim the row and retry from fresh state
  }
}
```

---

## Errors

All extend `AbloError` (`packages/sync-engine/src/errors.ts`). Catch by `type` or
inspect the `code`.

| error | `code` | thrown when | carries |
|---|---|---|---|
| `AbloClaimedError` | `claim_lost` | A held/queued claim was taken away (holder TTL lapse on disconnect, or revoke) while you were holding or waiting. | `claims?` |
| `AbloClaimedError` | `grant_timeout` | The optional `timeoutMs` elapsed while you were still queued for a grant. | `claims?` |
| `AbloClaimedError` | `queue_too_deep` | `claim` was passed `maxQueueDepth` and the wait line was already that deep when you tried to join — fail-fast instead of waiting. | `claims?` |
| `AbloClaimedError` | `claim_conflict` | An `update`/`delete` targets a row another participant holds — the server's pre-commit check rejected it. | — |
| `AbloClaimedError` | `entity_claimed` | Same conflict, from the commit guard backstop. | — |
| `AbloStaleContextError` | — | A guarded `update` (under a claim, or any write carrying `readAt`) targets a row that received deltas since the snapshot — your reasoning is stale. | `readAt`, `conflicts[]` |
| `AbloValidationError` | `model_claim_not_configured` | `claim` called on a model without collaboration wiring. | — |
| `AbloValidationError` | `entity_not_found` | The row id doesn't exist locally or on load. | — |

`AbloStaleContextError.conflicts` lists the `(model, id, observedSyncId)` rows
that moved during your generation window — use it for selective regeneration
(re-think only the slides that changed, not the whole deck) and for metrics.

```ts
try {
  await ablo.weatherReports.claim('report_stockholm', async (report) => {
    const weather = await weatherAgent.getWeather(report.location); // slow gap
    await ablo.weatherReports.update(report.id, { forecast: weather });
  });
} catch (err) {
  if (err instanceof AbloClaimedError && err.code === 'claim_lost') {
    // Our lease lapsed mid-flight (we stalled past the TTL). Re-claim and retry.
  } else if (err instanceof AbloStaleContextError) {
    // The row moved under us — re-read and regenerate from the fresh snapshot.
  } else throw err;
}
```
