# Mesh — `createMesh` + `mesh.join`

Run multiple agents on one live entity without stomping each other. The mesh layer turns any agent-like object into a live sync-mesh participant — capability-scoped, presence-aware, watermark-safe. Ablo owns mesh participation, capability tokens, permission ceilings, and write honesty. Tools, skills, prompts, models, agent orchestration stay in your code.

## Install & wire

```typescript
import { createMesh } from '@ablo/sync-engine/mesh';
import { defineSchema, mutable, z } from '@ablo/sync-engine/schema';

const schema = defineSchema({
  matters:   mutable.lazy({ name: z.string() }, { syncGroupFormat: 'matter:{id}' }),
  documents: mutable.lazy({ title: z.string() }, { parent: schema.models.matters }),
  redlines:  mutable.lazy({ body: z.string() },  { parent: schema.models.documents }),
});

const mesh = createMesh({
  schema,
  serverUrl: 'https://mesh.ablo.finance',
  organizationId: 'org_legora',
  apiKey: process.env.ABLO_API_KEY!,
});
```

`createMesh` is a thin client. It doesn't launch agents, pick models, or hold prompts — it mints capability tokens and wires agents into the sync stream.

## `mesh.join` — the one primitive

```typescript
const researcher = { id: 'researcher-q3-1', label: 'Q3 due diligence' };

const participant = await mesh.join(researcher, {
  scope: [{ entity: schema.models.matters, ids: ['techco-acquisition'] }],
});

await participant.connect();
```

`mesh.join(agent, opts)` does four things:

1. Derives `allowedSyncGroups` from the scope entries (each entity's `syncGroupFormat` template is expanded per id).
2. Mints a Biscuit capability token against `POST /api/auth/capability`.
3. Hands back a `MeshParticipant<A>` that holds the original `agent` object by reference (unchanged) plus the sync-engine wiring.
4. `participant.connect()` opens the WebSocket.

The ceiling is cryptographic. Widening a token is not expressible — anything the agent tries to do beyond its scope is rejected at the server's Biscuit verify step.

## Principals (`onBehalfOf`) — delegation chains

Every `mesh.join` inherits its authority ceiling from a principal:

```typescript
// API-key ceiling (background workers, batch jobs)
await mesh.join(agent, { scope: [{ entity, ids: [id] }] });

// Session ceiling (browser-initiated agent, scoped to the signed-in user)
await mesh.join(agent, {
  scope: [{ entity, ids: [id] }],
  onBehalfOf: { kind: 'session' },
});

// Agent ceiling (child agent attenuates from a parent capability)
await parent.join(childAgent, {
  scope: [{ entity, ids: [id] }],
});
```

The default delegation policy is `'strict'`: when `onBehalfOf` is set but `scope` is omitted, `mesh.join` throws `AbloValidationError(mesh_delegation_scope_required)`. Pass `delegationPolicy: 'permissive'` on `createMesh` to allow silent inheritance of the principal's full ceiling. Strict is the right default — it makes delegation explicit.

## What you get on a participant

```typescript
participant.agent            // your original agent object, unchanged
participant.id               // participant id (auto-minted if agent.id absent)
participant.capabilityToken  // the Biscuit, for raw forwarding
participant.ttlSecondsRemaining

// Mutations — batch-always
await participant.create('matters',  [{ name: 'Acme' }]);
await participant.update('matters',  [{ id, name: 'Acme Inc' }]);
await participant.del('matters',     [id]);
await participant.archive('matters', [id]);

// Recursive join — child attenuates from this participant's token
const child = await participant.join(childAgent, { scope: [...] });
```

## Presence — "what is everyone doing right now"

Every participant broadcasts a presence frame on the WebSocket. Every other participant observes the stream reactively — an agent's system prompt can literally include `presence.others` so the model reasons with awareness of what other agents are doing *right now*.

```typescript
const { self, others, othersIn, update } = participant.presence;

update({ entityType: 'Matter', entityId: 'acme-q3', action: 'reading' });

const peers = othersIn('matter:acme-q3');  // only peers in this sync group
```

## Intents — "I'm about to rewrite slide 5"

Cooperative mutex. Announced, not enforced. Other agents see the intent and yield (or pick a different slide, or queue behind it). Composes with presence.

```typescript
const handle = participant.intents.announce({
  target: { type: 'Slide', id: 'slide-5' },
  reason: 'rewriting',
  ttlSeconds: 30,
});

try {
  await participant.update('slides', [{ id: 'slide-5', body: newBody }]);
} finally {
  handle.revoke();
}

// Read everyone else's open intents
const openIntents = participant.intents.others;
```

## Context watermarks — write honesty against a moving world

Before an LLM starts reasoning, snapshot the entities the prompt will reference. The snapshot carries a watermark (the sync engine's current `lastSyncId`) that flows into every write the LLM's tools emit. If the world moved during generation, the write rejects with a typed stale error instead of silently overwriting.

```typescript
const ctx = await participant.context.capture({
  entities: [
    { type: 'matters', ids: ['techco-acquisition'] },
    { type: 'documents', where: { matterId: 'techco-acquisition' } },
  ],
});

// Plug ctx.data into your system prompt; ctx.watermark flows into writes.
const unsub = ctx.onChange((change) => {
  // fire your AbortSignal so the mid-generation LLM call cancels
  abortController.abort();
});

await generateWithLLM({ signal: abortController.signal, context: ctx.data });
unsub();
```

## Admin resources

For tenant UIs and compliance flows. Every resource follows a Stripe-shaped `create / retrieve / list / update / del` contract.

```typescript
// Roles — permission templates for humans
await mesh.roles.create({ name: 'research-bot', read: [...], write: [...] });
const roles = await mesh.roles.list();

// Members — user ↔ org ↔ role bindings
await mesh.members.create({ userId, organizationId, roleId, scope: [...] });

// Audit — append-only capability + mutation log
const page = await mesh.audit.list({ principal: 'user_123', limit: 50 });

// Capabilities — raw Biscuit mint for external integrations
const cap = await mesh.capabilities.create({
  allowedSyncGroups: ['matter:acme-q3'],
  ttlSeconds: 3600,
});
await mesh.capabilities.del(cap.id);  // revoke
```

Server endpoints for `roles`, `members`, and `audit` are on the migration roadmap — the SDK surface is stable; methods throw `AbloError(mesh_not_implemented)` when the endpoint isn't live yet.

## When to use mesh vs plain `SyncAgent`

| Use | Pattern |
|-----|---------|
| Long-lived background worker, always-on | `new SyncAgent({ url, capabilityToken, … })` directly |
| Per-request / short-lived agent spawned from a user action | `mesh.join(agent, opts)` — token minted per join, scoped per request |
| Child agent delegating from a parent | `parent.join(childAgent, opts)` — attenuation chain |
| Browser agent (session-bound) | `mesh.join(agent, { onBehalfOf: { kind: 'session' }, … })` |

The mesh is the right answer any time the lifecycle is shorter than a process. Capability minting, scope derivation, presence wiring, and intent streams are all handled.
