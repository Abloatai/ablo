# Sync engine architecture

This is the placement map for `@abloatai/ablo`. Application code gets one
surface: `Ablo({ schema, ... })` and the typed `ablo.<model>` clients. Changing
transport must not create another application API.

The server-side map is in the [sync-server README](../../apps/sync-server/README.md).
Contract changes follow [ADR 0005](../../docs/decisions/0005-sync-contract-evolution.md).
The one current commit shape and its ingress-only compatibility boundary follow
[ADR 0006](../../docs/decisions/0006-commit-api-boundary.md).

## Canonical vocabulary

| Meaning | Use | Boundary-only legacy names |
| --- | --- | --- |
| Typed collection, value, key | model / row / id | entity, resource, or record when decoding a deployed contract |
| Atomic batch write | commit | mutation in an older source or wire contract |
| One write in a commit | operation: `action/model/id/data` | internal WebSocket `type/model/id/input`, or an older `target` wrapper |
| One applied log change | delta | event/change names at external-source boundaries |
| Connected identity, persisted attribution | participant / actor | peer or author in a deployed contract |
| External resume value, internal numeric position | cursor / offset | `lastSyncId` or another deployed field name |
| Server deployment mode, customer data plane | stage / environment | existing environment-variable, wire, or database names |

An agent or user is a participant kind. `actor` describes attribution already
stored on a delta; it is not the name for a live connection.

## Where code belongs

| Path | Owns |
| --- | --- |
| [`src/client`](src/client/) | The typed `Ablo` facade, `ablo.<model>` behavior, option validation, and private transport assembly. |
| [`src/client/httpTransport.ts`](src/client/httpTransport.ts) | HTTP routes, envelopes, retries, and replay mechanics behind the facade; it is not a second public client. |
| [`src/schema`](src/schema/) | The schema DSL, model metadata, relations, selection, and schema serialization. |
| [`src/wire`](src/wire/) | Serialized HTTP/WebSocket contracts and the supported-version manifest; no domain decisions. |
| [`src/sync`](src/sync/) | Bootstrap, connection, catch-up, subscription, delta, presence, and claim streams. |
| [`src/transactions`](src/transactions/) | Operations, optimistic application, confirmation, durable envelopes, and replay. |
| [`src/query`](src/query/) | Internal server-read request types and query transport helpers. |
| [`src/core`](src/core/), [`src/stores`](src/stores/), and root runtime files | The local model graph, cache, persistence, views, and runtime orchestration; root files are only for cross-cutting runtime primitives. |
| [`src/coordination`](src/coordination/) | Claim and stale-read contracts plus coordination observability. |
| [`src/mutators`](src/mutators/) and [`src/policy`](src/policy/) | Advanced local transaction/undo machinery and conflict policy; ordinary model writes do not start here. |
| [`src/react`](src/react/) | React provider and hooks over the same typed client. |
| [`src/source`](src/source/) | The signed Data Source fallback and outbound connector protocol. |
| [`src/auth`](src/auth/), [`src/keys`](src/keys/), [`src/environment.ts`](src/environment.ts), [`src/server`](src/server/), and [`src/webhooks`](src/webhooks/) | Small shared boundary contracts; they must not grow a parallel runtime. |
| [`src/agent`](src/agent/), [`src/ai-sdk`](src/ai-sdk/), and [`src/batching`](src/batching/) | First-party adapters that compose typed model operations rather than inventing write verbs. |
| [`src/cli`](src/cli/) | CLI commands and project scaffolding only. |
| [`src/testing`](src/testing/) and [`src/adapters`](src/adapters/) | Reusable test support and injected platform adapters. |
| [`src/interfaces`](src/interfaces/), [`src/types`](src/types/), and [`src/utils`](src/utils/) | Shared leaves only; a feature-specific type or helper stays with its feature. |

Tests stay beside a narrow module in `src/**/__tests__`. Cross-module suites go
in [`__tests__/unit`](__tests__/unit/), [`integration`](__tests__/integration/),
[`contract`](__tests__/contract/), [`property`](__tests__/property/), or
[`e2e`](__tests__/e2e/) according to the boundary they prove.

## Flows

### Request

