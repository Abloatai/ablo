# Sessions

> Short-lived scoped credentials your backend mints for a browser or an agent.

A **session** is a short-lived credential your backend mints with its `sk_` and
hands to one actor — a signed-in **person's browser** or a scoped **agent**. It's
the same primitive in both cases (backend-minted, short-lived, scoped); the only
difference is the subject and how much authority it carries.

One server-only issuer mints both. It is separate from `Ablo(...)` so the
participant client keeps every schema model name, including `ablo.sessions`:

```ts Your backend (sk_)
import Sessions from '@abloatai/ablo/sessions';

const sessions = Sessions({ schema, apiKey: process.env.ABLO_API_KEY });

// A logged-in person's browser session — only the operations this UI needs.
const userSession = await sessions.create({
  user: { id: currentUser.id },
  can: { records: ['read', 'update'], workspaces: ['read'] },
});

// An agent session — hand its rk_ to the agent runtime.
const agentSession = await sessions.create({
  agent: { id: crypto.randomUUID() },
  can: { records: ['read', 'update'], workspaces: ['read'] },
  userMeta: { name: 'record-writer' },
});
```

`sessions.create({ user, can })` mints an `ek_` (ephemeral key), while
`sessions.create({ agent, can })` mints an `rk_` (restricted key). There is one
issuance API; the subject selects the credential kind and attribution.

It exists because of one rule: **the browser can never hold a secret.** Your
`sk_` lives on the server; the browser only ever holds a minted session token
(which already names your org). So the per-actor credential is minted
server-side, scoped, and expires in minutes.

## Why

Ablo doesn't authenticate your users — you do, however you like (your own
sessions, an IdP, anything). Ablo authenticates your **project** (the `sk_` that
minted the session) and trusts the identity you asserted at mint time. The
session token *is* that assertion: "this connection is acting as `U`, in org
`O`, until it expires."

## End-user sessions (`ek_`)

For a logged-in person using your app. Mount a session handler on a backend
route and connect it to the authentication you already use:

```ts Your backend route (session-authed)
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { sessions } from '@/ablo/sessions';

export const POST = sessions.handler({
  async authenticate() {
    const session = await auth.api.getSession({ headers: await headers() });
    return session?.user ?? null;
  },
  async grant({ principal: user }) {
    const membership = await findActiveMembership(user.id);
    if (!membership) return null;

    return {
      user: { id: user.id },
      groups: [`workspace:${membership.workspaceId}`],
      can: { records: ['read', 'update'] },
    };
  },
});
```

`authenticate` adapts Better Auth (or any other auth system) to an application
principal. `grant` derives Ablo identity, groups, and permissions server-side.
Returning `null` from either step fails closed. The handler owns same-origin
checks, no-store responses, and the credential envelope; the application never
handles the token. `can` is required and cannot be empty.

Point a browser `Ablo` client's `session.endpoint` at that route, and pass
the **instance** to [`<AbloProvider>`](/react). The client fetches the token,
opens the connection, and re-mints before expiry — your app writes no token
plumbing:

```tsx
'use client';

import { Ablo } from '@abloatai/ablo/react';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo.schema';

const ablo = Ablo({
  schema,
  session: { endpoint: '/api/ablo-session' },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider client={ablo}>{children}</AbloProvider>;
}
```

The client owns auth, the credential lifecycle, and the connection; the provider
is only the thin reactive binding over it.
Build the client **once** at module scope — a new instance per render tears down
the socket. Need custom headers or a
body on the exchange? Pass an async `session` provider that performs the custom
request and returns its credential response.

## Agents (`rk_`)

For a non-human actor — an agent or automation that should only do **specific**
operations. The `can` map is the permission boundary, and it's **typed against
your schema** — the model keys are your schema's models, so a typo is a compile
error, not a silent over-grant:

The examples below reuse the server-only `sessions` issuer constructed above.

```ts
const session = await sessions.create({
  agent: { id: crypto.randomUUID() },
  can: { records: ['update'] },  // typed off the schema — no magic strings
  ttlSeconds: 600,
  userMeta: { name: 'record-writer' },
});

const agent = Ablo({ schema, session, transport: 'http' });
await agent.records.update({ id, data });
await agent.dispose();
```

The session is the credential; construct the agent client in the runtime that
will use it. A write grant automatically includes the corresponding read, so
`can: { records: ['update'] }` is enforced as `record.update` plus `record.read`.
Operations are `'read' | 'create' | 'update' | 'delete'`.

Give reusable access a domain name and keep it next to the worker that owns it:

```ts
const workerAccess = {
  records: ['update'],
} as const;

const session = await sessions.create({
  agent: { id: crypto.randomUUID() },
  can: workerAccess,
});
```

The SDK checks the model names and operations against the bound schema before
minting, and the server validates them again against the active pushed schema.

For a long-running agent, pass an async session provider. It re-mints the same
logical identity through the canonical resource; the client caches each result
until it approaches `expiresAt` and uses the replacement for HTTP requests and
WebSocket reconnects:

```ts
const session = () => sessions.create({
  agent: { id: stableWorkerId },
  can: workerAccess,
  groups: [workspaceGroup],
});

const agent = Ablo({ schema, session });
```

A static `session` resource does not invent authority to renew itself. It lives
until `expiresAt`; use a provider when the client must outlive that credential.
Session clients use one reconnecting WebSocket by default. Pass
`transport: 'http'` only for bounded scoped work that must not hold a socket.

## Mint

Only a **secret key** (`sk_`) can mint a session — never another session token.
The `sk_` is the trust anchor; minting is your backend vouching
for the actor.

