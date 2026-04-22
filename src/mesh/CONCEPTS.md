# Mesh concepts

Read this once. Every line of code after this makes sense.

## One noun: Participant

A **participant** is anything that joins the mesh and does stuff. There is no separate "user" or "agent" type. They're both participants.

```
┌─────────────────┐
│   Participant   │  ← your user in a browser tab
└─────────────────┘
┌─────────────────┐
│   Participant   │  ← an AI agent running in a worker
└─────────────────┘
┌─────────────────┐
│   Participant   │  ← a scheduled job polling every hour
└─────────────────┘
```

Every participant has the same API surface. You cannot tell from the code whether you're writing for a human, an agent, or a cron job — and you shouldn't have to.

```ts
participant.presence.update(...)     // same for every kind
participant.intents.announce(...)    // same for every kind
participant.create(...)              // same for every kind
participant.refresh()                // same for every kind
```

This is the agent-first frame: the mesh doesn't privilege humans. Humans are just participants that happen to have a browser and a cookie.

## How a participant is born

`mesh.join(agent, options)` mints a capability, opens a WebSocket, and returns the live handle.

```ts
const participant = await mesh.join(
  { label: 'Q3 Deal Review' }, // id auto-generated
  {
    scope: [{ entity: schema.models.matters, ids: 'acme-acquisition' }],
    onBehalfOf: session({ id, userId, organizationId }),
  },
);
await participant.connect();
```

Three inputs. That's the only complexity you add.

- **`agent`** — who is this participant. Just an id + label. No magic.
- **`scope`** — what this participant can see + act on. Entity references, type-safe via the schema.
- **`onBehalfOf`** — the authentication. A browser passes a session; a backend agent uses an API key or a capability token. The mesh figures out the right HTTP auth from the shape.

## The four things a participant does

Every participant has exactly four surfaces. No more, no fewer.

### 1. Presence — "here's what I'm doing right now"
```ts
participant.presence.update({
  entityType: 'Slide',
  entityId: 's-5',
  action: 'editing',
});
```
Ephemeral. Fire-and-forget. Broadcast to peers in overlapping scope.

### 2. Intents — "I'm about to change X"
```ts
const intent = participant.intents.announce({
  target: { type: 'Slide', id: 's-5' },
  reason: 'rewriting title from prompt',
});
// ... do the work ...
intent.revoke(); // or let TTL expire
```
Cooperative. Other participants see the claim and can choose to wait, defer, or proceed. Not a lock.

### 3. Data — "I'm changing X"
```ts
await participant.create('Slide', [{ id: 's-6', deckId: 'd-1', title: 'New slide' }]);
await participant.update('Slide', [{ id: 's-5', title: 'Updated' }]);
await participant.delete('Slide', ['s-4']);
```
Committed changes. Ride the sync engine's delta stream. Idempotent via client-tx-ids.

### 4. Observation — "tell me what's happening"
```ts
participant.presence.others          // reactive list of peers
participant.intents.others           // reactive list of peer claims
participant.onDelta((d) => { ... })  // data changes from other participants
```
Pull at read-time, or subscribe for push. Same shape for humans and agents.

## How participants see each other

Peer visibility is controlled by **sync groups** — subscription channels the server fans broadcasts across.

```
sync group: "deck:acme-q3"
  ├── participant A (user's browser)
  ├── participant B (user's other tab)
  └── participant C (agent that's reviewing)

sync group: "matter:acme-acquisition"
  ├── participant A (user's browser)
  └── participant D (legal-research agent)
```

When you pass a `scope` to `mesh.join(...)`, the SDK derives the sync groups from the entity references. Two participants whose sync groups overlap can see each other.

**Rule of thumb**: one participant per collaboration surface. A deck page joins with scope `[deck:X]`. A document page joins with scope `[document:Y]`. Navigation between pages unmounts the old participant and mints a new one.

In React, this maps naturally to the `key` prop:

