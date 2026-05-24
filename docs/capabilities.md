# Capabilities

A capability is scoped credentials for a non-human actor.

It is not a task and it is not an intent. It is the permission boundary that
answers who may touch which resources.

Most apps should use `api.agent(...).run(...)`; the SDK creates and revokes the
capability for that run. Create capabilities directly only for custom runtimes,
MCP sessions, or protocol-level integrations.

## Why capabilities, not API keys

Static API keys protect a human-operated workflow with one shared secret —
fine for a server-to-server integration written once and forgotten. They are
the wrong primitive for AI agents:

- An agent that holds an account-wide key inherits every permission your
  human team has. A leaked key burns the whole account; a confused-deputy
  bug lets the agent write to resources it had no business touching.
- Per-task work needs per-task attribution. One static key across every
  agent invocation makes the audit trail say "the API key did it" — which
  tells you nothing about which run, which prompt, or which user delegated
  the action.
- Long-lived secrets accumulate blast radius. The longer a credential is
  valid, the more places it travels (logs, env files, agent prompts), and
  the wider the leak surface.

Capabilities replace the one-static-key model with **per-run, per-scope,
short-lived** credentials. The 2025-2026 AI-agent auth consensus (the
OAuth 2.1 / MCP spec, GCP short-lived credentials, AWS STS AssumeRole,
HashiCorp Vault leases, Auth0 Token Vault) converged on the same shape:
issue scoped tokens, attach a TTL, verify per-request, support fast
revocation. Capabilities are Ablo's instance of that pattern.

## The three-layer security model

Every commit is authorized by three independent checks. None of them is
sufficient on its own; together they cap the blast radius of every
credible failure mode.

1. **Lease (TTL)** — every capability has an expiry encoded in the bearer
   token itself. After the lease, the token decodes but every signature
   check fails. Caps the damage from a leaked token without requiring a
   database lookup on the hot path.
2. **Signature verification (per request)** — every commit re-verifies
   the token's signature and attenuation. Stateless, cheap (microseconds),
   detects forged or tampered tokens. The token's `syncGroups` and
   `operations` are checked against the commit's actual targets;
   `capability_scope_denied` rejects the request before any write lands.
3. **Revocation** — `DELETE /v1/capabilities/:id` flips the cap's status
   server-side; live WebSocket sessions are closed, future requests are
   rejected within seconds. Closes the gap between lease refresh cycles
   when you need *immediate* cutoff (compromised agent, accidental
   over-grant, end-of-trial cleanup).

The mental model: **lease prevents the slow leak, signature verification
prevents the forged token, revocation prevents the active attacker.**
Removing any one of the three leaves a class of failure uncovered.

## Why this shape, in one paragraph each

**Lease, not "session"** — A session token requires a database round-trip
on every request to check liveness. A lease is encoded in the token and
verified stateless. Vault popularized the term ("lease, renew, revoke");
the mechanic is the same as AWS STS time-bounded credentials and GCP
short-lived service-account creds. Ablo uses the word "lease" because the
bearer holds a *bounded grant*, not just a timer — the same word
`capability_scope_denied` errors reference.

**Two scope axes (`syncGroups` + `operations`), not one** — `syncGroups`
narrows *which rows* the actor can see; `operations` narrows *which verbs*
the actor can use. Collapsing them into one set forces an explosion
(`tasks.update:org:acme`, `tasks.delete:org:acme`, ...). Keeping them
orthogonal lets a 3-group × 5-op cap stay 3+5 instead of 3×5. Same shape
as IAM policies (`Resource` + `Action`), Stripe Restricted Keys
(`resource_type` + `permission`), and Biscuit caveats.

**Strings from `identityRoles`, never invented** — A consumer who types
`'org:acme'` literally couples their code to Ablo's identity convention.
Templates declared once on the schema (see integration-guide.md §1) let
the convention live in one place; consumers reference it by template, not
by hand-typing the prefix. Same boundary as Liveblocks' `prepareSession()`
or PowerSync's named streams: server owns the namespace, client picks a
subset by id.

**`participantKind` cannot be `'user'`** — Capabilities are explicitly
for non-human actors. A capability minted as a user would let any code
path with that bearer impersonate the human; instead, user actions flow
through session auth (cookies / OAuth) so the audit chain says
"alice@example.com did X" — not "a token did X." Stripe makes the same
split between Restricted API Keys (system) and Connect OAuth (user-on-
behalf-of).

## What capabilities aren't

| Not | Why we didn't ship that |
|---|---|
| **A static API key** | One leaked secret = whole-account compromise. No per-run attribution. No automatic expiry. |
| **An OAuth session token** | OAuth's user-delegation model assumes a human in the loop; agents are the actor, not the delegate. The auth flow round-trips don't fit agent runtimes. |
| **An opaque DB session** | Per-request DB lookup is the slow path. Stateless verification (signature + lease) is the fast path; the DB is the revocation list, not the live-check. |
| **A bearer JWT with `exp`** | Conceptually similar, but Biscuit caveats let us *attenuate* a cap further (delegate a narrower sub-scope to a sub-agent) without re-minting. Plain JWTs can't subset themselves. |

## Create

```ts
import Ablo from '@ablo/sync-engine';

const admin = Ablo({ apiKey: process.env.ABLO_API_KEY });

const capability = await admin.capabilities.create({
  participantKind: 'agent',
  participantId: 'agent:task-writer',
  // Identity-anchored groups derived from the schema's `identityRoles`
  // registration (see integration-guide.md §1). The strings here mirror
  // whatever templates the schema declared — `org:{id}` and friends for
  // Ablo's stock schema; a third-party schema with `region:{id}` /
  // `customer:{id}` roles would pass those instead.
  syncGroups: ['org:acme', 'user:agent:task-writer'],
  operations: ['tasks.retrieve', 'tasks.update'],
  lease: '10m',
});
```

Pass `capability.token` into the agent runtime. The agent never sees admin
credentials.

```ts
const agent = capability.client();
```

## Inspect

```ts
const record = await admin.capabilities.retrieve(capability.id);

record.status; // active | expired | revoked
record.operations; // ['tasks.retrieve', 'tasks.update']
```

Inspection never returns the bearer token. Tokens are returned once at create
time.

## Revoke

```ts
await admin.capabilities.revoke(capability.id);
```

Revocation is forward-only. Already accepted commits stand; future requests with
that token are rejected within seconds.

## Scope Grammar

| Field | Required | Meaning |
|---|---|---|
| `participantKind` | yes | `agent` or `system`. Capabilities cannot impersonate `user`. |
| `participantId` | recommended | Stable actor id, for example `agent:task-writer`. |
| `syncGroups` | yes | Sync groups the actor can touch. Strings come from the schema's `identityRoles` templates or a model's `syncGroupFormat` — never invented by the caller. |
| `operations` | yes | Typed operation names, for example `tasks.update`. |
| `lease` / `leaseSeconds` | recommended | Crash cleanup window for abandoned actors. |
| `label` | no | Human-readable label for dashboards and audit. |
| `userMeta` | no | Customer-attested end-user metadata for B2B2C flows. |
