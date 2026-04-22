# Setup

Zero to mesh in under five minutes. Three integration shapes — pick the one that matches your process model.

## What you need

One env var for server-side code. Zero for browsers that get a token from your server.

```
ABLO_API_KEY=sk_live_...
```

The key binds to exactly one organization; the SDK learns your org id from the server at call time. The mesh URL is baked in — `ABLO_BASE_URL` is only used to point the SDK at a staging / local-dev sync-server during internal testing.

## We don't host your data

Ablo is the **coordination fabric** — presence, intents, real-time sync, capability tokens. Your business entities (matters, clauses, deals) live in your own database, queried and mutated by your own app. Same model as Liveblocks, PartyKit, Ably: you bring the data, we broker the real-time.

We store capability tokens, presence, sync deltas (rolling TTL), and org config. We do NOT store your entities, your business logic, or anything with data-residency implications.

---

## The three shapes

### 1. Server agent (long-running backend)

```ts
import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

const ablo = new Ablo({ schema });

const participant = await ablo.matters.join(matterId, { label: 'DD Bot' });
participant.autoRefresh();

// Do your work. `participant` is already connected.
```

Reads `ABLO_API_KEY` from env; auto-connects; auto-rotates the capability. Drop `autoRefresh()` for short-lived scripts (cron, server action, Lambda) — the process exits before TTL.

Full running example: [`examples/server-agent.ts`](../../examples/server-agent.ts)

---

### 2. Browser app (Stripe-shaped flow)

Server mints a scoped token. Browser receives it and constructs a client directly with no API key, no session passthrough, no allowed-origins registration.

**Your server** (Next.js route, Hono handler, whatever):

```ts
import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

const ablo = new Ablo({ schema }); // reads ABLO_API_KEY

export async function mintToken(matterId: string) {
  const cap = await ablo.admin.capabilities.create({
    allowedSyncGroups: [`matter:${matterId}`],
    ttlSeconds: 3600,
  });
  return cap.token;
}
```

**Your browser:**

```ts
import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

const ablo = new Ablo({
  schema,
  capabilityToken: tokenFromServer,
  onTokenRefresh: async () => (await fetch('/api/ablo/token').then((r) => r.json())).token,
});

const participant = await ablo.matters.join(matterId, { label: 'You' });
participant.autoRefresh();
```

The scope is baked into the token at mint time — the browser can't exceed it. Revoke via `ablo.admin.capabilities.del(capId)` on the server for sub-second effect.

Full running example: [`examples/browser-app.ts`](../../examples/browser-app.ts)

---

### 3. Sub-agent (parent spawns attenuated child)

```ts
const parent = await ablo.matters.join(matterId, { label: 'Orchestrator' });

const child = await parent.join(
  { label: 'Risk Analyzer' },
  { scope: { matters: matterId } }, // must be ⊆ parent's scope
);
```

Child's Biscuit is cryptographically attenuated from parent's. Revoking the parent cascades.

Full running example: [`examples/sub-agent.ts`](../../examples/sub-agent.ts)

---

## Coordination primitives

Every `participant` — regardless of shape — has the same three always-on primitives:

**Presence** — who's doing what on the mesh:
```ts
participant.presence.editing(['Clause', clauseId]);
participant.presence.viewing(['Matter', matterId]);
for await (const peers of participant.presence) { /* reactive roster */ }
```

**Intents** — claim a write; peers yield:
```ts
await using work = participant.intents.writing(['Clause', id], { ttl: '3m' });
// auto-revokes on scope exit (success OR throw) — no try/finally
```

**Snapshots** — read-and-stamp for stale-context protection:
```ts
const snap = await participant.snapshot({ clauses: [clauseId] });
// snap.clauses[id] — typed from your schema (not `unknown`)
// snap.stamp       — pass as readAt on writes
// snap.signal      — AbortSignal, fires on captured-entity deltas
```

Not every integration needs all three. Single-agent batch jobs often use none. Two-human / human+agent flows typically need presence + intents. LLM-in-the-loop flows with high latency use snapshots.

---

## First-byte test

Prove the env is wired. Save as `first-byte-test.ts`:

```ts
import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

const ablo = new Ablo({ schema });
const participant = await ablo.matters.join('smoke-test', {
  label: 'smoke test',
  ttlSeconds: '60s',
});

console.log('connected — setup is live');
await participant.disconnect();
```

Run: `ABLO_API_KEY=sk_test_... npx tsx first-byte-test.ts`

---

## Debugging

| Symptom | Cause | Fix |
|---|---|---|
| `AbloAuthenticationError: apikey_invalid` | Wrong / revoked API key | Mint a fresh one |
| `AbloAuthenticationError: apikey_missing` | No env var, no capability token, no session | Set one of the three auth paths |
| `AbloPermissionError: capability_scope_denied` | Join scope exceeded the API key's allowed scope | Narrow scope, or get a broader key |
| `AbloValidationError: scope produced an empty sync group list` | Entity has no `syncGroupFormat` | Declare it in the schema |
| `mesh_refresh_unavailable` | `refresh()` called on capability-token client without `onTokenRefresh` | Provide the callback, or mint fresh server-side |
| WS connects but `others` stays empty | Participants don't share a sync group | Two participants must share ≥1 sync group to see each other |

---

## Production checklist

- [ ] `ABLO_API_KEY` is `sk_live_*`, belongs to your prod org
- [ ] No `ABLO_API_KEY` in browser bundles — server-side only
- [ ] Browser clients use `capabilityToken` + `onTokenRefresh` (Shape 2) OR register origins (Shape 2-legacy, session-cookie flow)
- [ ] `autoRefresh()` enabled on participants that outlive their TTL
- [ ] Errors caught at least for `AbloAuthenticationError` + `AbloRateLimitError`

---

## Deployment

Hosted service only — `mesh.ablo.finance`. On-prem / self-hosted deployment is not offered today. If that's a procurement requirement for you, it's a conversation; get in touch.

`ABLO_BASE_URL` exists in the SDK to point at staging / local-dev instances of the sync-server during Ablo's own testing — not as a customer-facing self-host path.

## Next steps

- [`CONCEPTS.md`](./CONCEPTS.md) — the mental model (participants, presence, intents, scope)
- [`README.md`](./README.md) — full API reference
- [`examples/`](../../examples/) — three canonical runnable programs
