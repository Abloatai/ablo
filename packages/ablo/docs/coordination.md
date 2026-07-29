# Coordination Reference

> Claim mechanics and the API behind them: who holds a row, who is waiting, and how the line moves.

> **Governing convention:** [`concurrency-convention.md`](./concurrency-convention.md)
> — the non-coercion principle (surface state, let the actor decide), the full
> `onStale` taxonomy, the batch premise (`reads[]`), and the boundaries. Read
> that for the *why* and the contract; this reference is the *how* (claim
> mechanics + API).

Coordinate long-running work on a row so agents — and the people watching them —
don't clobber each other. Most writes need none of this — a plain `ablo.<model>.update({ id, data })`
is **last-write-wins** by default.

> **Read-modify-write under contention? Use the functional update — it owns all
> of this for you.** When the new value is computed from the current one (the
> shape that races), pass a function instead of data:
>
> ```ts
> await ablo.documents.update(id, (current) => ({ content: revise(current.content) }));
> ```
>
> The SDK reads the freshest row, runs your updater, writes it as a
> compare-and-swap, and re-reads + re-runs on any concurrent write — no claim, no
> per-agent identity, no `stale_context` / `claim_*` codes, no retry loop, and no
> way to silently clobber. See [Functional update](#functional-update).
> The rest of this page is the **low-level** machinery the functional form is
> built on — reach for it directly only when you need to **hold a row across a
> slow gap with side effects** (e.g. presence badges, multi-row handles), or want
> explicit FIFO ordering. For lost-update detection on a single read-modify-write,
> prefer the functional form over hand-rolling `claim` / `readAt` / `onStale`.

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize instead
of clobbering. The wait is a **server-side FIFO queue**: a second claimer blocks
until promoted to the head of the line — it does not fail and does not poll.
Reads stay open: reading a claimed row is allowed unless the caller explicitly
asks for claimed gating. A claim carries a TTL so a crashed holder is
auto-released and the queue advances.

A claim is also as narrow as you make it. Select one or more `fields` and
exclusion follows the target: **two claims on different fields of the same row
are both granted**, and only claims that share a field queue behind each other.
See [claiming part of a row](#claiming-part-of-a-row).

> **Transport: both wait — only the mechanism differs.** `claim({ id })` means
> "serialize me behind whoever holds this row" on every transport. The
> realtime client parks the promise on its socket and resolves it on the grant
> frame. The **stateless HTTP client** (`Ablo({ transport: 'http' })` — the
> transport server-side agents use) holds the same place in the same
> server-side FIFO line; under the hood it heartbeats its queued ticket until
> the line moves, then re-reads the row and resolves to the same held claim.
> The same snippet works on both.
>
> Shape the wait the same way on either transport: cap it with
> `waitTimeoutMs` (rejects `grant_timeout` and leaves the line), cancel it
> from outside with `signal` (an `AbortSignal`; rejects
> `claim_wait_aborted`), bound the line you'll join with `maxQueueDepth`
> (`queue_too_deep`), or skip waiting entirely with `queue: false` — the
> try-claim, which resolves `null` when the target is held (skipped work
> is not an error) and takes no place in line. For
> callers that manage the wait themselves, the ticket surface remains:
> `ablo.claims.get({ claimId })` polls a ticket to its grant,
> `ablo.claims.heartbeat({ claimId })` keeps the slot, and
> `ablo.claims.release({ claimId })` leaves the line. And contention can be
> treated as a signal rather than a wait at all — catch the error, re-read
> fresh, regenerate, retry; see [Errors](#errors) for the loop sketch.

This reference opens with [the model](#the-model-three-layers-one-decision) — the
one answer to "how do two agents not clobber each other" — then covers the
[claim state object](#the-claim-state-object), the SDK [methods](#methods)
(`claim` · `claim.state` · `claim.queue` · `claim.release` · [writing under a
claim](#writing-under-a-claim)), and the [errors](#errors) you can catch.

> **Before anything else: one identity per agent (for the low-level claim
> path).** The [functional update](#functional-update) does
> **not** need this — its safety comes from the row watermark (compare-and-swap),
> not from participant identity, so it's correct even when many workers share one
> `sk_`. The rule below applies when you take **explicit `claim`s** for FIFO
> exclusion or presence.
>
> Coordination excludes
> *participants*, and a participant **is the key**, not the client object. The
> server derives identity from the credential's scope — so **N clients sharing
> one `sk_`/`ek_` are one participant**: they all see the same `heldBy`, never
> queue behind each other, and a "second" claimer silently re-takes the lease it
> already holds (no mutual exclusion). To get real per-agent exclusion, mint a
> **distinct scoped `rk_` per agent** and bind a client to it:
>
> ```ts
> const { token } = await ablo.sessions.create({ agent: { id: `agent-${i}` } }); // rk_
> const agent = Ablo({ schema, apiKey: token }); // this agent's own participant
> ```
>
> Now `agent-0` holds while `agent-1`/`agent-2` queue in FIFO order and drain in
> turn. See [sessions](./sessions.md#agent-sessions-rk_) for the minting flow.
>
> **Testing exclusion:** mint two sessions with different `agent.id` values,
> assert those values differ, let A acquire the row, and inspect
> `claim.state({ id })` before B calls `claim({ id, queue: false })`. B must
> receive `null`. Creating two clients from the same key tests re-entrancy, not
> contention. An empty `claim.state` is an observation/subscription issue; it
> does not relax the authoritative lease check.

---

## The model: three layers, one decision

Ablo has exactly **three** coordination layers. They are **not** three competing
answers to the same question — they stack, and only one of them is a decision you
make:

| layer | kind | what it does | enforces? |
|---|---|---|---|
| **Presence** (`claim.state`, observers) | observation | Broadcasts who is working where, live. Renders cursors / "agent X is editing." Reading or claiming a row auto-enrolls you in its sync group, so `claim.state({ id })` observes co-participants from any client (browser or Node agent) with no manual subscribe step. | **No.** Advisory only: it never blocks or rejects a write. |
| **Claim** (`claim`/`claim.queue`/`claim.release`) | pessimistic | Reserves a row for one participant. Foreign writers are rejected server-side; contenders join a fair FIFO queue. | **Yes**, between participants: mutual exclusion. |
| **Stale-context** (`readAt` + `onStale`) | optimistic (LWW) | On commit, rejects a write whose snapshot is older than the row's latest delta. Last-writer-wins detection. | **Yes**, against time: lost-update detection. |

**The one decision: do you hold the row across a slow gap (read → LLM call →
write)?**

- **No** (the common case — a single quick `update`): a plain `ablo.<model>.update`
  is **last-write-wins** — it carries no `readAt`, so the server skips the stale
  check and the write simply lands. That's fine for most fields. If you need
  lost-update detection on a no-claim write, pass `readAt` + `onStale: 'reject'`
  yourself and it rejects with `AbloStaleContextError` when the row moved under
  you.
- **Yes** (you'll reason for seconds while holding the row): `claim` it. The claim
  excludes other participants for the duration, queues contenders fairly, and —
  see below — your own writes under it stay stale-guarded too.

**How they compose (what wins):** If you don't hold the row, claims win — a
non-holder writing to a claimed row is rejected (`AbloClaimedError`) regardless of
`readAt`. If you do hold it, your own writes are still stale-checked — a row that
moved between your snapshot and your write still rejects with
`AbloStaleContextError`. With no claim held and no `readAt`, there is **no**
stale protection — the plain write is last-write-wins; opt into lost-update
detection by passing `readAt` + `onStale` yourself. Presence (`claim.state`)
never decides anything — read it to render, act on the errors. The two checks are
independent: one rejects writes from people who don't hold the claim, the other
rejects writes based on a stale snapshot, and the SDK adds the stale-check for you
when you write under a claim **you took on this client**, so there you don't pass
anything extra.

---

## Declaring conflict behaviour in the schema (Axis 3)

The two enforcement layers above are decided **per write** (claim a row, or pass
`readAt` + `onStale`). You can also declare a model's **default** conflict
disposition once, in the schema, so every commit to that model is governed
without per-call wiring. This is the third coordination axis — orthogonal to
`policy` (who may read a row) and `groups` (which delta channels it fans into).

Set a model's `conflict` stance with `coordination`, naming one rule per kind of
committer:

```ts
import { coordination, model, z } from '@abloatai/ablo/schema';

export const cards = model(
  {
    title: z.string(),
  },
  {
    // "a human's edit always wins (never blocked); an agent yields"
    conflict: coordination.humansOverwrite().agentsReject(),
  }
);
```

Each rule pairs a committer with a disposition, drawn from the same `onStale`
vocabulary the write guards use:

| disposition | meaning |
|---|---|
| `overwrite` | the write wins; that committer is never blocked. |
| `reject` | the write is refused; that committer yields to a held claim / stale snapshot. |
| `notify` | hold the write and hand back the current value so the committer re-reads and re-applies (stale writes only). |

That gives nine rules — `humansOverwrite` / `humansReject` / `humansNotify`,
`agentsOverwrite` / `agentsReject` / `agentsNotify`, `systemOverwrite` /
`systemReject` / `systemNotify` — and a chain may name as many as it needs. A
kind left unnamed falls through to the engine default, and a kind named twice
takes the later rule.

When the rules are assembled at runtime rather than written out, each one is
also a standalone function, and `coordination()` merges them:

```ts
import { coordination, humansOverwrite, agentsReject } from '@abloatai/ablo/schema';

const stance = coordination(humansOverwrite(), agentsReject());
```

Both forms produce the same thing: a map keyed by the committer's participant
kind, which is what travels to the server.

```ts
{ user: 'overwrite', agent: 'reject' }
```

### How it relates to per-write coordination

- The `conflict` map is **pure, serializable data**: it ships in your pushed
  schema (`npx ablo push`) and the engine interprets it at the commit
  chokepoint — there is no per-model code on the server.
- An **omitted committer kind falls through to the engine default**: reject, and
  honor a per-write `onStale: 'notify'`. Declaring `conflict` is purely
  additive — existing schemas behave exactly as before.
- It sets the **default** disposition; a per-write `onStale` and a held `claim`
  still apply on top as described above. Think of `conflict` as "the house rule
  for this model," and `claim` / `onStale` as what an individual write does
  within it.

The `ConflictAxis` type (also available as `Ablo.Conflict.Axis`) and the
`interpretConflictAxis` interpreter are exported for composing custom policies.

---

## The claim state object

The claim state object is the live record that a participant is coordinating work on
a model row. It's what `claim.state()` returns and what observers render.

| field | type | description |
|---|---|---|
| `id` | `string` | The claim id (distinct from the target row id). |
| `status` | `ClaimStatus` | `'active' \| 'queued' \| 'committed' \| 'expired' \| 'canceled'`. `active` = the holder; `queued` = waiting in line behind it. The other three are terminal states you only see on a claim you just finished: `committed` (released after a successful write), `expired` (TTL lapsed), `canceled` (released early). |
| `target` | `EntityRef` | What is being coordinated: the row (`{ model, id }`) plus any field narrowing the holder claimed: `field?`, `fields?`, and opaque `meta?`. A target with no narrowing covers the whole row. |
| `description` | `string` | Peer-visible description of the work: the sentence another participant reads to decide whether to wait or move on (`'rewriting the risk section'`). Defaults to `'editing'`. |
| `heldBy` | `string` | Participant holding (or waiting on) it (e.g. `'agent:forecaster'`). |
| `participantKind` | `'user' \| 'agent' \| 'system'` | Who's behind it: a human (`user`), an AI (`agent`), or automated infrastructure (`system`). |
| `position` | `number?` | 0-based place in the FIFO line: present only when `status: 'queued'` (`0` = next behind the holder). |
| `createdAt` | `number?` | Ms-epoch the holder opened it. Optional: derived shapes may omit it. |
| `expiresAt` | `number` | Ms-epoch the server reclaims it if the holder goes **silent**. Renewed automatically while the holder's connection stays alive: a crash-cleanup floor, not a duration you size. |
| `meta` | `Record<string, unknown>?` | The claim's open metadata bag, as it stands on the wire. A [heartbeat](#heartbeat-holding-a-claim-for-long-running-work) writes its `details` here under `progress`: last beat wins, so an observer can read what a long hold is doing without the holder releasing it. Distinct from `target.meta`, which is the shape your program declared: a declared shape has no member for a key the coordinator wrote. |

```jsonc
{
  "id": "claim_8fJ2",
  "status": "active",
  "target": { "model": "weatherReports", "id": "report_stockholm" },
  "description": "editing",
  "heldBy": "agent:forecaster",
  "participantKind": "agent",
  "createdAt": 1748160000000,
  "expiresAt": 1748160030000,
  "meta": { "progress": { "phase": "writing", "done": 2, "of": 5 } }
}
```

### Lifecycle

```
            claim({ id })              update({ id }) lands
  (free) ───────────▶ active ───────────────────────▶ committed
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
        canceled                 expired
   (release w/o write)        (TTL; holder died)
```

A target is free when `ablo.<model>.claim.state({ id })` returns `null`. Terminal
states drop out of the live stream, so a claim you can see is either `active`
(the holder) or `queued` (waiting in the FIFO line behind it; see
[`claim.queue`](#claimqueue)).

Reading a holder's progress is the same synchronous read as everything else
here — no second subscription, and nothing to poll:

```ts
const held = ablo.documents.claim.state({ id: docId });
const phase = held?.meta?.progress?.phase ?? 'reading';
```

---

## Methods

One word — "claim" — names four distinct things; keep them separate as you read:

- **the lease (claim handle):** the *object* returned by `ablo.<model>.claim({ id })`
  (`ClaimHandle`, an `AsyncDisposable` with `.data` and `.release()`).
- **acquiring a claim/lease:** the *verb* `ablo.<model>.claim({ id })`, the call
  that takes the lease.
- **`claim.state` / `claim.queue`:** the *inspection namespace* hanging off the
  model, for reading who holds the row and who's lined up.
- **the write's `claim` param:** `update({ id, data, claim })`, where you pass a
  lease the proxy didn't take itself.

Each method below follows one fixed shape: **signature · what it does ·
parameters · returns · example**.

### `claim`

```ts
ablo.<model>.claim({ id, ...options }): Promise<ClaimHandle<T>>  // handle; AsyncDisposable, auto-releases with `await using`
```

Claim a row so other writers serialize behind you until you're done; reads stay
open by default. The claim acquires through the server's fair FIFO queue: if the
target is free the lease is yours immediately, and if another participant holds
it your claim **waits in line** and resolves only once it reaches the head —
then re-reads so the claimed snapshot reflects what the previous holder
committed. There's no polling and no race window — the server decides the order,
so two claimers can't both think they won.

**Parameters** — every option is flat on the call, and each sits on one of
four axes. `claim({ id })` alone is a complete call; each axis is opt-in.

*What you claim* — the target, narrowed below the row:

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id: same id as `retrieve` / `update`. |
| `options.fields` | field selector | no | Claim fields declared by the model's Zod schema instead of the whole row: `fields: (task) => task.status`, or `fields: (task) => [task.status, task.title]` for several. The model supplies its own fields, so autocomplete is exact, a typo does not compile, and a schema rename is a compile error at every use. Two sets conflict where they intersect, so holders of disjoint fields do not wait for each other; see [claiming part of a row](#claiming-part-of-a-row). |

*What others see* — the presence half:

| name | type | required | description |
|---|---|---|---|
| `options.description` | `string` | no | Peer-visible description of the work, shown to observers (default `'editing'`). |
| `options.meta` | `object` | no | App-defined structured metadata, carried verbatim to every participant observing the claim. Declare its shape once on `Register`'s `ClaimMeta` slot. |

*How you handle contention*:

| name | type | required | description |
|---|---|---|---|
| `options.contention` | `Claim.ContentionOptions` | no | Keeps the response to a busy target together: `{ mode: 'wait', maxDepth?, timeoutMs?, signal?, onStatus? }`. Use `mode: 'skip'` for claim-or-skip dedup; a foreign holder resolves the claim as `null`. |
| `options.queue` | `boolean` | no | Compatibility shorthand: `true` waits and `false` skips. Prefer `contention` when configuring more than the mode. |
| `options.maxQueueDepth` | `number` | no | Legacy flat spelling of `contention.maxDepth`. Prefer `contention` for new code. |
| `options.waitTimeoutMs` | `number` | no | Legacy flat spelling of `contention.timeoutMs`. Prefer `contention` for new code. |
| `options.signal` | `AbortSignal` | no | Legacy flat spelling of `contention.signal`. Prefer `contention` for new code. |

*How long you hold* — the lease:

| name | type | required | description |
|---|---|---|---|
| `options.ttl` | `Duration` | no | Crash-cleanup floor. Rarely set: the lease renews while your connection is alive, so it only matters once you go silent. |
| `options.heartbeat` | `true \| Duration \| { every?, onBeat?, onLost? }` | no | Keep the lease alive for work that outlives the TTL: `true` beats every third of the TTL, a duration sets the cadence, and the structured form carries the cadence and both callbacks in one place: `onBeat` fires after every successful beat (chiefly `queueDepth`, the pressure signal), `onLost` once if a beat learns the lease is gone. The loop stops on release. |

The request-scoped `onStatus` callback receives one discriminated event. It is
observational: an exception in UI or telemetry code never changes the claim
attempt.

| event | meaning | claim promise |
|---|---|---|
| `queued` | this request joined the wait line | remains pending |
| `granted` | this request owns the lease | resolves with the claim |
| `skipped` | `mode: 'skip'` found another participant holding the target | resolves `null` |
| `failed` | the attempt could not complete, for example timeout, cancellation, authorization, or connectivity | rejects with `event.error` |

```ts
const claim = await ablo.tasks.claim({
  id,
  contention: {
    mode: 'wait',
    maxDepth: 3,
    timeoutMs: 30_000,
    onStatus(event) {
      if (event.type === 'queued') {
        console.log(`${event.ahead} participant(s) ahead`);
      } else if (event.type === 'granted') {
        console.log(event.waited ? 'your turn' : 'granted immediately');
      } else {
        console.warn(event.error.code, event.error.message);
      }
    },
  },
});
```

For claim-or-skip work, make the caller's intent explicit and keep its status
observer beside the decision:

```ts
const claim = await ablo.tasks.claim({
  id,
  contention: {
    mode: 'skip',
    onStatus: (event) => {
      if (event.type === 'skipped') metrics.increment('claim.skipped');
    },
  },
});
if (!claim) return;
```

The high-level `claim` queues by default, so on contention you either get the row
when your turn arrives or one of the [queue errors](#errors) (`claim_lost`,
`grant_timeout`).

**Returns** — a `ClaimHandle<T>` (an `AsyncDisposable`): `handle.data` is the
fresh row snapshot taken once the lease is yours, and `handle.release()` gives
the claim back. Bind it with `await using` so the claim auto-releases when the
scope exits.

**Example**

```ts
await using claim = await ablo.weatherReports.claim({ id: 'report_stockholm' });
const report = claim.data;
const weather = await weatherAgent.getWeather(report.location);
await ablo.weatherReports.update({ id: report.id, data: { forecast: weather } });
```

The claim releases when the `await using` scope exits — **on return and on
throw.** The "on throw" is the whole reason to bind it with `await using`: if the
work between the claim and the write fails — the agent call errors, validation
rejects, you decide not to write — the scope unwinds, the lease is released, and
the next waiter is promoted, with no `finally` to remember. And nothing reaches
the server until `update`, so a failure *before* the write leaves the row exactly
as it was: claiming and committing are separate steps, so a failure between them
has nothing to roll back. (A failure *after* a successful write leaves that write
committed — pass an idempotency key on the write if you replay the block.) The
lower-level [`claim.release`](#claimrelease) shows the manual `try/finally`
equivalent for when you hold a claim without `await using`.

### Claiming part of a row

Name a field and a typo cannot survive — the model is already bound by the call,
so it hands you its own fields:

```ts
await using mine = await ablo.tasks.claim({ id, fields: (task) => task.status });
```

`task.status` is checked against the model: a field it does not have stops
compiling, and renaming one is a compile error at every use. Nothing to import,
nothing to add to your schema file.

The selector is the public model API. Quoted field names exist only in the wire
contract and low-level coordination protocol.

A claim covers the whole row only when you name nothing narrower. Select
`fields` and exclusion follows them: **two claims on different
fields of the same row are both granted**, and only claims that share a field
queue behind each other.

```ts
// Two agents on the SAME order at the same time. The pricing agent holds
// `total` and `discount`; the fulfillment agent holds `status`. Disjoint
// fields, so both are granted at once and neither waits on the other.
await using priced = await ablo.orders.claim({
  id: orderId,
  fields: (o) => [o.total, o.discount],
  description: 'repricing',
});

await using shipping = await ablo.orders.claim({
  id: orderId,
  fields: (order) => order.status,
  description: 'marking shipped',
});
```

Overlap is set intersection. Holders on `total` and on `status` proceed
concurrently; two claims that both name `total` queue; naming no field covers
every field, so it conflicts with any narrower claim on the row.

**Field is the floor.** A claim cannot be finer than a whole field, because
nothing writes part of a value: whichever holder commits first takes the entire
field. Sub-field targets, a range of text or a path into a document, are not
offered. Two writers holding different parts of one field is only safe once
concurrent edits to that field can be reconciled (operational transformation),
and that is not solved yet. When it is, sub-field targets return, and they
return working.

A claim with no target is the widest parent: it covers every field of the row
and conflicts with any narrower claim on it.

### Claim-gated reads

`claim.state({ id })` always returns immediately. Model reads such as
`ablo.<model>.local.get(id)` are local reads and stay available while a claim is
held. Server/model reads can choose a claimed policy:

```ts
await ablo.weatherReports.get({
  id: 'report_stockholm',
  ifClaimed: 'fail',
});
```

- `ifClaimed: 'return'` (the default) reads now and includes active work metadata.
- `ifClaimed: 'fail'` throws `AbloClaimedError` if the row is claimed.

Reads never block on a claim — there is no `ifClaimed: 'wait'`. Waiting for a row
to free up is a **claim-side** concern: take `ablo.<model>.claim({ id })` (it
queues fairly behind the current holder and re-reads the fresh row once it's
yours). Use `ifClaimed: 'fail'` when a read should simply refuse to proceed
against a row someone else is mid-editing.

### `claim.state`

```ts
ablo.<model>.claim.state({ id })
```

Read who's currently working on a row, for observers and UI. Synchronous and
reactive (it reads the local coordination snapshot). Never blocks.

**You don't subscribe to anything first.** Reading or claiming a row
automatically enrolls you in that row's sync group: reading it (including
`retrieve`/`get`, or `claim.state` itself) gives you **read-interest**, and
`claim`-ing it gives you a **pinned write-intent**. So `claim.state({ id })`
observes co-participants on that row from **any** client — a browser, a Server
Action, or a Node agent — and a holder sees its own claim, with no manual
subscribe step. There is no `participants.join` to call: the typed
`ablo.<model>` surface (read / `claim` / `claim.state` / `claim.queue`) is the
whole coordination API.

**Parameters**

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id. |

**Returns** — an active [claim state object](#the-claim-state-object) on the row, or
`null` when the row is free.

**One holder, and a row can have several.** This reads a row, not a target, and
answers with a single claim. That is the whole story for a whole-row claim, and
only part of it once you [claim parts of a row](#claiming-part-of-a-row): three
agents holding `total`, `discount`, and `status` are all active at once, and
this read surfaces one of them. To render every holder, a badge per claimed
field or a chip per participant, use [`claim.list`](#claimlist).

**Example**

```ts
const who = ablo.weatherReports.claim.state({ id: 'report_stockholm' });
if (who) console.log(`${who.heldBy} is ${who.description}`);
```

Returns the active claim state when the row is held, or `null` when it's free:

```jsonc
{
  "id": "claim_8fJ2",
  "status": "active",
  "target": { "model": "weatherReports", "id": "report_stockholm" },
  "description": "editing",
  "heldBy": "agent:forecaster",
  "participantKind": "agent",
  "expiresAt": 1748160030000
}
```

### `claim.list`

```ts
ablo.<model>.claim.list({ id })
```

Every holder of a row. Same synchronous, reactive read as `claim.state` — off
the same local snapshot, safe to call inline in a render — and the same list
envelope as [`claim.queue`](#claimqueue).

Reach for it whenever a row can be claimed by field. One agent repricing
`total` while another marks `status` are two active claims on one row, and only
this read returns both.

**Parameters**

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id. |

**Returns** — `{ object: 'list', data: Claim[] }`. Your own claim comes first
when this client holds one, then the other participants'. Empty `data` when the
row is free.

**Example** — a badge on every claimed field:

```tsx
const { data: holders } = ablo.orders.claim.list({ id: orderId });

return FIELDS.map((field) => {
  const held = holders.find((c) => c.target.field === field);
  return <FieldBadge key={field} field={field} by={held?.heldBy} note={held?.description} />;
});
```

`claim.state({ id })` remains the right read when a row is claimed whole, or
when all you need is "is anyone working here" — it answers with one claim and
`null` when the row is free.

### `claim.queue`

```ts
ablo.<model>.claim.queue({ id })
```

Read the **wait line** behind a row — the FIFO of claims queued behind the
current holder, in promotion order. Like `claim.state`, it's synchronous and
reactive (it reads the local coordination snapshot, kept current by the server's
queue-mutation frames), and reading never blocks. Where `claim.state` answers "who
holds it," `claim.queue` answers "who's lined up next" — render "3rd in line", or
decide the wait isn't worth it.

**Parameters**

| name | type | required | description |
|---|---|---|---|
| `id` | `string` | yes | The row id. |

**Returns** — a structured queue snapshot:

- `waiting` — queued [claim state objects](#the-claim-state-object) in
  promotion order, excluding the active holder;
- `next` — the first waiter, or `null`;
- `size` — how many participants are waiting;
- `data` — the same array as `waiting`, retained as the standard list-envelope
  member for compatibility.

**Example**

```ts
const line = ablo.weatherReports.claim.queue({ id: 'report_stockholm' });
console.log(`${line.size} waiting`);
console.log(`next: ${line.next?.heldBy ?? 'nobody'}`);
console.log(line.waiting.map((claim) => claim.heldBy));
```

### `claim.release`

```ts
ablo.<model>.claim.release({ id }): Promise<void>
```

Release a claim you hold. Usually **implicit** — the `await using` scope exiting
releases for you, and TTL cleans up a crashed holder.
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
const claim = await ablo.weatherReports.claim({ id: 'report_stockholm', description: 'reviewing' });
const report = claim.data;
try {
  const ok = await reviewExternally(report);
  if (!ok) return; // abandon, no write
  await ablo.weatherReports.update({ id: report.id, data: { status: 'ready' } });
} finally {
  await ablo.weatherReports.claim.release({ id: report.id });
}
```

### `heartbeat`: holding a claim for long-running work

```ts
held.heartbeat(ttl?: Duration): Promise<{ expiresAt: number }>
```

A claim's TTL is crash cleanup, not a work-duration estimate — so a task that
outlives it (an agent run, a background worker's job) keeps its lease by
**beating**, the same pattern as an SQS visibility heartbeat or a Temporal
activity heartbeat. Each beat extends the lease from now (never shortens it,
and each extension is clamped server-side); a crashed worker stops beating and
its lease lapses within one beat window, promoting the next waiter.

Usually **implicit** — pass `heartbeat` when claiming and the SDK beats every
third of the TTL until release:

```ts
await using claim = await ablo.reports.claim({
  id: 'report_q3',
  description: 'generating',
  ttl: '5m',
  heartbeat: { onLost: () => abortWork() }, // `true` and '2m' are the shorthands
});
await runLongGeneration(claim.data); // lease held for the duration
// scope exit releases; the loop stops with it
```

A beat that comes back with a definitive loss — the lease expired and the
queue moved on — rejects with `AbloClaimedError` (`claim_lost`) and stops the
auto-loop. For a worker with no socket, **the failed beat is the loss
notification**; abandon or re-claim, and remember any write attempted under
the old lease is independently rejected by its `readAt` guard. Transient
failures (a connection blip) don't stop the loop — the next tick retries.

Each beat's answer carries two more things:

- **`queueDepth`:** how many participants wait in line behind the lease.
  This is the cooperative-yield pressure signal: a worker that can checkpoint
  may release early when others wait. Read it from the resolved beat, or pass
  `heartbeat: { onBeat }` when claiming to observe every auto-beat.
- **progress `details`:** `held.heartbeat({ details: { pages: 42, of: 100 } })`
  stores the payload as the claim's peer-visible `meta.progress` (last beat
  wins, via `claim.state`). This is presence, not a checkpoint: it dies with
  the lease. Durable progress belongs in the data itself — write a row, and
  every subscriber already sees it.

Cooperative yield has a server-side backstop your deployment can turn on: a
**cumulative-hold ceiling**. Left unset — the default — a holder that keeps
beating holds the row as long as it likes, and the line behind it depends on
that holder reading `queueDepth` and releasing of its own accord. With a ceiling
configured for a model, a holder that runs past its fair share *while contenders
are queued* is preempted at the server: its next beat comes back `claim_lost`
(reason `preempted`) — the same loss you already handle, so abandon or re-claim,
and any write attempted under the old lease is fenced regardless. A holder with
no one waiting is never preempted, however long it runs. It is the same idea as
an SQS message that cannot stay invisible past a hard cap however often its lock
is refreshed, narrowed here to bite only under real contention.

Works identically on both transports: the realtime client sends a
`claim_heartbeat` frame; the HTTP client posts
`POST /api/v1/models/{model}/{id}/claim/heartbeat` (`{ ttl?, claimId?, details? }`).
Over HTTP, a **queued** claim can heartbeat too — it refreshes the waiter's
slot in the line (a queued slot is TTL'd like a lease) and reports
`{ status: 'queued', position }`.

A stateless worker holding **many** rows beats them all in one round trip:
`ablo.claims.heartbeatAll({ ttl: '5m' })` → `POST /api/v1/claims/heartbeat`, one
entry per extended lease. This is the socketless twin of the realtime
keepalive, which already renews every held lease on each ping.

### durability: what a claim survives

A lease belongs to your **identity** — the participant behind the credential —
not to the socket it was claimed on; the server keys each lease by participant
and `claimId`. That one fact decides what a claim lives through.

**A brief blip is transparent.** The realtime client reconnects on its own
(exponential backoff), and on each reconnect it re-announces every claim it
still holds, so the server renews those leases and peers never see them flicker.
A heartbeat that would land while the socket is momentarily down is skipped
rather than failed — the next tick retries once the connection is back. Nothing
to write: hold the claim and keep working.

**A crashed holder frees the claim quickly — and it is the keepalive, not the
TTL, that does it.** A dead holder is caught whichever way fires first: a clean
socket close releases immediately, and a silent socket that never sent a close
frame (a crashed tab, a dropped NAT) is reaped on the keepalive cycle (a ~30s
ping / 10s pong window) and released then. Either way the next waiter is
promoted within tens of seconds. This reclaim is **per-connection**, and it runs
whether or not the TTL is anywhere near lapsing. Release fires only when your
**last** connection goes, so a second connection under the same identity keeps
the claim held.

**The TTL is the deeper floor — for when the server itself restarts.** The live
claim roster is held in memory, so a server restart would lose it; the durable
lease in the coordination store carries the TTL, and a reconnecting client
re-announces its claims before that TTL lapses. So size `ttl` to cover a
deploy or restart window, not your work duration — beating covers the work
duration.

**To hold a claim across a holder crash, give it a durable identity.** A claim
that must outlive a single failure belongs to a process that stays up — a
backend worker or agent with its own credential — rather than one ephemeral
browser tab. On reconnect the SDK re-announces it; if the row was granted onward
while you were gone, that re-announce comes back as `AbloClaimedError`
(`claim_lost`) — re-claim (you rejoin the line fairly) and retry from the fresh
snapshot.

| the holder… | what happens to the claim |
| --- | --- |
| blips, then reconnects within the window | renewed automatically on reconnect: no interruption |
| crashes or drops for good | released within one keepalive cycle; the queue advances |
| still has a second live connection | survives: release fires only on the last connection |
| loses the server to a restart | rides the TTL in the coordination store; re-announced on reconnect |

### `join`: presence for a set of rows

Reading or claiming a row auto-enrolls you in its sync group, which is enough for
`claim.state`/`claim.queue` to observe co-participants. When you want to *hold*
presence on a known set of rows — a workspace's documents, a board's cards — and react to
who joins or leaves, use `join`:

```ts
await using room = await ablo.documents.join(slideIds, { ttl: '5m' });
room.peers; // who else is here, live
```

`join(ids, { ttl? })` opens a model-scoped presence/claim subscription and returns
a participant handle (`.peers`, the scoped claim stream, `.leave()` / `await using`
disposal). It is the model-scoped successor to the old top-level
`ablo.participants.join({ scope })`. **WebSocket only** — presence needs a live
socket, so `join` is absent on the HTTP client (`Ablo({ transport: 'http' })`) and
throws on any non-ws construction.

### Writing under a claim

There is no separate "write" method on a claim — use the normal
`ablo.<model>.update({ id, data })`. The auto-guarding holds **only when this same
client took the claim** via `ablo.<model>.claim({ id })` (the proxy remembers the
lease in-process): that `update` is then stale-guarded against the snapshot the
claim took (`readAt` = snapshot watermark, `onStale: 'reject'`) and attributed to
the claim's lease, so it rejects with [`AbloStaleContextError`](#errors) if the
row changed under you.

```ts
await using claim = await ablo.weatherReports.claim({ id });
await ablo.weatherReports.update({ id: claim.data.id, data: { status: 'ready' } }); // guarded by the claim
```

A claim handle minted by **another client** (or returned over HTTP) is not known
to this proxy, so a plain `update` won't pick it up. Pass it explicitly:

```ts
await ablo.weatherReports.update({ id, data: { status: 'ready' }, claim: handle });
```

**Self-stale on a second write.** The claim's watermark is fixed at claim time
and is **not** re-baselined as you write. So a *second* `update` under one held
claim is stale-checked against the snapshot the claim took — which your *first*
write already moved past — and rejects with `AbloStaleContextError` against your
own earlier write. Re-read (and re-claim) between writes if you need to write the
same row more than once under one claim.

Claims are **enforced server-side**: if you `update`/`delete` a row that *another*
participant holds, the commit is rejected with [`AbloClaimedError`](#errors) (`code:
'entity_claimed'`). To proceed, `claim` the row yourself — the claim queues
behind the current holder and re-reads once it's yours, so your `update` lands
on fresh data. You never conflict with your own claim, and reads are never gated.

```ts
try {
  await ablo.weatherReports.update({ id, data: { status: 'ready' } });
} catch (err) {
  if (err instanceof AbloClaimedError) {
    // someone else holds it — claim the row and retry from fresh state
  }
}
```

---

## Errors

All extend `AbloError` (`packages/transaction/src/errors.ts`). Catch by `type` or
inspect the `code`.

| error | `code` | thrown when | carries |
|---|---|---|---|
| `AbloClaimedError` | `claim_lost` | A held/queued claim was taken away: the holder disconnected (reaped on the keepalive cycle), went silent past its TTL, was revoked, or was preempted (a privileged reorder, or a configured cumulative-hold ceiling reached while contenders waited), while you were holding or waiting. | `claims?` |
| `AbloClaimedError` | `claim_queued` | **HTTP transport only.** A contended `claim` (default `queue: true`) could not block-wait for the lease (no socket), so it rejected immediately instead of queueing. Retryable: re-attempt the claim. | `claims?` |
| `AbloClaimedError` | `grant_timeout` | The optional `timeoutMs` elapsed while you were still queued for a grant. | `claims?` |
| `AbloClaimedError` | `queue_too_deep` | `claim` was passed `maxQueueDepth` and the wait line was already that deep when you tried to join: fail-fast instead of waiting. | `claims?` |
| `AbloClaimedError` | `claim_conflict` | An `update`/`delete` targets a row another participant holds: the server's pre-commit check rejected it. |: |
| `AbloClaimedError` | `entity_claimed` | Same conflict, from the commit guard backstop. |: |
| `AbloStaleContextError` |: | A guarded `update` (under a claim, or any write carrying `readAt`) targets a row that received deltas since the snapshot: your reasoning is stale. | `readAt`, `conflicts[]` |
| `AbloValidationError` | `model_claim_not_configured` | `claim` called on a model proxy built without the collaboration runtime: an internal/advanced construction path. The standard `Ablo({ schema, apiKey })` client enables claiming for **every** model; there is no per-model claim config to add. |: |
| `AbloValidationError` | `entity_not_found` | The row id doesn't exist locally or on load. |: |

`AbloStaleContextError.conflicts` lists the `(model, id, observedSyncId)` rows
that moved during your generation window — use it for selective regeneration
(re-think only the documents that changed, not the whole workspace) and for metrics.

```ts
try {
  await using claim = await ablo.weatherReports.claim({ id: 'report_stockholm' });
  const report = claim.data;
  const weather = await weatherAgent.getWeather(report.location); // slow gap
  await ablo.weatherReports.update({ id: report.id, data: { forecast: weather } });
} catch (err) {
  if (err instanceof AbloClaimedError && err.code === 'claim_lost') {
    // Our lease lapsed mid-flight (we stalled past the TTL). Re-claim and retry.
  } else if (err instanceof AbloStaleContextError) {
    // The row moved under us — re-read and regenerate from the fresh snapshot.
  } else throw err;
}
```

### The reconcile loop, by hand (rarely needed)

This is the loop the [functional update](#functional-update) runs for you. Write
it yourself only when one attempt isn't a pure re-read-and-recompute — e.g. you
must hold an explicit `claim` for a presence badge across the gap, or coordinate
several rows in one handle. For a single read-modify-write, use the functional
form instead of this.

```ts
const RETRYABLE = (e: unknown) =>
  e instanceof AbloStaleContextError ||                       // row moved under our write
  (e instanceof AbloClaimedError &&
    (e.code === 'claim_queued' ||                             // someone holds it right now
     e.code === 'claim_lost'));                               // a human preempted us

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    await using claim = await ablo.reports.claim({ id });     // acquire or claim_queued
    const fresh = claim.data;                                 // read at the lease moment
    const next = await generate(fresh);                       // slow gap
    await ablo.reports.update({ id, data: next, claim });     // first writer wins
    break;                                                    // landed
  } catch (err) {
    if (!RETRYABLE(err) || attempt === MAX_ATTEMPTS) throw err;
    await sleep(80 + attempt * 40 + Math.random() * 60);      // jitter: don't lock-step
  }
}
```

The loop, not a queue, is the coordination mechanism over HTTP. On the WebSocket
client the same code works but rarely loops, because `claim` blocks in the FIFO
line instead of throwing `claim_queued`.

---

## Functional update

The read-modify-write surface that owns the loop above so you never write it.
Pass a **function of the current state** instead of fixed `data` — the
`setState(prev => next)` of the data layer:

```ts
const row = await ablo.documents.update(documentId, (current) => ({
  content: revise(current.content),        // "given the latest, here is the next"
}));
```

What the SDK does on every call, on **both transports** (one shared loop, so the
guarantee can't drift): read the freshest row + its watermark → run your updater
→ write it as a **compare-and-swap** against that watermark (`readAt` +
`onStale: 'reject'`) → on any concurrent write, re-read and re-run. Correctness
comes from the watermark, **not** from participant identity — so it's immune to
the shared-credential clobber footgun and needs no `claim` and no per-agent `rk_`.

Nothing about claims, identity, or conflict codes surfaces. On both transports,
the call returns the reconciled row or, at the extreme, throws **one** error:

```ts
import { AbloContentionError } from '@abloatai/ablo';

try {
  await ablo.documents.update(id, (cur) => ({ content: revise(cur.content) }), {
    retries: 16,            // reconcile rounds before giving up (default 16)
    signal: req.signal,     // optional: abort the loop if the request is cancelled
  });
} catch (err) {
  if (err instanceof AbloContentionError) {
    // The row stayed continuously contended past the budget — nothing was
    // written. err.attempts, err.cause (the last conflict). Back off, raise
    // `retries`, or move the row to the WebSocket transport (fair FIFO queue).
  }
}
```

Return `null` / `undefined` from the updater to **skip the write** after seeing
fresh state (the call resolves to `undefined`). A missing row throws
`AbloNotFoundError`; a genuine failure (validation, constraint, permission)
propagates immediately without retrying.

### How `create` and `delete` relate

They don't get a functional form — and shouldn't. The functional form exists
because `update` is the only verb whose **next state is a function of the current
state**, which is the shape that races. The other two aren't read-modify-write:

| Verb | Functional form? | Why | Its "just works" property |
| --- | --- | --- | --- |
| `update` | **yes**: `update(id, current => next)` | next value depends on the current one (lost-update hazard) | compare-and-swap + reconcile |
| `create` | no: `create({ data, id? })` | no prior state to read; the hazard is *id collision*, a terminal `unique_violation`, not a lost update | **idempotency**: stable id / `idempotencyKey` makes a retried create safe |
| `delete` | no: `delete({ id })` | no resulting state to compute; "make it not exist" is unchanged by concurrent edits, and delete is idempotent | naturally idempotent |

The same reason React has `setState(prev => next)` but no functional mount /
unmount. A *conditional* delete ("only if unchanged since I read it") is the one
niche case — express it with an explicit `claim` / `readAt` on `delete({ id })`,
not a function.

---

## Observability

Coordination you can't see is coordination you can't debug. Pass an
`observability` provider to `Ablo({ ... })` and the client reports every claim
lifecycle event and stale-write collision it sees. The batteries-included
provider is `ClaimLog`, and `collisions()` is the eval primitive:

```ts
const log = new ClaimLog();
const ablo = Ablo({ schema, apiKey, observability: log });

expect(log.collisions()).toHaveLength(0);   // no one stepped on anyone
```

See [Debugging & Logs](./debugging.md) for the setup, the event shapes, a
reactive activity feed, and routing events to your own backend.
