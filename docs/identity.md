# Identity & Sync Groups

This is the doc the Quickstart skips: **who is connecting, and which slice
of shared state do they get?** If you've wired `<AbloProvider client={ablo}>`
and wondered where org / team / user actually come from — start here.

## Ablo does not do auth

Ablo is not an identity provider. It has no login, no password store, no
session of its own. You keep whatever you already use — Clerk, Auth0,
NextAuth, WorkOS, your own session table. Ablo's job begins **after** you've
authenticated the user: you hand Ablo the already-authenticated identity, and
Ablo decides which **sync groups** that identity may read and write.

So the integration question is never "how do I log into Ablo?" It's: *"My app
already knows this request is user `U` in org `O`. How do I tell Ablo, so it
scopes their realtime data correctly?"* The rest of this doc answers exactly
that.

## What a sync group is

A **sync group** is a named channel of shared state — a string like
`org:acme` or `deck:abc123`. It is simultaneously:

- **the unit of fan-out** — a confirmed write to a row publishes a delta to
  every participant subscribed to that row's sync group(s), and
- **the unit of access** — a participant receives a row's deltas *only if* the
  row's sync group is in their allowed set.

There is no built-in `org` / `team` / `user` concept in the engine. Those are
*your* domain words. Ablo only knows sync-group strings. The mapping from "this
is user U in org O" to "they may subscribe to `org:acme` and `user:U`" is
something **you declare in your schema**. Here is that whole declaration in one
runnable place, so the concepts below have code to attach to.

## Declare it, end to end

The entire declaration surface is: `identityRoles` (who may see what), and on
each model `scope` / `parent` / `grants` (which group a row fans out on), plus
optional `syncGroups` at session-mint time (narrowing). Read the three blocks first —
a human gets their `org` / `team` scope, an agent gets one `deck` — then the
sections after explain each.

```ts
// 1. src/ablo/schema.ts — map identity → groups, and anchor each model to a group
import { defineSchema, identityRole, relation, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    // A scope root: its rows form the group `deck:<id>` (kind from `scope`).
    decks: model(
      { title: z.string(), status: z.enum(['draft', 'published']) },
      {},
      { orgScoped: true, scope: 'deck' },
    ),
    // A child: it has no group of its own; it inherits its deck's group via the
    // `parent` edge. A write to a slide reaches everyone viewing the deck.
    slides: model(
      { deckId: z.string() },
      { deck: relation.belongsTo('decks', 'deckId', { parent: true }) },
      { orgScoped: true },
    ),
  },
  {
    // Each role is pure data: a `kind` (the group prefix) and the identity
    // `source` field to read. No closures — so the schema stays JSON-serializable.
    identityRoles: [
      identityRole({ kind: 'org', source: 'organizationId' }),
      identityRole({ kind: 'user', source: 'userId' }),
      identityRole({ kind: 'team', source: 'teamIds', multi: true }),
    ],
  },
);
```

```tsx
// 2. app/providers.tsx — a HUMAN gets their full org / team scope.
// teamIds is set on the client you build (Ablo({ schema, teamIds: user.teamIds })),
// not passed to the provider; the provider just takes that client.
<AbloProvider client={ablo} userId={user.id}>
  {children}
</AbloProvider>
```

```ts
// 3. an AGENT run inherits its user, narrowed to the entities in play.
// You narrow at SESSION-MINT time: your backend calls `sessions.create` with the
// agent's allowed `syncGroups`, built from each model's scope via the
// `syncGroup(kind, id)` helper — never a hand-built `deck:<id>` string. The agent's
// runtime then connects with the minted token.
const session = await server.sessions.create({
  agent: { id: agentId },
  can: { Deck: ['read', 'update'] },
  syncGroups: [syncGroup('deck', deckId)], // floor: just the deck it's working on
});
// the agent runtime authenticates with the minted token
const ablo = Ablo({ schema, apiKey: session.token });
```

That's the whole surface. The rest of this doc is the *why* behind each line.

## Two kinds of group — the whole mental model

You just saw a human get `org` / `team` groups and an agent get one `deck`
group. That split is the model. Every sync group is named after one of two
things:

- **Membership groups** — named after *who you are*: `org:{id}`, `team:{id}`,
  `user:{id}`. Produced from **identity** (`identityRoles`, Half 1). They're
  standing and durable — they don't change as you work.
