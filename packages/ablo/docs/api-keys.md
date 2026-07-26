# API Keys

> The credential that carries an agent's identity and bounds what it may write.

Authenticate a server-side client — a route handler, worker, or CLI — by passing an API key when you create the client.

```ts
import Ablo from '@abloatai/ablo';

const ablo = Ablo({ apiKey: process.env.ABLO_API_KEY });
```

The key identifies the Ablo account. Application code does not pass an organization id; Ablo derives scope from the credential.

"Trusted" means the runtime can hold a secret: a backend or other server-side environment a browser can't read. Browser and app clients use the same `@abloatai/ablo` import but authenticate differently — they never carry a secret key.

## Which credential to use

There's **one field — `apiKey`** — and what you pass depends on **where the code runs**.
Pick your row:

| Where your code runs | What to pass | Example |
|---|---|---|
| **Server / worker / CLI** (can hold a secret) | your secret `sk_`: it defaults to `ABLO_API_KEY`, so usually pass **nothing** | `Ablo({ schema })` |
| **Browser: read-only** | a publishable `pk_` (safe to ship, like a Stripe `pk_`) | `Ablo({ schema, apiKey: process.env.NEXT_PUBLIC_ABLO_PUBLISHABLE_KEY })` |
| **Browser: writing as the signed-in user** | `authEndpoint`: the route on your own backend that mints a short-lived per-user token | `Ablo({ schema, authEndpoint: '/api/ablo-session' })` |

That's the whole story: one knob, filled by audience.

The `mk_` credential created by `ablo login` is different: it is a CLI
control-plane credential, not an application API key. It can manage projects
and branches and exchange for a branch-bound runtime key. Do not pass it to
`Ablo(...)` or put it in `ABLO_API_KEY`.

**Coming from Stripe? It's the same key model, same prefixes:**

| Stripe | Ablo | Where it goes |
|---|---|---|
| publishable `pk_` (client-safe) | `pk_` | browser: read-only |
| secret `sk_` (server, full) | `sk_` | server: full authority |
| restricted `rk_` (granular) | `rk_` | scoped agents (`agents.create({ can })`) |
| ephemeral key (client, customer-scoped) | `ek_` | per-user browser sessions (`sessions.create({ user, can })`) |

Ablo also has one credential class that Stripe does not need:

| Prefix | Purpose | Mode | Stored where |
|---|---|---|---|
| `mk_` | project and branch management | none | CLI credential store or `ABLO_MANAGEMENT_KEY` |

Trust class lives in the prefix too — `sk_test_` / `sk_live_` — exactly like Stripe.
It does not select a branch; the immutable server-side binding does that. The
`apiKey` resolver fetching an `ek_` is Ablo's ephemeral-key flow: server mints, client holds.

**Why a function for browser writes?** Anything you ship to a browser must be public, and a
public `pk_` is **read-only** — it can't carry one specific user's write authority. So when
the browser writes *as the logged-in user*, your backend (which holds the secret `sk_` and
knows who's signed in) mints a short-lived per-user token with `sessions.create({ user, can })`,
and the browser's `apiKey` function fetches it. You don't manage refresh — the SDK calls the
function once before connecting and then keeps the token fresh (re-mint before expiry, and on
tab-focus / network-online / device-wake). This is the Stripe ephemeral-key / Supabase
session model. For a read-only app you don't need any of this — just the `pk_` above.

Server-side, because `apiKey` defaults to `process.env.ABLO_API_KEY`, most backend and agent
code passes nothing. The secret `sk_` is **server-only** — never in a
browser bundle. There is no `getToken` or `as` option — `apiKey` (the key a server holds)
and `authEndpoint` (the mint route a browser points at) are the two credential
knobs, and you set exactly one.

### Minting per-user / agent tokens (server-side, with your `sk_`)

| Mint | Call | Result |
|---|---|---|
| Human end-user session | `await server.sessions.create({ user: { id }, can: { tasks: ['read'] } })` | `ek_` (scoped to `can`) |
| Ready agent client | `await server.agents.create({ can: { tasks: ['update'] } })` | Auto-refreshing client scoped to `can` |
| Raw delegated agent token | `await server.sessions.create({ agent: { id }, can: { tasks: ['update'] } })` | `rk_` for another runtime |

The principal kind comes from *which* shape you pass — `{ user, can }` → `user`, `{ agent, can }` → `agent`.

## Server-Side API Keys

Use API keys from trusted (server-side) runtimes:

- backend route handlers
- workers and agents
- CLI tools
- webhooks

Never ship a secret API key to a browser bundle.

## Publishable key (`pk_`): browser-safe, read-only

For a read-only browser experience, a publishable key is safe to ship in the
bundle. Like a Stripe `pk_` or a Supabase anon key, it is long-lived,
org-scoped, and used **directly as the bearer** — never exchanged, never
expires, nothing to refresh:

```ts
const ablo = Ablo({ apiKey: process.env.NEXT_PUBLIC_ABLO_PUBLISHABLE_KEY }); // pk_live_…
```

A `pk_` grants **read-only** access to the org's data plane: it cannot write and
cannot reach any control-plane operation. The moment the browser needs to write
on a specific user's behalf, mint a short-lived `ek_` user session from your
backend instead (see the Sessions guide).

## Branches and production

A branch is your project at full strength over its own rows: the same models,
the same schema, the same claims and the same rules production runs.

Production is the project's root branch. Development branches are isolated
children, and a key's immutable branch binding decides which rows, schema,
claims, and log it can reach:

- `sk_test_…` — a key bound to a development branch. Its reads and
  writes are invisible to production and to other branches.
- `sk_live_…` — a key against your live data.

`npx ablo dev` derives a branch from Git, ensures the matching child, and mints
an expiring `sk_test_` key for it. The credential carries the immutable branch
id; changing a slug in a request cannot change its authority. A child receives
the parent's active schema when it is created and owns its artifact after that.
A schema change reaches production only through the reviewed live-key path in
[Deployment](./deployment.md).

The shared default sandbox is no longer part of the development workflow.
Branch identity is required for newly provisioned CLI and runtime credentials.

## Scopes

Keys carry scopes following the principle of least privilege — each key gets
only what its job needs. A secret key with **no scopes** has full org authority
(the default for a `sk_live_` backend key); a key with a non-empty scope set is
restricted to exactly those grants:

- `schema:push` — author the schema artifact on the key's bound plane
  (`ablo push`, `ablo dev`). A production push is high-risk because it changes
  the live contract; a child push remains inside that branch. A
  full-authority key has it implicitly; a restricted key needs it explicitly.
- `project:manage` — list, create, and rename projects.
- `branch:manage` — list, create, and delete child branches and mint their
  temporary credentials.

Both management scopes are explicit grants on `mk_` credentials. Runtime
`sk_`, `rk_`, `pk_`, and `ek_` credentials cannot become management
credentials through an empty scope set or a CLI fallback.

Branch binding remains an authority boundary even when a key has no granular
scope strings: a temporary child key can act only inside that child. It cannot
manage siblings or gain root authority.

### `ablo dev`

```sh
npx ablo login
npx ablo dev
```

The stored `mk_` project credential is used only to ensure the Git-derived child and
mint an expiring branch credential. `dev` writes that temporary key to
gitignored `.env.local`, pushes `ablo/schema.ts` to the child, and re-pushes on
every save. See [Branch-first development](./branch-development.md).
