# Sessions

A **session** is a short-lived credential your backend mints with its `sk_` and
hands to one actor — a signed-in **person's browser** or a scoped **agent**. It's
the same primitive in both cases (backend-minted, short-lived, scoped); the only
difference is the subject and how much authority it carries.

One resource mints both:

```ts Your backend (sk_)
// A logged-in person's browser session — full authority within their org.
const userSession = await ablo.sessions.create({
  user: { id: currentUser.id },
});

// A scoped agent session — gated to exactly the operations you name.
const agentSession = await ablo.sessions.create({
  agent: { id: 'agent:task-writer' },
  can: { Task: ['read', 'update'], Deck: ['read'] },
});
```

`user` mints an `ek_` (ephemeral key); `agent` mints an `rk_` (restricted key).
You pass `user` **or** `agent` — never both.

It exists because of one rule: **the browser can never hold a secret.** Your
`sk_` lives on the server; the browser only ever holds a minted session token
(which already names your org). So the per-actor credential is minted
server-side, scoped, and expires in minutes — the model Stripe uses for
client-side SDKs.

## Why

Ablo doesn't authenticate your users — you do, however you like (your own
sessions, an IdP, anything). Ablo authenticates your **project** (the `sk_` that
minted the session) and trusts the identity you asserted at mint time. The
session token *is* that assertion: "this connection is acting as `U`, in org
`O`, until it expires."

## End-user sessions (`ek_`)

For a logged-in person using your app. Mint on a backend route that has already
authenticated the user:

```ts Your backend route (session-authed)
const { token } = await ablo.sessions.create({
  user: { id: currentUser.id },   // who the session acts as
  // syncGroups: [...],           // optional; defaults to the user's org + user
});
return Response.json({ token });  // return ONLY the token to the browser
```

A user session has **full data authority** within its org — no operation
allowlist. It's the human acting as themselves.

Build a browser `Ablo` client whose `getToken` fetches from that route, and pass
the **instance** to [`<AbloProvider>`](/react). The client fetches the token,
opens the connection, and re-mints before expiry — your app writes no token
plumbing:

```tsx
'use client';

import Ablo from '@abloatai/ablo';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo.schema';

const ablo = Ablo({
  schema,
  getToken: () =>
    fetch('/api/ablo-session', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => d.token),
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider client={ablo}>{children}</AbloProvider>;
}
```