- **Entity groups** — named after *a thing*: `dataroom:{id}`, `deck:{id}`,
  `slide:{id}`. Produced from a **row's id** (a model's entity scope, Half 2).
  They're granular — one per record — and any participant can be pointed at a
  specific set of them.

Humans and agents fill that same space differently, and you declare the two in
different places. A human's groups come from who they are, so you declare them
once in the schema. An agent's groups come from what it's working on right now,
so you pass them in code when you start the run.

| | Subscribed by | Declared where | Gets |
| --- | --- | --- | --- |
| **Human** | *who they are* — membership | **the schema** (`identityRoles`) — a rule, written once | every `org` / `team` / `user` group their identity implies — their whole standing world |
| **Agent** | *what it's been given* — entities | **code, at the spawn site** — chosen per run | a handful of entity groups: the dataroom it's in, the slides it has read — never beyond what its user's membership could reach |

> **One line:** humans subscribe by who they are; agents subscribe by what
> they've been given.

That's why you never write per-user scope code, but you always choose an agent's
groups at the dispatch site. A user's org/team/user don't change per request, so
their scope is a **rule the schema derives automatically**. An agent's reach
depends on *what it's working on*, which is only knowable at dispatch — so you
pass its `syncGroups` **when your backend mints the agent session**
(`sessions.create({ agent, can, syncGroups })`). The schema's
only job for entities is to declare *that* a model is
entity-scopable and *what its group is named* (`scope: 'deck'` → `deck:{id}`);
it never declares *which* entities a given agent gets. (A human can opt into the
same runtime narrowing — a page scoped to one deck — but by default a human's
scope is fully schema-derived.)

