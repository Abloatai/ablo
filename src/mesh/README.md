# @ablo/sync-engine/mesh

Make any agent a participant in the sync mesh. Capability-scoped, presence-aware, watermark-safe — without replacing your AI stack.

Ablo owns sync-mesh participation, capability tokens, permission ceilings, and write honesty. Everything else — tools, skills, prompts, models, agent orchestration — stays in your code, in whatever shape you already picked.

## Install

```bash
npm install @ablo/sync-engine
```

## Quick start

```ts
import { defineSchema, mutable, z } from '@ablo/sync-engine/schema';
import Ablo from '@ablo/sync-engine';

const schema = defineSchema({
  decks:  mutable.lazy({ title: z.string() }, { syncGroupFormat: 'deck:{id}' }),
  slides: mutable.lazy({ body: z.string()  }, { parent: schema.models.decks }),
});

// Zero-config: reads ABLO_API_KEY from env (org is derived
// server-side from the key). baseURL defaults to
// `https://mesh.ablo.finance`.
const ablo = new Ablo({ schema });

// Your agent — built however you want, Ablo does not interpret its shape.
const slideBot = { label: 'Slide helper' }; // id auto-generated

const participant = await ablo.join(slideBot, {
  scope: { decks: deckId },
  as: session,
});
// Auto-connected — ready to use.
```

That is the entire integration. `ablo.join(agent, opts)` mints a capability token, subscribes to the scope's sync groups, and returns a wrapper that holds your original agent unchanged.

## Concepts

### `mesh.join` is the one verb

Two things are decided at join time — nothing else:

- `scope` — which entity instances the participant can touch.
- `as` — the authority ceiling the participant inherits from. Omit to use the mesh client's API key. (`onBehalfOf` is a legacy alias that still works.)

Everything the participant does afterwards (read, write, subscribe) is bounded by what the Biscuit capability token allows. The ceiling is cryptographic; widening is not expressible.

### Principals set the ceiling

```ts
// API-key ceiling (background workers, batch jobs)
await ablo.join(agent, { scope: { decks: id } });

// Session ceiling (chat assistants — agent acts as the user)
await ablo.join(agent, { as: session, scope: { decks: id } });

// Agent ceiling (sub-agent spawn — parent attenuates into child)
await parent.join(childAgent, { scope: { decks: id } });
```

Every ceiling narrows through `scope`. A child never exceeds its parent; a session-joined agent never exceeds the user's access.

### Scope narrows, never widens

```ts
scope: { decks: [deckId] }                          // one deck
scope: { decks: [deckAId, deckBId] }                // two decks
scope: { decks: [deckId], datarooms: [drId] }       // two entity types
```

Keys must be schema entities with `syncGroupFormat`. The derivation is pure — use `mesh.describeJoin(agent, opts)` to preview the sync groups before joining.

### Default is least-privilege

Under the default `delegationPolicy: 'strict'`, `ablo.join(agent, { as: session })` without `scope` throws. Inheriting the principal's full ceiling must be an explicit act, either by passing the principal's scope back in verbatim or by setting `delegationPolicy: 'permissive'` on the mesh client.

```ts
const mesh = createMesh({
  schema,
  delegationPolicy: 'strict', // default — right for IB / M&A / regulated tenants
  // delegationPolicy: 'permissive', // opt-in for dev / prototype tenants
});
```

Every join call writes an entry to `mesh.audit` — who delegated what to whom, under which authority.

## Sub-agent spawning

Every `MeshParticipant` exposes its own `join`. Children attenuate from the parent's capability; revoking the parent cascades to all descendants at next verify.

```ts
const chatAgent = await ablo.join(chatBot, {
  as: session,
  scope: { decks: deckId },
});

const slideHelper = await chatAgent.join(slideBot, {
  scope: { decks: deckId }, // must be ⊆ chatAgent's scope
});

const layoutFixer = await slideHelper.join(layoutBot, {
  scope: { decks: deckId },
});
```

The whole tree of agents shares the mesh's wire protocol and delta stream. Humans and agents are equal participants — different `kind`, same data API.

## Write honesty

Agents generate on a 10-60 second latency; the world moves in that window. The mesh treats staleness as a first-class write concern, not an escape hatch.

```ts
// Snapshot what the agent is about to reason against.
const ctx = await participant.context.capture({
  entities: [{ type: 'slides', ids: [slideId] }],
});

// Run the LLM — the context's watermark is frozen at this sync point.
const decision = await runLLM({ context: ctx.data, prompt });

