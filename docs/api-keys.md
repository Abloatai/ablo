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
| **Server / worker / CLI** (can hold a secret) | your secret `sk_` — it defaults to `ABLO_API_KEY`, so usually pass **nothing** | `Ablo({ schema })` |
| **Browser — read-only** | a publishable `pk_` (safe to ship, like a Stripe `pk_`) | `Ablo({ schema, apiKey: process.env.NEXT_PUBLIC_ABLO_PUBLISHABLE_KEY })` |
| **Browser — writing as the signed-in user** | `authEndpoint` — the route on your own backend that mints a short-lived per-user token | `Ablo({ schema, authEndpoint: '/api/ablo-session' })` |

That's the whole story: one knob, filled by audience.

**Coming from Stripe? It's the same key model, same prefixes:**

| Stripe | Ablo | Where it goes |
|---|---|---|
| publishable `pk_` (client-safe) | `pk_` | browser — read-only |
| secret `sk_` (server, full) | `sk_` | server — full authority |
| restricted `rk_` (granular) | `rk_` | scoped agent sessions (`sessions.create({ agent, can })`) |
| ephemeral key (client, customer-scoped) | `ek_` | per-user browser sessions (`sessions.create({ user })`) |

Mode lives in the prefix too — `sk_test_` / `sk_live_` — exactly like Stripe. The
`apiKey` resolver fetching an `ek_` is Ablo's ephemeral-key flow: server mints, client holds.

**Why a function for browser writes?** Anything you ship to a browser must be public, and a
public `pk_` is **read-only** — it can't carry one specific user's write authority. So when
the browser writes *as the logged-in user*, your backend (which holds the secret `sk_` and
knows who's signed in) mints a short-lived per-user token with `sessions.create({ user })`,
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
| Human end-user session | `await server.sessions.create({ user: { id } })` | `ek_` (full user authority) |
| Scoped delegated agent | `await server.sessions.create({ agent: { id }, can: { Task: ['update'] } })` | `rk_` (scoped to `can`) |

The principal kind comes from *which* shape you pass — `{ user }` → `user`, `{ agent, can }` → `agent`.

## Server-Side API Keys

Use API keys from trusted (server-side) runtimes:

- backend route handlers
- workers and agents
- CLI tools
- webhooks

Never ship a secret API key to a browser bundle.

## Publishable key (`pk_`) — browser-safe, read-only

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

## Sandboxes and production

Test and live keys are the same shape; the prefix names the environment:

- `sk_test_…` — a key bound to a **sandbox**. Its reads and writes are isolated
  to that sandbox and are invisible to live keys (and to other sandboxes).
- `sk_live_…` — a key against your live data.

Every org has a default sandbox, plus any number of additional
sandboxes you create. **Data is isolated per sandbox; the schema is one
definition serving both.** A sandbox reads the production schema until it is
pushed one of its own, so your test and live keys see the same models and only
the rows differ — how Stripe separates sandbox and production data while keeping
the API shape identical. A schema change reaches production when you push it
with a live key ([Deployment](./deployment.md)).

## Scopes

Keys carry scopes following the principle of least privilege — each key gets
only what its job needs. A secret key with **no scopes** has full org authority
(the default for a `sk_live_` backend key); a key with a non-empty scope set is
restricted to exactly those grants:

- `schema:push` — author the org schema (`ablo schema push`, `ablo dev`). A
  high-risk, org-wide grant: because schema is shared, a push affects the live
  table shape. A full-authority key has it implicitly; a *restricted* key (such
  as a sandbox key) needs it granted explicitly.
- `sandbox:<id>` — identifies which sandbox the key belongs to. (The key's data
  isolation comes from that sandbox binding, not from this scope string.)

A key minted from the default sandbox carries `schema:push`, so
`ablo dev` works out of the box. Keys from other sandboxes are **data-only** by
default — enable "schema authoring" when minting if you want that key to push
schema too. Hand data-only keys to embedded apps and CI agents; reserve
schema-authoring keys for the developer running `ablo dev`.

### `ablo dev`

```sh
ABLO_API_KEY=sk_test_… npx ablo dev
```

Pushes your `ablo/schema.ts` to the test sandbox, prints the one line you need
in `.env.local`, and re-pushes on every save. It refuses `sk_live_` keys so a
tight save loop can never churn production data.
