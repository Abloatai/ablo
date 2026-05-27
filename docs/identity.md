# Identity & Sync Groups

This is the doc the Quickstart skips: **who is connecting, and which slice
of shared state do they get?** If you've wired `<AbloProvider schema={schema}>`
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
something **you declare in your schema** — covered next.

### Two kinds of group — the whole mental model

Every sync group is named after one of two things, and that's the cleanest way
to hold the model in your head:

- **Membership groups** — named after *who you are*: `org:{id}`, `team:{id}`,
  `user:{id}`. Produced from **identity** (`identityRoles`, Half 1). They're
  standing and durable — they don't change as you work.
- **Entity groups** — named after *a thing*: `dataroom:{id}`, `deck:{id}`,
  `slide:{id}`. Produced from a **row's id** (a model's entity scope, Half 2).
  They're granular — one per record — and any participant can be pointed at a
  specific set of them.

Humans and agents fill that same space differently — and, crucially, the two
are **declared in different places**, because membership is static (a property of
identity) while entity scope is dynamic (a property of the task):

| | Subscribed by | Declared where | Gets |
| --- | --- | --- | --- |
| **Human** | *who they are* — membership | **the schema** (`identityRoles`) — a rule, written once | every `org` / `team` / `user` group their identity implies — their whole standing world |
| **Agent** | *what it's been given* — entities | **code, at the spawn site** — chosen per run | a handful of entity groups: the dataroom it's in, the slides it has read — never beyond what its user's membership could reach |

> **One line:** humans subscribe by who they are; agents subscribe by what
> they've been given.

The asymmetry is the point. A user's org/team/user don't change per request, so
their scope is a **rule the schema derives automatically** — you never write
per-user scope code. An agent's reach depends on *what it's working on*, which is
only knowable at dispatch — so you pass its `syncGroups` **at the call site, in
code**. The schema's only job for entities is to declare *that* a model is
entity-scopable and *what its group is named* (`entity: 'deck'` → `deck:{id}`);
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

## Declare it, end to end

The entire declaration surface is three things: `identityRoles` (who may see
what), `syncGroupFormat` (which group a row fans out on), and an optional
`syncGroups` prop (narrowing). Here they are in one runnable place — the sections
after this explain each.

```ts
// 1. src/ablo.schema.ts — map identity → groups, and anchor each model to a group
import { defineSchema, identityRole, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    conversations: model(
      { title: z.string(), createdBy: z.string() },
      {},
      { orgScoped: true, syncGroupFormat: 'conversation:{id}' },
    ),
    decks: model(
      { title: z.string(), status: z.enum(['draft', 'published']) },
      {},
      { orgScoped: true, syncGroupFormat: 'deck:{id}' },
    ),
  },
  {
    // Each role is pure data: a `template` and the identity `source` field to
    // read. No closures — so the schema stays JSON-serializable end to end.
    identityRoles: [
      identityRole({ kind: 'tenant', template: 'org:{id}', source: 'organizationId' }),
      identityRole({ kind: 'participant', template: 'user:{id}', source: 'userId' }),
      identityRole({ kind: 'membership', template: 'team:{id}', source: 'teamIds', multi: true }),
    ],
  },
);
```

```tsx
// 2. app/providers.tsx — a HUMAN gets their full org / team scope
<AbloProvider schema={schema} userId={user.id} teamIds={user.teamIds}>
  {children}
</AbloProvider>
```

```tsx
// 3. an AGENT run inherits its user, narrowed to the entities in play
<AbloProvider
  schema={schema}
  userId={user.id}                                                  // ceiling: the triggering user
  syncGroups={[`conversation:${conversationId}`, `deck:${deckId}`]} // floor: just its work
>
  {children}
</AbloProvider>
```

That's the whole surface. The rest of this doc is the *why* behind each line.

## The two halves of scoping

Scoping is two declarations that meet in the middle. One describes the
**participant** (what may I subscribe to?), the other describes each **row**
(which group does this row belong to?). A participant sees a row **iff** the
row's sync group is in the participant's allowed set.

### Half 1 — `identityRoles`: identity → allowed groups

Declared once, on the schema, via the `identityRole({ kind, template, source })`
factory. Each role is **pure data**: a `template` with a single `{id}`
placeholder, and the `source` — the identity field to read. The engine reads
`source` off the identity *you* supply and substitutes each value into the
`template` to build the participant's allowed set. There is no hardcoded `org:` /
`user:` anywhere in the engine — the templates and sources are entirely yours.