1. `Ablo({ schema, ... })` validates one constructor shape and derives the typed
   `ablo.<model>` properties from that schema.
2. The facade selects the stateful sync runtime or private HTTP transport from
   `transport`; callers keep the same model names and verbs.
3. Auth, protocol version, retry, and envelope details stay inside the selected
   transport and cross the server boundary once.

### Read

1. Application code calls `ablo.<model>.retrieve({ id })` or `.list(...)`.
2. The stateful client goes through `createModelProxy` and `OnDemandLoader`; the
   HTTP client goes through the typed HTTP facade and private `httpTransport`.
3. Network results hydrate or return typed rows. `get`, `getAll`, and `getCount`
   read the already-loaded local graph and never create another read protocol.

### Write

1. Application code calls `ablo.<model>.create`, `.update`, or `.delete`.
2. The stateful path records operations, applies them optimistically, and sends
   one commit over sync. The HTTP path encodes the same commit behind
   `httpTransport`.
3. A receipt or authoritative delta confirms the commit; rejection rolls back
   the optimistic state. Every adapter must compile to this path.

### Live update

1. The WebSocket layer decodes a versioned frame in `wire`.
2. `SyncClient` and the delta pipeline apply ordered deltas to the local graph.
3. Model observers and React bindings see the updated row; transport shapes do
   not escape into them.

## Compatibility boundary

Legacy names or shapes may exist only in a named wire codec, a durable/database
codec or migration, or environment-variable parsing. Normalize once at ingress
and encode once at egress. Do not keep compatibility through duplicate public
methods, domain aliases, alternate folder names, or branches spread through the
runtime. A compatibility branch needs a deployed version, a fixture, and a
removal condition.

## No-downtime contract change

Use `expand → dual read/write → backfill → verify → contract`:

1. **Expand:** add an optional wire codec or nullable database shape; deploy the
   server before requiring it from clients.
2. **Dual read/write:** accept old and current persisted shapes, normalize both
   to the current runtime model, and write both only when rollout requires it.
3. **Backfill:** move stored data in resumable, idempotent chunks while traffic
   continues.
4. **Verify:** prove current and previous clients over HTTP and WebSocket, replay
   old durable writes, test before/during/after migration, then switch reads only
   when old traffic and old data are absent.
5. **Contract:** remove the old codec, write, or column in a later deploy. Only
   then raise the minimum protocol version.

Never combine additive expansion and destructive contraction for a live field.

## Test layers

Run these from `packages/sync-engine`. The commands and expansions below are the
current `package.json` scripts.

| Layer | Command | Script |
| --- | --- | --- |
| Library + CLI build | `npm run build` | `npm run clean && tsc -p tsconfig.build.json && npm run build:cli` |
| CLI types | `npm run typecheck:cli` | `tsc -p tsconfig.cli.json` |
| Full non-E2E suite | `npm test` | `pretest`: `node scripts/check-dist-fresh.mjs`; `test`: `jest` |
| Unit | `npm run test:unit` | `jest --testPathPatterns __tests__/unit` |
| Integration | `npm run test:integration` | `jest --testPathPatterns __tests__/integration` |
| Public/wire contract | `npm run test:contract` | `jest --testPathPatterns __tests__/contract` |
| Invariant/property | `npm run test:property` | `jest --testPathPatterns __tests__/property` |
| Coverage | `npm run test:coverage` | `jest --coverage` |
| Packed quickstart | `npm run test:quickstart` | `node scripts/test-quickstart.mjs` |
| Docker E2E lifecycle | `npm run test:e2e:run` | `node scripts/run-e2e.mjs` |
| E2E setup / test / teardown | `npm run test:e2e:up`; `npm run test:e2e`; `npm run test:e2e:down` | `docker compose -f docker-compose.test.yml up -d --wait`; `E2E_TEST=true jest --config jest.e2e.config.ts`; `docker compose -f docker-compose.test.yml down -v` |
| Source, contract, and generated-doc lint | `npm run lint` | `npm run lint:imports && npm run lint:errors && npm run lint:docs && npm run lint:docs-site` |

A contract change is complete only when its boundary fixtures exist and both
current and previous deployed shapes stay green through the support window.
