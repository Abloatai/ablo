# API Keys

Authenticate a server-side client — a route handler, worker, or CLI — by passing an API key when you create the client.

```ts
import Ablo from '@abloatai/ablo';

const ablo = Ablo({ apiKey: process.env.ABLO_API_KEY });
```

The key identifies the Ablo account. Application code does not pass an organization id; Ablo derives scope from the credential.

"Trusted" means the runtime can hold a secret: a backend or other server-side environment a browser can't read. Browser and app clients use the same `@abloatai/ablo` import but authenticate differently — they never carry a secret key.

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
sandboxes you create. **Data is isolated per sandbox; the schema is shared
across the whole org.** A schema you push from a test key defines the same
models your live keys see — only the rows differ. This mirrors how Stripe
separates sandbox and production data while keeping the API shape identical.

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