```ts
// src/ablo.schema.ts
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
      identityRole({ kind: 'tenant', template: 'org:{id}', source: 'organizationId' }),
      identityRole({ kind: 'participant', template: 'user:{id}', source: 'userId' }),
      // `multi: true` reads an array field — one team group per id.
      identityRole({ kind: 'membership', template: 'team:{id}', source: 'teamIds', multi: true }),
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

On each model's options, you declare how its rows are tenanted and which
sync-group label they fan out on.

```ts
model(
  { /* fields */ },
  { /* relations */ },
  {
    // Rows carry organization_id; bootstrap + fan-out filter on it.
    orgScoped: true,

    // Per-entity anchor. Lets a session narrow into ONE row's scope,
    // e.g. open a single deck: syncGroupFormat.replace('{id}', deckId).
    syncGroupFormat: 'deck:{id}',
  },
);
```

For rows that don't carry `organization_id` directly but inherit tenancy
through a foreign key, use `scopedVia` rather than `orgScoped: false` — the
latter exposes the whole table cross-tenant. See
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

The provider props carry the identity your server resolved. In a Next.js app,
resolve the user in a Server Component and pass it down:

```tsx
// app/providers.tsx — 'use client'
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo.schema';

export function Providers({
  children,
  user,            // { id, teamIds } — resolved server-side from YOUR auth
}: {
  children: React.ReactNode;
  user: { id: string; teamIds: string[] };
}) {
  return (
    <AbloProvider
      schema={schema}
      userId={user.id}
      teamIds={user.teamIds}
      fallback={<AppSkeleton />}
    >
      {children}
    </AbloProvider>
  );
}
```

What each identity-related prop does — and just as importantly, does *not* do:

| Prop         | Purpose                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `userId`     | App-level participant id, used for app-owned fields and read by your `identityRole` `source`. **Not** the security boundary — the server enforces scope from the authenticated request. |
| `teamIds`    | Team ids expanded into team sync groups via your `identityRoles`.                                |
| `syncGroups` | Optional. **Narrows** the subscription to a subset of what auth already allows — it can never widen it. Use it to scope a page to one entity (e.g. `['deck:abc123']`). |

Because the server is the boundary, a client that changes `userId` to another
user's id does not gain their data — the server resolves and enforces the real
identity on the connection. The props are how your app *tells* Ablo who it
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

Mechanically, this is the per-model anchor from
[Half 2](#half-2--per-model-scope-row--group) doing the work. Declare an entity
anchor on the models an agent operates on:

```ts
// a conversation and the deck an agent edits each get a per-entity group
conversations: model({ /* … */ }, {}, { syncGroupFormat: 'conversation:{id}' }),
decks:         model({ /* … */ }, {}, { syncGroupFormat: 'deck:{id}' }),
```

Then a run subscribes only to the entity groups for the rows it works on — a
subset of what its user could see:

```tsx
// agent run triggered by `user`, working on one conversation + one deck
<AbloProvider
  schema={schema}
  // identity inherited from the triggering user (the ceiling)
  userId={user.id}
  // authority narrowed to just the entities in play (the floor)
  syncGroups={[`conversation:${conversationId}`, `deck:${deckId}`]}
>
```

As the run touches more entities its set **accretes** to cover them; it never
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

This is deliberately the shape the 2025–2026 agent-identity consensus converged
on, expressed in Ablo's primitives rather than a bolted-on agent ACL:

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

## Narrowing to a single entity

For a page that should only sync one record, combine a per-entity
`syncGroupFormat` (Half 2) with the `syncGroups` prop:

```ts
// schema: decks fan out on deck:{id}
syncGroupFormat: 'deck:{id}'
```

```tsx
// page provider: subscribe to just this deck (still inside what auth allows)
<AbloProvider schema={schema} userId={user.id} syncGroups={[`deck:${deckId}`]}>
```

The participant now receives deltas for that one deck instead of the whole org
— smaller bootstrap, less fan-out — without weakening the server-enforced
boundary.

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
  and Liveblocks **access tokens**. Ablo's `syncGroups` prop is the *narrowing*
  half of this — but it can only ever shrink the server-derived set, never grow
  it.

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
   In Ablo terms, the identity your server vouches for is the *trusted* claim that
   sets scope; the provider's `userId` / `syncGroups` props are *untrusted client
   input* — convenient for app-owned fields and narrowing, but never the boundary.
   This is why changing `userId` in the browser grants nothing.

3. **Scope by a hierarchical naming convention, declared once.** Ablo's
   `identityRoles` templates (`org:{id}`, `team:{id}`, `deck:{id}`) are the same
   idea as [Liveblocks' recommended room-id naming pattern](https://liveblocks.io/docs/authentication/access-token)
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
