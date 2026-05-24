# Interaction Model

Ablo separates the data path from the authority path.

The data path is what your application does on every write:

```
Schema -> Model load -> Intent -> Model update -> Confirmation
```

The authority path is what makes that write defensible:

```
Capability -> Task -> Usage
```

## Primitives

| Primitive | Plane | Purpose |
|---|---|---|
| `Schema` | State | Declares typed models the app and agents can read and write. |
| `Model` | State | The generated `ablo.<model>` resource. Use `load`, `retrieve`, `create`, `update`, and `delete`. |
| `Intent` | State | Pre-write coordination. It says what this actor is preparing to change. |
| `Commit` | Protocol | The durable write underneath model updates. Most users do not call it directly. |
| `Receipt` | Protocol | The lower-level durable result for custom runtimes. Schema writes use `wait: 'confirmed'`. |
| `Capability` | Control | Signed credentials. It says who can do what, where, for how long, and on whose behalf. |
| `Task` | Control | One agent run. It groups prompts, commits, child tasks, and cost. |
| `Usage` | Control | Metering and audit rows derived from accepted work. |

Capabilities, tasks, and usage do not mutate product data. They define and
record the authority around mutation.

### Why each primitive is separate

The plane separation isn't ceremony — collapsing any two of these would
lose a property that's hard to recover later. A reader coming from
Replicache or Yjs would expect just `Commit`; here's what the others buy
you over that minimum:

- **`Intent` is not a lock.** A pessimistic lock blocks a writer; an
  intent *announces* one. Other writers can yield, wait, or proceed —
  the choice is theirs, not the system's. This is the only primitive
  that lets two agents discover each other's planned work *before* the
  conflict and self-arbitrate. Without intents, agents only learn about
  contention at commit time, when one of them has already wasted a
  token budget.
- **`Receipt` is not a `200 OK`.** It's the durable artifact a commit
  produced — accepted commit id, server-assigned timestamps, stale-check
  outcome — addressable after the fact and replayable into a different
  client. A status code can't be re-read by a sub-agent that wasn't on
  the original call.
- **`Capability` is not the actor.** The actor (`Task`) is what *ran*;
  the capability is what it was *allowed* to do. Same human can spawn
  many tasks under one cap (cheap re-run); same task can attenuate to
  many sub-caps (sub-agent delegation). Folding them collapses both
  directions of that fan.
- **`Task` is not the credential.** It's the audit envelope: prompt,
  commits, child tasks, tokens, duration. Long after the cap has
  expired, the task row is what answers "what did this run do." Folding
  task into capability loses the post-expiry audit.
- **`Usage` is not derived from logs.** It's denormalized at commit
  accept time so quota enforcement and billing reads stay O(1). Log
  scans would work for audit but not for hot-path gating.

The shape is borrowed from systems that learned the cost of collapse:
intents from operational-transform CRDTs and Linear's
optimistic-multiplayer model, capabilities + tasks from AWS IAM
(`Role` ≠ `RoleSession`) and Vault (`policy` ≠ `lease`).

## Run Loop

A normal schema-backed run is:

```
const [task] = await ablo.tasks.load({ where: { id } });
const busy = ablo.intents.list({ resource: 'tasks', id });
const snap = ablo.snapshot({ tasks: id });
await ablo.tasks.update(id, patch, {
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

## Participants

Every action is performed by one of three kinds:

- `user` — a human, authenticated via session.
- `agent` — an AI process acting on behalf of a human, authenticated via a capability minted from that human's session.
- `system` — a customer-backend process acting on behalf of an organization, authenticated via an API key.

The participant kind is enforced at the boundary. An agent capability cannot impersonate a user. A user session cannot open a task.

## Delegation chain

Every capability resolves to a `delegationChainRootUserId` — the human at the head of the chain. The chain is denormalized onto every commit's `on_behalf_of_*` columns so audit queries answer "what did this human authorize" with one lookup, not a recursive join.

## Enforcement

Capabilities are enforced per operation, not per request. When a commit arrives, Ablo decodes the bearer token, checks each operation against `operations` and `syncGroups`, and rejects with `capability_scope_denied` if the scope is missing. Revocation takes effect within seconds of `DELETE /v1/capabilities/:id`.

Three independent checks gate every commit. The redundancy is intentional — each check covers a failure mode the others don't:

- **Lease (TTL on the token).** Decoded from the bearer; no DB lookup. Caps the lifetime of a leaked token. Without this, a stolen token works until manually revoked.
- **Signature + scope verification.** Stateless. Detects forged or tampered tokens and rejects operations outside the cap's `operations` / `syncGroups`. Without this, a malformed token with the right shape could pass.
- **Revocation.** `DELETE /v1/capabilities/:id` flips status server-side; live WS sessions close, future commits reject. Closes the gap between lease refresh cycles when you need *immediate* cutoff. Without this, a compromised cap with a long lease leaks until expiry.

Removing any one of the three leaves a class of attack uncovered. The pattern matches AWS STS, Vault leases, and the OAuth 2.1 / MCP agent-auth recommendation; see [Capabilities](./capabilities.md#the-three-layer-security-model) for the full design discussion.

## Coordination

Intents broadcast across the org. When `agent:task-writer` declares an intent to
update a task, schema clients can see it through `ablo.intents.list(...)` or the
live intent stream. Callers decide whether to yield, wait, or fail fast.

## Conflict resolution

Schema updates can carry `readAt` and `onStale`. If the state advanced past
`readAt`, Ablo applies the `onStale` policy:

- `reject` — fail the commit (first writer wins).
- `merge` — apply the write if it does not overlap with concurrent changes.
- `force` — apply the write unconditionally.

The choice is per-commit. No CRDT default; the policy is explicit.

## Audit

Three tables observe the run:

- `agent_tasks` — one row per open/close cycle. Cost stats, prompt hash, capability id.
- `agent_actions_log` — one row per write, attributed to the task and the capability.
- `usage_event` — one row per accounted API call, attributed to the api key, the participant, and the task.

Joins between them answer "what did this agent do, on whose authority, at what cost." That answer is what makes giving an agent write access defensible.

## The contract in one sentence

Declare schema, load state, coordinate intent, update the model, and wait for confirmation.
