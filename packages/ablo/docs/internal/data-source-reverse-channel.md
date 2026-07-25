# Data Source Reverse Channel (local-dev parity)

Maintainer scoping doc. Closes the one real day-one DX gap in Data Source
mode: the `commit`/`load`/`list` legs are inbound webhooks (Ablo → your
endpoint), so on `localhost` they need a tunnel (ngrok/cloudflared). This
scopes a built-in reverse channel so Data Source works on localhost the way
managed mode already does — the Stripe-CLI `stripe listen` pattern.

## The gap, precisely

Data Source has two directions today:

| Leg | Direction | Transport(s) today | localhost-friendly? |
|---|---|---|---|
| `events` (external writes → Ablo) | customer → Ablo | **poll** (`events` handler, Ablo calls you) **+ push** (`createPushQueue` → `POST /api/source/events`, you call Ablo) | ✅ yes, via push |
| `commit` / `load` / `list` | Ablo → customer | **inbound webhook only** (`dataSource()` route) | ❌ no: needs public URL |

The asymmetry is the whole bug. `events` already ships an outbound transport
(`src/source/pushQueue.ts`), so external writes reach Ablo from localhost
without a tunnel. The `commit`/`load`/`list` leg never got one, so Ablo Cloud
has no way to reach a `localhost:3000` dev server.

Inbound is exactly what localhost cannot receive. Managed mode has no inbound
leg (the browser/SDK opens the only connection, outbound to Ablo), which is why
managed mode "just works" locally and Data Source doesn't.

## Prior art

- **Stripe CLI `stripe listen`:** the canonical fix. The CLI opens an
  *outbound* WebSocket to Stripe; Stripe drains webhook events down it and the
  CLI forwards them to `localhost`. No public URL, no tunnel. We want the same
  for the `commit`/`load`/`list` leg.
- **Our own `createPushQueue`:** already proves the outbound-from-customer
  pattern for the `events` leg. The reverse channel is the symmetric primitive
  for the other direction.

## Design

A customer-run **source connector** dials out to Ablo Cloud and serves
`commit`/`load`/`list` over the open connection, instead of Ablo making inbound
HTTP calls.

```
LOCAL DEV (no public URL)

  ablo client ──ws──▶ Ablo Cloud ──┐
                                   │  (no inbound HTTP to localhost)
  customer connector ──ws (dial-out)──▶ Ablo Cloud
       │  drains pending commit/load/list for this source
       ▼
  dataSource(options)  ← UNCHANGED handler, fed a synthesized Request
       ▼
  local Postgres
       │  signed response posted back up the same ws
       └──────────────────────────────────────▶ Ablo Cloud ──ws──▶ ablo client
```

### Why it's small

`dataSource(options)` is already `(request: Request) => Promise<Response>` in
`src/source/factory.ts`. The connector does not reimplement any handler logic —
it:

1. Opens a WS to a new Ablo Cloud endpoint (e.g. `/v1/source/listen`),
   authenticating with the project API key.
2. Registers which source/org it serves. Ablo Cloud routes that source's
   `commit`/`load`/`list` requests to this socket instead of the configured
   webhook URL (when a live connector is attached).
3. For each drained request frame: synthesize a `Request` with the same signed
   headers Ablo would have sent, call the customer's existing `dataSource`
   handler, and post the `Response` back up the socket.

Customer-side surface is one wrapper around the handler they already wrote:

```ts
// dev only — same handler object as the deployed route
import { dataSource, createSourceConnector } from '@abloatai/ablo';
import { sourceOptions } from './ablo.source'; // shared with route.ts

const connector = createSourceConnector({
  apiKey: process.env.ABLO_API_KEY!,      // sk_test_*
  handler: dataSource(sourceOptions),     // the unchanged (Request)=>Response
});
await connector.run(abortSignal);
```

`route.ts` (deployed) and the connector (local) share the same
`sourceOptions` — zero handler drift.

### Server side (sync-server)

- New WS endpoint `/v1/source/listen`. Auth: project API key → resolves the
  source. Reject if the key isn't `sk_test_*` unless the source explicitly
  opts into reverse-channel for production (see "Production" below).
- Per-source request queue. When a `commit`/`load`/`list` needs the customer
  and a connector is attached, enqueue + drain down the socket instead of
  POSTing the webhook URL. Reuse the same signed-envelope shape so the
  customer handler verifies identically (`verifyAbloSourceRequest` unchanged).
- Fallback: no connector attached → existing inbound webhook path. The
  reverse channel is purely additive; nothing changes for deployed apps.

### Signature / security

- The drained frames carry the **same** Standard Webhooks signature
  (`webhook-id`/`webhook-timestamp`/`webhook-signature`) computed with the
  project key, so the connector verifies them through the existing
  `verifyAbloSourceRequest` with no special-casing. The transport changes; the
  trust model does not.
- Gate to `sk_test_*` by default. The DB still stays canonical in the
  customer's process; nothing here gives Ablo the `DATABASE_URL`.

## Test-mode interplay

`SourceRequestContext.mode` (`src/source/types.ts`) already distinguishes
`test`/`live`. The reverse channel is the natural home for `mode: 'test'`
traffic: a local connector attached with an `sk_test_*` key receives the
source's test commits, runs them against the customer's test DB, and the SDK
sees confirmed rows + fan-out exactly as in production. This is the missing
piece that makes `sk_test_*` a complete local loop rather than just a data
namespace.

## Production stance

Keep the inbound webhook as the default deployed transport — it's lower
latency (no long-lived socket to babysit) and stateless. The reverse channel
is primarily the **dev** affordance. A secondary, opt-in use is a
"no-public-URL deploy" mode for customers who cannot expose an inbound
endpoint at all (locked-down VPCs); that's a follow-on, not the initial scope.

## Scope boundary (what this is NOT)

- Not a generic tunnel — it forwards only signed Ablo source frames for one
  source, not arbitrary traffic.
- Not a change to the handler contract — `dataSource` is untouched; the
  connector wraps its handler.
- Not a managed-mode change — managed mode has no inbound leg and is unaffected.

## Touch list (when built)

- `packages/transaction/src/source/connector.ts` — `createSourceConnector`
  (dial-out WS client; synthesize Request → existing handler → post Response).
- `packages/transaction` export surface — expose `createSourceConnector` next to
  `createPushQueue`.
- `apps/sync-server` — `/v1/source/listen` WS endpoint + per-source request
  queue + "drain to connector if attached, else webhook" branch in the source
  dispatch path.
- `docs/data-sources.md` — document the local-dev loop (the current docs only
  describe the public-HTTPS webhook).
- Tests: connector round-trip (drained commit → handler → response), signature
  parity with the webhook path, fallback-to-webhook when no connector attached.