The client owns auth, the credential lifecycle, and the connection; the provider
is the thin reactive binding over it (Stripe's `<Elements stripe={...}>` model).
Build the client **once** at module scope — a new instance per render tears down
the socket. `authEndpoint: '/api/ablo-session'` is accepted as sugar for the
`getToken` fetch above if you prefer a URL.

## Agent sessions (`rk_`)

For a non-human actor — an agent or automation that should only do **specific**
operations. The `can` map is the permission boundary, and it's **typed against
your schema** — the model keys are your schema's models, so a typo is a compile
error, not a silent over-grant:

```ts
const session = await ablo.sessions.create({
  agent: { id: 'agent:task-writer' },
  can: { Task: ['read', 'update'] },  // typed off the schema — no magic strings
  ttlSeconds: 600,
});

const agent = Ablo({ schema, apiKey: session.token }); // the agent's scoped client
```

`can: { Task: ['update'] }` serializes to the wire allowlist `task.update`; the
server rejects any commit whose operation isn't listed. Operations are
`'read' | 'create' | 'update' | 'delete'`.

<Note>
Use `sessions.create({ agent })` to mint a scoped agent credential, then write
with `ablo.<model>.update(...)` / `ablo.commits.create(...)` under a `claim`.
This is the path for custom runtimes, MCP sessions, and protocol-level integrations.
</Note>

## Mint

Only a **secret key** (`sk_`) can mint a session — never another session token.
The `sk_` is the trust anchor; minting is your backend vouching
for the actor.

| Param | For | Meaning |
|---|---|---|
| `user` / `agent` | both | The actor. `id` becomes the token's `participantId`. Pass exactly one. |
| `can` | agent | Per-model operation allowlist, typed off the schema. |
| `syncGroups` | both | Narrow the session below its default scope. Omit to inherit. |
| `ttlSeconds` | both | Lifetime in seconds. Defaults to `900` (15m). |
| `userMeta` | both | Opaque identity blob echoed back to the client. |

## Lifecycle

Sessions are **short-lived by design** (~15 minutes) and, for browsers,
**auto-refreshed** — the provider re-mints ahead of expiry, so a session never
drops at the boundary. A revoked or signed-out actor simply stops getting a fresh
token; the old one expires on its own. There's nothing to revoke by hand.

### Offline & sign-out

The short session token is **not** your user's login — it's a minutes-long
credential layered on top of whatever long-lived auth your `authEndpoint`
already enforces (your own session cookie, an IdP, etc.). The provider keeps
those two lifetimes separate, which means:

- **Going offline never signs the user out.** The provider keeps working from
  its local cache and treats a failed re-mint (no network, a timeout, a `5xx`
  from your endpoint) as **transient** — it retries, and re-mints the instant
  connectivity or tab focus returns. The user stays signed in for as long as
  your underlying session is valid, however brief or long the network drop.
- **The user is signed out only when the underlying session is genuinely
  rejected** — i.e. your `authEndpoint` responds **`401`/`403`** because the
  cookie (or IdP session) is missing, expired, or revoked. That's the one
  signal the provider treats as terminal.

This mirrors the OAuth refresh-token rule (Okta/Auth0/Authgear): only a
rejection of the *long-lived* credential ends the session — a network failure
never does.

<Note>
Your `authEndpoint` contract follows from this: return the token on success,
respond **`401`/`403`** only when the user's session is actually gone, and let
network/`5xx` failures surface as errors. Don't collapse "can't reach the mint
endpoint" into "session expired" — returning a `401` for a transient blip will
bounce a still-valid user to your sign-in page.
</Note>

## Scope

A user session carries the user's **base** sync-groups (`org:`/`user:`/`team:`),
derived from the identity you minted it for. **Dynamic, relation-driven
membership** (e.g. a `dataroom:<id>` the user was just added to) is resolved
**server-side at connect** and unioned on top — so scope stays live, not frozen
at mint time. Pass `syncGroups` only when you want to *narrow* below the default.

## Your schema, your users (the default)

Your schema lives in a **project** — you push it once (`npx ablo push`) and every
session you mint resolves against it. The flow for serving end-users:

1. **Push your schema** to your project.
2. **Mint an `ek_` per user** — `sessions.create({ user: { id } })`. Your users
   commit to that one schema.

**Your users do not have Ablo accounts.** You authenticate them however you
already do; your server's `sk_` mints the `ek_`. By default the session lands in
your project's own org, so all your users share one schema and one data tenant,
isolated from each other by sync-groups. For most apps (the Cursor shape) that's
the whole story — nothing below is needed.

## Org-per-customer isolation (the add-on)

Some apps need each customer to be its **own** tenant — a hard data boundary
(separate row-level isolation, optionally a separate database), not just per-user
scoping. The law-firm shape (Legora): every firm is its own org, many users
inside it.

The problem that creates: if each customer is a separate org, a naïve setup would
make you re-push your schema into every new customer's org. You don't have to.
Keep **one** project as the home of your schema, and point each customer's
session's *schema* at it while its *data* stays in the customer's own org:

```ts
const { token } = await mintUserSessionKey({
  apiKey: process.env.ABLO_PLATFORM_KEY, // sk_ with the ephemeral:mint-any-org scope
  userId,
  organizationId,                  // DATA → this customer's org (its own isolated tenant)
  schemaProject: {                 // SCHEMA → the project that owns your schema
    organizationId: schemaOwnerOrgId,
    projectId: schemaProjectId,
  },
  ttlSeconds: 3600,
});
```

Server-side the split is clean: the model **shape** loads from your schema
project, but column enrichment and the tenant connection target the customer's
`organizationId` — so the shared schema only *describes* the shape; the data
plane (connection + row-level isolation) stays the customer's. A shared schema
can't leak data across orgs.

<Note>
This requires a platform `sk_` carrying the `ephemeral:mint-any-org` scope —
only a trusted first-party key can mint a session into another org and bind its
schema to your project. Omit these fields and you get the default above: one
project, one schema, all your users.
</Note>

## Security

The whole safety argument is the short TTL: a session token leaked from a
browser (XSS) is valid for minutes, scoped to one actor's data, and can't mint
anything or touch the control plane. Contrast `sk_`, which would be a full org
compromise — which is exactly why it never leaves your server.

## User vs. agent sessions

| | User session (`ek_`) | Agent session (`rk_`) |
|---|---|---|
| For | a **person** in the browser | an **agent** / automation |
| Authority | full, within their org | narrow (explicit `can` allowlist) |
| Mint | `ablo.sessions.create({ user: { id } })` | `ablo.sessions.create({ agent: { id }, can })` |
| Lives where | the user's **browser** | the agent runtime |