```tsx
// deckId changes → React unmounts and remounts → new participant
<DeckEditor key={deckId} deckId={deckId} />
```

For cross-surface views (like a sidebar showing "everyone online in your org"), open a second participant with a broader scope.

## The agent-first frame

Three patterns show up over and over. Match your code to the closest one.

### Pattern A — user in a browser
```ts
// Runs inside a React component.
// Session cookie authenticates via `credentials: 'include'`.
const { participant, peers } = useParticipant({
  label: user.name,
  scope: { slideDecks: deckId },
  as: session({ id: session.id, userId: user.id, organizationId }),
});
```

### Pattern B — agent in a long-running worker
```ts
// Runs inside apps/agent-worker or a similar process.
// Capability token from the parent that spawned this job.
const participant = await mesh.join(
  { label: 'Deal review' },
  {
    scope: [{ entity: schema.models.matters, ids: matterId }],
    onBehalfOf: agent({ id: parentAgentId, capabilityToken: parentCap }),
  },
);
await participant.connect();
participant.autoRefresh(); // rotate token before TTL
// ... agent loop ...
```

### Pattern C — short-lived script or cron
```ts
// Runs inside a server action or a scheduled Lambda.
// API key authenticates directly.
const ablo = new Ablo({ schema }); // reads ABLO_API_KEY from env; org derived from key
const participant = await mesh.join(
  { label: 'Nightly finance report' },
  { scope: [{ entity: schema.models.organizations, ids: orgId }] },
);
await participant.connect();
// ... do work ...
await participant.disconnect();
```

Three patterns, one SDK. Presence / intents / data / observation behave identically across all three.

## Auth without thinking about auth

Three authentication modes, one call signature. The mesh detects which mode you're in from the shape of `onBehalfOf` and the surrounding config:

| `createMesh` config | `onBehalfOf` | Auth mode | Typical caller |
|---|---|---|---|
| No `apiKey` | `session({...})` | Session cookie via `credentials: 'include'` | Browser |
| `apiKey: 'sk_...'` | None | API key in Bearer header | Backend cron |
| `apiKey: 'sk_...'` | `agent({ id, capabilityToken })` | Capability token (attenuated) | Spawned sub-agent |

You don't choose. You just pass the one that fits and the mesh picks the right header.

## What changes across re-mints, reconnects, and refreshes

The participant reference is stable. You keep the same handle; the mesh rotates credentials, reconnects sockets, and replays missed deltas behind the scenes.

- `participant.refresh()` — mint a new capability, swap onto the live socket. Same handle.
- `participant.autoRefresh()` — schedule `refresh` to fire before expiry. Same handle.
- WebSocket drops + reconnects — the mesh replays missed deltas via the lastSyncId protocol. Same handle.
- Offline writes — the SDK queues mutations and flushes on reconnect. Same handle.

This is the difference between a toolkit and a framework: the caller doesn't thread lifecycle through their code.

## What the mesh is NOT

- **Not an agent runtime.** Tools, skills, prompts, models, orchestration — your code.
- **Not a data API.** For queries, joins, and indexes, use the sync engine's data surface (`@ablo/sync-engine/client`). The mesh is about the coordination layer on top.
- **Not a chat protocol.** Presence + intents are for coordinating mutations, not for streaming LLM tokens.
- **Not a permission system.** Scopes are coarse-grained capability envelopes. Fine-grained (field-level, role-based) belongs in your app's policy layer.

## Five things to remember

1. **Participants are the only noun.** Users, agents, scripts — all the same API.
2. **One participant per surface.** Deck page, document page, sidebar — each gets its own.
3. **`scope` is what you see.** Sync groups overlap → participants see each other.
4. **`onBehalfOf` is how you auth.** Session, agent, or implicit API key — pick the shape, the mesh picks the header.
5. **The handle is stable.** Refreshes, reconnects, and offline flushes happen under the same reference.

That's the whole model. Everything else is API ergonomics.