| Param | For | Meaning |
|---|---|---|
| `user` / `agent` | both | The actor. `id` becomes the token's `participantId`. Pass exactly one. |
| `can` | both | Required non-empty per-model operation allowlist, typed off the schema. |
| `organizationId` | user | Mint into a customer organization instead of the key's own. Requires `organization:act-as`. |
| `schemaProject` | user | Override the schema project for a cross-org mint. Usually omitted because the owning key's project is the default. |
| `groups` | both | Narrow the session below its default scope. Omit to inherit. |
| `ttlSeconds` | both | Lifetime in seconds. Defaults to `900` (15m). |
| `userMeta` | both | Opaque identity blob echoed back to the client. |

## Lifecycle

Sessions are **short-lived by design** (~15 minutes). A renewable browser or
agent provider pre-mints ahead of expiry and reconnects with the replacement,
so the logical session and durable observation continue even though an
individual socket may be replaced. A static session ends at its credential's
expiry. Signing out stops refresh and the old token expires on its own.

Revoke immediately when a token is exposed or an actor loses access:

```ts
await sessions.revoke({ id: session.id });
```

Agent sessions can rotate with overlap so a worker can adopt the replacement
before the previous token expires:

```ts
const replacement = await sessions.rotate({
  id: session.id,
  graceSeconds: 300,
  ttlSeconds: 900,
});
```

Browser `ek_` sessions rotate through `session.endpoint`; do not distribute rotated
browser tokens manually.

### Offline & sign-out

The short session token is **not** your user's login — it's a minutes-long
credential layered on top of whatever long-lived auth your `session.endpoint`
already enforces (your own session cookie, an IdP, etc.). The provider keeps
those two lifetimes separate, which means:

- **Going offline never signs the user out.** The provider keeps working from
  its local cache and treats a failed re-mint (no network, a timeout, a `5xx`
  from your endpoint) as **transient** — it retries, and re-mints the instant
  connectivity or tab focus returns. The user stays signed in for as long as
  your underlying session is valid, however brief or long the network drop.
- **The user is signed out only when the underlying session is genuinely
  gone** — your session endpoint responds `401` with the canonical
  `{ error: { code: 'session_expired' } }` body. An unrelated `401` or `403`
  is a policy/configuration failure, not proof that the login ended.

This mirrors the OAuth refresh-token rule (Okta/Auth0/Authgear): only a
rejection of the *long-lived* credential ends the session — a network failure
never does.

<Note>
`sessions.handler` returns `session_expired` only when `authenticate` reports
that the application login is gone. Exceptions and network failures remain
transient errors; they do not sign the user out.
</Note>

## Scope

A user session carries the user's **base** sync-groups (`org:`/`user:`/`team:`),
derived from the identity you minted it for. **Dynamic, relation-driven
membership** (e.g. a `archive:<id>` the user was just added to) is resolved
**server-side at connect** and unioned on top — so scope stays live, not frozen
at mint time. Pass `groups` only when you want to *narrow* below the default.

## Your schema, your users (the default)

Your schema lives in a **project** — you push it once (`npx ablo push`) and every
session you mint resolves against it. The flow for serving end-users:

1. **Push your schema** to your project.
2. **Mint an `ek_` per user:** `sessions.create({ user: { id }, can })`. Your
   users commit to that one schema with only the operations in `can`.

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

Choose the boundary before minting sessions:

| Customer model | Isolation guarantee | Use when |
|---|---|---|
| One Ablo organization, customer scope roots | Every model's declared `policy` | Cross-customer access is intentional or every model explicitly partitions by the customer root |
| One Ablo organization per customer | Structural organization filtering and RLS on every row | Customers must be isolated even when a model has no customer policy |

Sync-group routing controls which changes are delivered; it does not grant or
deny reads. Do not use scope roots as a tenant security boundary unless every
model declares the matching policy. If that invariant is difficult to audit,
use one organization per customer.

For the complete key, backend-route, browser, lifecycle, and troubleshooting
flow, see [Customer Organizations](./customer-organizations.md).

The problem that creates: if each customer is a separate org, a naïve setup would
make you re-push your schema into every new customer's org. You don't have to.
Keep **one** project as the home of your schema. When its key mints into another
organization, Ablo automatically resolves the session's *schema* from that key's
project while its *data* stays in the customer's own org:

```ts
const ablo = Ablo({ schema, apiKey: process.env.ABLO_PLATFORM_KEY });
const { token } = await sessions.create({
  user: { id: userId },
  organizationId, // DATA → this customer's isolated org
  can: { records: ['read', 'update'] },
  ttlSeconds: 3600,
});
```

For migrations or advanced routing, `sessions.create` also accepts an explicit
`schemaProject: { organizationId, projectId }` override.

Server-side the split is clean: the model **shape** loads from your schema
project, but column enrichment and the tenant connection target the customer's
`organizationId` — so the shared schema only *describes* the shape; the data
plane (connection + row-level isolation) stays the customer's. A shared schema
can't leak data across orgs.

<Note>
This requires a dedicated `sk_` carrying the `organization:act-as` scope —
only a trusted cross-organization key can mint a session into another org. Omit
`organizationId` and you get the default above: one project, one schema, all
your users in the key's own organization.
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
| Authority | narrow (explicit `can` allowlist) | narrow (explicit `can` allowlist) |
| Mint | `sessions.create({ user: { id }, can })` | `sessions.create({ agent: { id }, can })` |
| Lives where | the user's **browser** | the agent runtime |