So an agent doesn't need a `user:{id}` standing grant. It's a participant pointed
at a few entity groups, bounded above by its triggering user's membership. That
boundary is the whole safety story, and it's covered in
[Agents are participants too](#agents-are-participants-too).

```txt
your auth → identity { kind, userId|agentId, organizationId, teamIds }
          → identityRoles (schema) → allowed sync groups
          → participant receives deltas for rows in those groups
```

The identity is a **participant** — and a participant is either a human
(`kind: 'user'`) or an agent (`kind: 'agent'`). Same shape, same path; see
[Agents are participants too](#agents-are-participants-too) below. Everything in
the next two sections applies to both.

## The two halves of scoping

Scoping is two declarations that meet in the middle. One describes the
**participant** (what may I subscribe to?), the other describes each **row**
(which group does this row belong to?). A participant sees a row **iff** the
row's sync group is in the participant's allowed set.

### Half 1 — `identityRoles`: identity → allowed groups

Declared once, on the schema, via the `identityRole({ kind, source })` factory.
Each role is **pure data**: a `kind` (the group's prefix — `org`, `user`, `team`)
and the `source` — the identity field to read. The engine reads `source` off the
identity *you* supply and mints `<kind>:<value>` for each value, building the
participant's allowed set. There is no hardcoded `org:` / `user:` anywhere in the
engine — the kinds and sources are entirely yours.

```ts
// src/ablo/schema.ts
import { defineSchema, identityRole, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    decks: model({
      title: z.string(),
      status: z.enum(['draft', 'published']),
    }),
  },
  {
    identityRoles: [
      identityRole({ kind: 'org', source: 'organizationId' }),
      identityRole({ kind: 'user', source: 'userId' }),
      // `multi: true` reads an array field — one `team:<id>` group per id.
      identityRole({ kind: 'team', source: 'teamIds', multi: true }),
    ],
  },
);
```

The identity these `source` fields read is what your app resolves from its own
auth — Ablo never invents it. Roles are pure data (no closures) on purpose: a
`Schema` stays JSON-serializable end to end, so the same declaration works
in-process and on a hosted server that only ever sees the compiled JSON.

> **Single field per role.** `source` reads one field. An agent doesn't need its
> own role: it runs on behalf of a user and carries that user's `userId`, so the
> `user:{id}` role above already covers it — see
> [Agents are participants too](#agents-are-participants-too).

### Half 2 — per-model scope: row → group

You never write a sync-group string for a row. You declare a model's *place* in
the entity graph and the engine derives the groups its rows fan out on. Three
declarations, in order of how often you reach for them:

**`scope` — this model is a scope root.** Its rows form a group of their own.
The kind comes from the model's `typename` by default, or pass a string to set
it explicitly (use the string form when the wire kind differs from the typename,
e.g. typename `SlideDeck` but group `deck:<id>`):

```ts
decks: model({ title: z.string() }, {}, { orgScoped: true, scope: 'deck' });
// a deck row → group `deck:<id>`
```

**`parent` — this row lives inside another entity.** Mark the `belongsTo` edge
to its owner; the row inherits that owner's group. This is the Zanzibar/ReBAC
*parent* relation — "access inherits from parent" — and it chains transitively
(a layer → its slide → its deck), so a write to any descendant reaches everyone
viewing the root. A *reference* (a provenance/template pointer, not ownership)
must **not** be marked `parent`, or the row would leak into an unrelated scope:

```ts
slides: model(
  { deckId: z.string(), sourceSlideId: z.string().optional() },
  {
    deck: relation.belongsTo('decks', 'deckId', { parent: true }),  // ownership → inherit deck:<id>
    sourceSlide: relation.belongsTo('slides', 'sourceSlideId'),     // reference → NOT routed
  },
  { orgScoped: true },
);
```

> **Declare the parent edge — don't infer it.** Optionality is not a proxy for
> ownership: many `parent` FKs are optional (a root folder, an inbox task), and
> some required FKs are mere references. Containment is a fact only you know, so
> it's declared, exactly as it is in OpenFGA/Zanzibar.

**`grants` — a membership edge.** On a join model (e.g. `dataroomMember`), it
says "this row grants a *subject* access to a *scope root*." Both are relation
names on the model. The server resolves it at connect time — for user `U`, it
finds the scope-root groups `U` is a member of and adds them to `U`'s allowed
set (Linear's `/sync/user_sync_groups`). Use this for sub-org sharing; plain
org membership is already covered by the `org:` identity role.

```ts
dataroomMember: model(
  { userId: z.string(), dataroomId: z.string() },
  {
    member: relation.belongsTo('users', 'userId'),
    room: relation.belongsTo('datarooms', 'dataroomId'),
  },
  { orgScoped: true, grants: { subject: 'member', scope: 'room' } },
);
```

For the rare group keyed on a plain field rather than a relation (per-recipient
inbox fan-out, say), there's an `entityRoles: [entityRole({ kind, source })]`
escape hatch. For rows that inherit *tenancy* (not a sync group) through a
foreign key without carrying `organization_id`, use `scopedVia` rather than
`orgScoped: false` — the latter exposes the whole table cross-tenant. See
`packages/sync-engine/src/schema/model.ts` for the full option set.

## How identity reaches Ablo — the proxy model

This is the part the README's "authenticates with the signed-in user's
session" glossed over. Concretely:

1. **Your `ABLO_API_KEY` lives only on your trusted server**, scoped to your
   account. It signs your app's relationship with Ablo. It must never reach a
   browser bundle — treat it like a Stripe secret key.
2. **Your server authenticates the user with your own system.** That's the
   request that knows "this is user `U`, org `O`, teams `[...]`".
3. **Your server hands that authenticated identity to Ablo**, and the browser
   talks to the realtime plane as an already-scoped participant. The browser
   never holds the API key and cannot widen its own scope — the security
   boundary is the identity your **server** vouched for, not anything the client
   asserts.
4. **Ablo runs your `identityRoles` over that identity** to compute the allowed
   sync groups, and the participant subscribes to exactly that set.

The Ablo web app (`apps/web`) is the reference implementation of this shape:
its server resolves the signed-in user and active organization from its own
auth, and the sync layer composes the participant's sync groups from that
resolved identity — the API key stays server-side throughout. The generic,
library-agnostic name for "my server tells Ablo which of my users is acting" is
the `Ablo-Acting-User` request dimension; the web app realizes it through its
own session, but the contract is the same: **identity is asserted by your
server, never by the browser.**

> **Why the proxy, not a client API key?** A browser is a hostile runtime. If
> the client could name its own org or sync groups, any user could read another
> tenant's data by editing a request. By keeping the API key server-side and
> deriving scope from the identity your server already authenticated, the trust
> boundary lands in the one place you control. This is the same reason
> Liveblocks resolves scope in `prepareSession` and Stripe mints ephemeral keys
> server-side.

## Wiring the provider

The identity your server resolved is carried by the client you build and the
`userId` prop. In a Next.js app, resolve the user in a Server Component and pass
it down. Build the client once (the schema, `teamIds`, and the `apiKey` resolver
live here; entity narrowing rides the minted session's `syncGroups`), then hand
it to the provider:

```ts
// lib/ablo.ts
import Ablo from '@abloatai/ablo';
import { schema } from '@/ablo/schema';

// Build the client from the identity your server already resolved.
// teamIds → team sync groups via identityRoles.
export function makeAblo(user: { teamIds: string[] }) {
  return Ablo({
    schema,
    // The browser holds no secret — the `apiKey` resolver fetches the
    // short-lived session token your `/api/ablo-session` route minted, and the
    // client keeps it fresh before expiry.
    apiKey: () => fetch('/api/ablo-session').then((r) => r.text()),
    teamIds: user.teamIds,
  });
}
```

```tsx
// app/providers.tsx
'use client';

import { useMemo } from 'react';
import { AbloProvider } from '@abloatai/ablo/react';
import { makeAblo } from '@/lib/ablo';

export function Providers({
  children,
  user, // { id, teamIds } — resolved server-side from YOUR auth
}: {
  children: React.ReactNode;
  user: { id: string; teamIds: string[] };
}) {
  const ablo = useMemo(() => makeAblo(user), [user.id]);
  return (
    <AbloProvider client={ablo} userId={user.id} fallback={<AppSkeleton />}>
      {children}
    </AbloProvider>
  );
}
```

What carries identity — and just as importantly, what does *not* set the boundary:

| Where        | Purpose                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `userId` prop | App-level participant id, used for app-owned fields and read by your `identityRole` `source`. **Not** the security boundary — the server enforces scope from the authenticated request. |
| `teamIds` (on the client) | Team ids expanded into team sync groups via your `identityRoles`.                   |
| `syncGroups` (at session mint) | Optional. **Narrows** a minted session's subscription to a subset of what auth already allows — it can never widen it. Passed to `sessions.create({ user \| agent, syncGroups })`; build entries with `syncGroup(kind, id)`. Use it to scope an agent (or a focused page's session) to one entity, e.g. `[syncGroup('deck', 'abc123')]`. |

Because the server is the boundary, a client that changes `userId` to another
user's id does not gain their data — the server resolves and enforces the real
identity on the connection. These are how your app *tells* Ablo who it
already authenticated, not how it *proves* it.

## Agents are participants too

An agent and a human **authenticate through the exact same path** — same proxy,
same `identityRoles`, same server-enforced boundary. An agent is a participant;
the only data difference is that it carries `kind: 'agent'` and an `agentId`
where a human carries `userId`. There is no separate identity model to learn.

What differs is **authority, not identity** — and the distinction is the whole
point. An agent always runs *on behalf of* the user who set it off, so its
**ceiling is exactly that user's access**: the same conversations, messages, and
models the triggering user can reach, and nothing that user couldn't. But within
that ceiling it is **narrowed to the model instances it is touching, or has
touched** — never the user's whole org.

Scope is therefore an intersection:

```txt
agent authority = (triggering user's allowed set)    ← ceiling, inherited (on-behalf-of)
                ∩ (the model instances it touches)    ← floor, least privilege per run
```

Concretely: each model an agent edits declares a `scope`
([Half 2](#half-2--per-model-scope-row--group)), so each row forms its own
group. The agent subscribes only to the groups for the rows it touches. Declare
an entity anchor on the models an agent operates on:

```ts
// each scope-root model an agent edits forms a per-entity group
documents: model({ /* … */ }, {}, { orgScoped: true, scope: 'document' }),
decks:     model({ /* … */ }, {}, { orgScoped: true, scope: 'deck' }),
```

Then a run subscribes only to the entity groups for the rows it works on — a
subset of what its user could see:

```ts
// agent run triggered by `user`, working on one document + one deck.
// Your backend mints the agent session narrowed to just the entities in play
// (the floor). Build each group from the model's scope with `syncGroup(kind, id)`.
const session = await server.sessions.create({
  agent: { id: agentId },
  can: { Document: ['read', 'update'], Deck: ['read', 'update'] },
  syncGroups: [syncGroup('document', documentId), syncGroup('deck', deckId)],
});
// identity (the ceiling) is inherited from the triggering user via your
// session-mint logic; the agent runtime connects with the minted token.
const ablo = Ablo({ schema, apiKey: session.token });
```

As the run touches more entities, claim or read them and the client auto-enrolls
in their entity groups — its set **accretes** to cover them; it never
widens past the user's ceiling, and it carries no standing access to entities it
isn't working on. The `identityRoles` need no agent-specific entry: the agent
carries the triggering user's `userId`, so the same `user:{id}` role that scopes
a human already scopes the agent. Nothing about the *identity* declaration
branches on agent vs human.

`kind` is what attribution uses — not access. `kind: 'agent'` plus `agentId` is
connection metadata that tags every write with the executing agent **and** the
user it ran on behalf of, so audit answers "who did this, and on whose behalf."
It never appears in an `identityRole`, because it changes *who's accountable*,
not *what's reachable*.

Three rules make agent access safe, and they fall out of the model above rather
than needing a separate agent permission system:

- **Inherit the user, and no more** — the OAuth
  [on-behalf-of](https://workos.com/blog/oauth-on-behalf-of-ai-agents) model: the
  agent's reach is tied to the consenting user, never the org.
- **Least privilege, just-in-time** — scoped to the task's entities, not standing
  org-wide access (the over-privilege pattern
  [OWASP's NHI Top 10](https://www.token.security/assets/the-ultimate-non-human-identity-security-guide)
  flags as the dominant agent risk).
- **Dual-principal attribution** — record both the executing agent and the
  triggering human.

Identity is 1:1 with a human participant; authority is narrowed to the work. That
split is what lets Ablo keep *one model API for every actor* without ever
granting an agent standing access to everything its user can see. The agent that
runs the [Coordinating long agent work](../README.md#coordinating-long-agent-work)
`claim` loop is, to the scoping layer, that same participant — scoped to the row
it claimed.

## Narrowing to specific entities

A human gets their full membership automatically (`identityRoles`). There are
three ways to narrow a participant to specific entities — a page on one deck, or
an agent pointed at the entities it's working on. You **never hand-write**
`deck:<id>`; build groups from the model's `scope` (Half 2) with the typed
`syncGroup(kind, id)` helper from `@abloatai/ablo/schema`.

1. **At session mint — `syncGroups`.** When your backend mints a session, pass the
   exact groups it may subscribe to. This is the floor for a delegated agent (and
   the way to scope a focused page's session):

   ```ts
   // an agent working across two decks and a document
   const session = await server.sessions.create({
     agent: { id: agentId },
     can: { Deck: ['read', 'update'], Document: ['read'] },
     syncGroups: [
       syncGroup('deck', deckA),
       syncGroup('deck', deckB),
       syncGroup('document', docId),
     ],
   });
   const ablo = Ablo({ schema, apiKey: session.token });
   ```

2. **Automatically, on read or claim.** Reading a row (`retrieve`/`get`/
   `claim.state`) auto-enrolls the client in that row's entity group
   (**read-interest**), and `claim`-ing it pins a **write-intent** subscription.
   So an agent's reachable set **accretes** as it works — no extra subscribe call.

3. **Explicitly, for presence — `watch`.** To hold presence on a known set of rows
   and react to peers, use the WebSocket-only `ablo.<model>.watch(ids, { ttl })`
   (it returns a participant handle with `.peers`). See
   [Coordination](./coordination.md).

> **`scope` is the schema model option, not a client setting.** `scope: 'deck'`
> in `model(...)` declares a scope root ([Half 2](#half-2--per-model-scope-row--group)) —
> it names the group (`deck:<id>`) that the mechanisms above then subscribe to.
> There is no `Ablo({ scope })` constructor option. The lifecycle filter on
> [`list()`](./api.md#model-methods) is a separate axis named **`state`**
> (`'live' | 'archived' | 'all'`, GitHub's open/closed/all), precisely so it
> doesn't share the word.

> **Requested groups never grant.** At connect, the server intersects the session's
> `syncGroups` with what the identity is actually allowed (`requested ∩ allowed`).
> So `syncGroups` only ever *narrows* within a participant's ceiling — an agent
> can't reach a deck its capability doesn't already permit, no matter what it
> passes. Smaller bootstrap, less fan-out, same server-enforced boundary.

## How this compares — and the best practices it follows

Ablo's identity model is not novel; it's the convergent answer every serious
realtime / sync SDK arrived at. Knowing which industry pattern it *is* tells you
how to reason about it.

**Realtime authorization splits into two shapes.** Ablo is firmly in the first:

- **Server derives scope from authenticated identity** — the server decides what
  a participant may read/write and the client cannot override it. This is Ablo's
  proxy model. It's the same shape as
  [Supabase Realtime's RLS-on-connect](https://supabase.com/docs/guides/realtime/authorization)
  (policies evaluated at subscribe, cached for the connection),
  [Liveblocks **ID tokens**](https://liveblocks.io/docs/authentication) ("Liveblocks
  checks the permissions for you" — recommended for production), and
  [ElectricSQL **proxy auth**](https://electric-sql.com/docs/guides/auth) (a
  reverse-proxy sets shape params server-side before forwarding).
- **Client proposes, server authorizes the exact request** — the client names
  the room/shape and the server signs off, as in
  [Pusher's channel authorization endpoint](https://pusher.com/docs/channels/server_api/authorizing-users/),
  [ElectricSQL **gatekeeper auth**](https://github.com/electric-sql/electric/blob/main/examples/gatekeeper-auth/README.md),
  and Liveblocks **access tokens**. Ablo's session-mint `syncGroups` is the
  *narrowing* half of this — but it can only ever shrink the server-derived set,
  never grow it.

The best practices Ablo inherits from that lineage:

1. **The secret never reaches the client.** Your `ABLO_API_KEY` lives only on a
   trusted server — exactly as
   [Ably mandates](https://ably.com/docs/auth/token) ("never use API keys in
   client-side code; they don't expire, so once compromised they grant indefinite
   access") and
   [PowerSync's flow](https://docs.powersync.com/installation/authentication-setup/custom)
   (app auth → backend mints a signed token → client connects with the token).

2. **Trusted vs untrusted claims is the whole security argument.** PowerSync draws
   the line precisely: [token parameters are trusted and usable for access
   control; client parameters are not](https://docs.powersync.com/usage/sync-rules/advanced-topics/client-parameters).
   In Ablo terms, the identity your server vouches for — and the session's
   `syncGroups`, minted server-side — are the *trusted* claims that set scope; the
   `userId` prop is *untrusted client input* — convenient for app-owned fields, but
   never the boundary. This is why changing `userId` in the browser grants nothing.

3. **Scope by a hierarchical naming convention, declared once.** Ablo's `kind:id`
   group naming (`org:…` / `team:…` from `identityRoles`, `deck:…` from a model's
   `scope`) is the same idea as [Liveblocks' recommended room-id naming pattern](https://liveblocks.io/docs/authentication/access-token)
   (`org:*`, `org:group:*`) and [Ably's channel capabilities](https://ably.com/docs/auth/capabilities).
   Declaring the convention in one place — never composing scope strings in
   consumer code — is the practice all three enforce.

4. **Attribution and presence ride the authenticated identity.** Just as
   [Pusher attaches `channel_data` to presence at auth time](https://pusher.com/docs/channels/server_api/authorizing-users/),
   Ablo's participant identity (the one your server vouched for) is what powers
   presence and per-write attribution — not a value the client asserts after the
   fact.

The one practice that differs by deployment: short-lived, auto-refreshed bearer
tokens ([Ably](https://ably.com/docs/auth/token),
[Supabase's `access_token` refresh](https://supabase.com/docs/guides/realtime/authorization))
are the right shape when an untrusted client holds a credential directly. Ablo's
proxy model keeps the credential server-side instead, so token rotation is the
server's concern, not the browser's — the same trade ElectricSQL's proxy pattern
makes versus its gatekeeper tokens.

## See also

- [Integration Guide](./integration-guide.md) — `identityRoles`, backing modes, and the full app path.
- [React](./react.md) — the complete `<AbloProvider>` prop surface.
- [API Keys](./api-keys.md) — server-side keys for the public API.