// Write against the watermark. If the server saw relevant deltas during
// the generation window, this throws AbloStaleContextError and the
// caller regenerates.
await sync.slides.update(slideId, decision, {
  readAt: ctx.watermark,
  onStale: 'reject', // default. Also: 'flag' | 'merge' | 'force'.
});
```

This is the safe shape for IB / M&A / compliance workflows where an out-of-date slide in a CIM is a data-integrity incident. Switch to `'flag'` or `'force'` only when cosmetic overwrite is explicitly safe.

## Coordination

Every `MeshParticipant` carries three live streams — all reactive via callbacks *and* consumable with `for await`. Use whichever shape fits.

**Presence** — "who's here, what are they doing":

```ts
// Verb methods for canonical actions.
participant.presence.editing(slide);
participant.presence.viewing(slide);
participant.presence.idle();

// Reactive snapshot + callback (useSyncExternalStore-compatible).
const peers = participant.presence.others;
const unsub = participant.presence.subscribe(() => rerender());

// Or consume as an async iterable — each iteration yields the
// current roster on every change.
for await (const peers of participant.presence) {
  renderAvatars(peers);
  if (peers.length === 0) break;
}
```

**Intents** — "I'm about to do X; peers should yield":

```ts
// `await using` auto-revokes on scope exit (try/finally replacement).
await using work = participant.intents.writing(slide, { ttl: '3m' });

// Observe what peers are claiming.
for await (const openIntents of participant.intents) {
  if (openIntents.some((i) => i.target.id === slide.id)) wait();
}
```

**Deltas** — firehose of every mutation on the wire:

```ts
for await (const delta of participant.deltas) {
  if (delta.modelName === 'Clause' && delta.actionType === 'U') {
    rerenderClause(delta.modelId);
  }
}
```

Callback form (`participant.onDelta`) stays available; the async-iterable form integrates with `break`, `AbortSignal`, `Array.from`, and every other async-iterator primitive JavaScript already knows.

## Admin surface

For tenant UIs and compliance flows. The 80% developer path never touches these.

```ts
// Roles — human permission templates
await mesh.roles.create({ name: 'Senior Analyst', write: ['decks', 'slides'] });

// Members — user <-> org <-> role bindings
await mesh.members.create({
  userId, organizationId, roleId,
  scope: { datarooms: [dataroomId] },
});

// Audit — append-only log, queryable for compliance export
const { data } = await mesh.audit.list({
  action: 'join',
  since: new Date(Date.now() - 86400000).toISOString(),
});

// Capabilities — raw Biscuit tokens, escape hatch for external
// identity systems. 99% of customers never call this directly.
await mesh.capabilities.create({
  allowedSyncGroups: ['deck:abc'],
  allowedOperations: ['slides.create', 'slides.update'],
  ttlSeconds: 1800,
});
```

Each resource follows the same five verbs: `.create`, `.retrieve`, `.list`, `.update`, `.del`.

## API reference

### Top-level

| | |
|---|---|
| `createMesh(opts)` | Returns an `AbloClient`. |
| `mesh.schema` | The schema passed into `createMesh`. |
| `mesh.join(agent, opts)` | Join an agent to the mesh. Returns a `MeshParticipant`. |
| `mesh.describeJoin(agent, opts)` | Pure dry-run of `join` — derives sync groups, TTL, participant id without network. |
| `mesh.roles` | `Resource<Role>` — admin RBAC templates. |
| `mesh.members` | `Resource<Member>` — role bindings. |
| `mesh.audit` | Read-only audit log. |
| `mesh.capabilities` | Raw Biscuit token resource. |

### `MeshParticipant`

| | |
|---|---|
| `.agent` | The original agent you passed to `join`, untouched. |
| `.id` | Participant id (from the agent's `id` field). |
| `.capabilityToken` | Biscuit capability token (advanced integration only). |
| `.onBehalfOf` | The current ceiling principal, or `null` when API key is the ceiling. |
| `.ttlSecondsRemaining` | Seconds left before the token expires. |
| `.connect()` / `.disconnect()` | WebSocket lifecycle. |
| `.join(child, opts)` | Recursive spawn — child attenuates from this participant. |
| `.context.capture(entities)` | Snapshot a watermark for subsequent writes. |
| `.presence` | Opt-in advisory coordination. |
| `.intents` | Opt-in cooperative mutex. |

### Typed errors

Every error thrown from the mesh SDK extends `AbloError` and carries a stable `code` for telemetry:

| Class | Thrown when |
|---|---|
| `AbloValidationError` | Invalid scope, missing schema field, strict policy violation. |
| `AbloAuthenticationError` | API key invalid, session expired, token rejected. |
| `AbloPermissionError` | Capability caveat denied the action. |
| `AbloIdempotencyError` | Same idempotency key with different body. |
| `AbloRateLimitError` | 429 from the server. |
| `AbloConnectionError` | Network / transport failure. |
| `AbloServerError` | 5xx from the server. |

All are re-exported from `@ablo/sync-engine`.

## License

See `LICENSE` at the package root.
