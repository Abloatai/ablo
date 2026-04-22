# Changelog

## 0.3.0 (2026-04-22)

Umbrella `<AbloProvider>` for React apps. One provider component now owns the full lifecycle — singleton rotation on auth change, Strict-Mode-safe bootstrap, `beforeunload` cleanup, session-expiry IndexedDB wipe, post-bootstrap hooks, mesh client construction. Replaces the ad-hoc provider glue every consumer had to write themselves.

Inspired by Zero's `ZeroProvider` and Liveblocks' `LiveblocksProvider`: declarative props for app glue, tagged-union status hook, automatic lifecycle. `apps/web`'s integration shrank from 515 LOC of hand-rolled singleton/AbortController/beforeunload/reaction-bridge wiring to a 60-LOC thin wrapper that just passes props through.

### Added

- `<AbloProvider>` — umbrella provider at `@ablo/sync-engine/react`. Props include data config (`schema`, `url`, `userId`, `organizationId`), auth (`capabilityToken` / `apiKey` / session cookie fallback), declarative behavior (`preventUnsavedChanges`, `lostConnectionTimeout`, `postBootstrap`), callbacks (`onSessionExpired`, `onError`, `resolveUsers`), and DI escape hatches.
- `<SyncGroupProvider id="matter:...">` + `useSyncGroup()` — Liveblocks-style per-entity scope context.
- `<ClientSideSuspense fallback={...}>` — gate renders until the engine reports `connected`. Phase-1 non-Suspense; phase-2 upgrades to real Suspense.
- `useSyncStatus()` rewritten as a tagged union: `{ name: 'initial' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'needs-auth', ... }`. Impossible states are unrepresentable.
- `useCurrentUserId()` — returns the `userId` prop. Replaces downstream consumers' defineProperty hacks on the store.
- `useErrorListener(cb)` — imperative error callback (Sentry/Datadog).
- `useSync<R>()` and `useSyncStore<T>()` accept generic parameters so consumers can widen to their concrete schema types without `as unknown` casts at call sites.
- `BaseSyncedStore.purge()` / `SyncEngine.purge()` — disconnect + wipe every `ablo_*` / `ablo-*` IndexedDB. Called automatically on session expiry.
- `SyncEngine.onSessionError(listener)` — subscribe to session-error events. Multiple subscribers supported.
- Commit payload projection built into `TransactionQueue`. Mutations are automatically projected onto the model's schema-declared fields (dropping framework internals `__class` / `__typename` / `clientId` / `syncStatus` and anything not declared), with `field.json()` values auto-stringified for TEXT columns and `undefined` dropped on updates. No config port, no consumer hook — the SDK derives correct wire payloads from the schema alone. Apps that previously maintained hand-rolled extractor tables can delete them entirely.

### Breaking (continued)

- Removed `SyncEngineConfig.extractCreateInput` and `SyncEngineConfig.buildUpdateInput`. The SDK's built-in projection replaces them. Consumers who passed these in `configOverrides` should delete the override; the default now covers 100% of identity-column mutations. The `configOverrides` prop still exists but its remaining fields are all deprecated (see below) and scheduled for removal in v0.4.

### Deprecated (vestigial — removal in v0.4)

- `SyncEngineConfig.modelCreatePriority`, `defaultCreatePriority`, `defaultNonCreatePriority` — never read at runtime.
- `SyncEngineConfig.batchableModels` — never read at runtime.
- `SyncEngineConfig.dedicatedDeleteModels` — never read at runtime.
- `SyncEngineConfig.preserveCaseModels` — never read at runtime.
- `SyncEngineConfig.essentialFields` — used only in debug logging, no behavioral effect.
- `SyncEngineConfig.classNameFallbackMap` — dead path; `ModelRegistry.registerModelsFromSchema` registers by constructor identity, bypassing the class-name fallback entirely.

### Breaking

- Removed `<SyncProvider>` — folded into `<AbloProvider>`. Migrate by swapping the provider and passing `userId`/`organizationId`/`url` instead of a pre-constructed store.
- Removed `createAbloContext()` factory and its returned `AbloProvider` / `useAblo` / `useParticipant` triple. Mesh is now always-on inside `<AbloProvider>`; `useAblo()` and `useParticipant(opts)` are always available. Schema-typed mesh hooks are on the roadmap.
- Removed `withSync` (no-op alias of `observer`). Import `observer` from `mobx-react-lite` directly if needed.
- Removed `useSyncContext` from the public surface (never used outside the SDK's test helpers).
- `useSyncStatus()` return shape changed from six booleans to a tagged union. Migration: `const { isReady } = useSyncStatus()` → `const status = useSyncStatus(); const isReady = status.name === 'connected'`.
- `SyncStoreContract` gained six sync-status getters and a `syncStatus` field. Third-party classes implementing the contract must add these (additive for callers).

### Migration

```tsx
// Before (0.2.x)
const { AbloProvider, useAblo, useParticipant } = createAbloContext<typeof schema>();

function Root() {
  const sync = createSyncEngine({ url, schema, user });
  const ablo = new Ablo({ schema });
  return (
    <SyncProvider store={sync._store} organizationId={orgId}>
      <AbloProvider ablo={ablo}>
        <App />
      </AbloProvider>
    </SyncProvider>
  );
}

// After (0.3.0)
function Root() {
  return (
    <AbloProvider
      schema={schema}
      url={url}
      userId={userId}
      organizationId={orgId}
      preventUnsavedChanges
      onSessionExpired={() => router.replace('/signin')}
    >
      <ClientSideSuspense fallback={<Skeleton />}>
        <App />
      </ClientSideSuspense>
    </AbloProvider>
  );
}
```

No breaking change to `useQuery` / `useOne` / `useMutate` / `useReader` / `useMutators` / `useUndoScope` / `usePresence` / `useIntent` — call sites remain source-compatible.

## 0.2.1 (2026-04-22)

React bindings hardening. Fixes two infinite-loop classes that surfaced in downstream apps as React error #185 ("Maximum update depth exceeded"), and exposes sync-status reactivity as a first-class observable + hook.

### Fixed

- **`useQuery` / `useOne` no longer loop on `getSnapshot`.** The `useSyncExternalStore` adapter was returning a fresh `view.results.slice()` on every call, which React's post-commit consistency check interpreted as "store updated mid-render" — scheduling another render, another snapshot, another mismatch, ad infinitum. The snapshot is now cached in a ref and only refreshed inside the subscribe callback right before `onChange()` fires. Affected every tree with multiple simultaneous `useQuery` subscribers.

### Added

- **`BaseSyncedStore` sync status is now properly observable.** `syncStatus` and `dataReady` are annotated `observable`; `isReady`, `isSyncing`, `isOffline`, `isReconnecting`, `isError`, `hasUnsyncedChanges` are `computed`. Before, these were plain getters over plain fields — `reaction(() => store.isReady, ...)` silently never fired. Existing `observer` / `reaction` call sites that relied on the implicit `pool.size` trigger will continue to work; new call sites should read these observables directly.
- **`useSyncStatus()` React hook.** Returns `{ isReady, isSyncing, isOffline, isReconnecting, isError, hasUnsyncedChanges }` as a reactive snapshot, bridged via `useSyncExternalStore` with a correctly-cached snapshot. Replaces hand-rolled `reaction` bridges in consumer providers. See `docs/react.md`.
- **`SyncStoreContract` surfaces the status getters** so TypeScript autocomplete works from the `useSyncContext()` return value without a cast.

### Documentation

- **`llms.txt` and `docs/react.md`** gained a "Common pitfalls" section covering the three traps this release addresses: don't wrap providers in `observer()`, `getSnapshot` must return a cached reference, and sync-status fields are real observables (don't watch `pool.size` as a proxy).

### Migration

No breaking changes. Optional: replace any local `reaction(() => store.isReady, setReady, { fireImmediately: true })` bridges in your own providers with `const { isReady } = useSyncStatus()` for consumers below the store provider.

## 0.2.0 (2026-04-21)

Mesh SDK — the canonical agent-multiplayer surface. Locked at this release; further work is consolidation, not expansion.

### What's frozen

The SDK covers exactly three integration shapes. Each has a canonical example in [`examples/`](./examples/):

1. **Server agent** — `new Ablo({ schema })` reads `ABLO_API_KEY`, joins and works. ([`examples/server-agent.ts`](./examples/server-agent.ts))
2. **Browser app** — server mints a scoped capability, browser holds it via `new Ablo({ schema, capabilityToken })`. No API key in bundle, no session cookies, no allowed-origins registration required. Stripe `client_secret` shape. ([`examples/browser-app.ts`](./examples/browser-app.ts))
3. **Sub-agent** — `parent.join(child, opts)` attenuates from the parent's capability. ([`examples/sub-agent.ts`](./examples/sub-agent.ts))

### Ergonomics (package-wide)

- **`Ablo` class** — `import Ablo from '@ablo/sync-engine'` / `new Ablo({ schema })`. Matches `new Stripe()` / `new OpenAI()` / `new Anthropic()` pattern. `createMesh(opts)` stays available as the functional alias.
- **Model-scoped joins** — `ablo.matters.join(id, { label })` desugars to the generic `join`. Proxy-based so the namespace adapts to any schema. Collisions with reserved admin fields (`roles`, `members`, `audit`, `capabilities`) throw at construction time.
- **Flat scope form** — `scope: { matters: id }` alongside the array form.
- **`as` alias** — `{ as: session({...}) }` replaces the security-jargon `onBehalfOf`; both still accepted.
- **Auto-connect** — `join()` returns a connected participant. `autoConnect: false` to opt out.
- **Duration strings** — `ttl: '3m'`, `ttlSeconds: '24h'` accepted alongside numbers.
- **Descriptive generics** — every public type uses `TSchema` / `TAgent` / `ModelName` instead of `S` / `A` / `K`. Zero `unknown` in public types.

### Coordination primitives

- **Presence verbs** — `participant.presence.editing(target)` / `viewing(target)` / `idle()`. Plus `update({...})` escape hatch for custom actions.
- **Intent verbs** — `participant.intents.editing(target, opts)` / `writing(target, opts)`. Returns an `IntentHandle` with `Symbol.asyncDispose` so `await using work = ...` auto-revokes.
- **Snapshots** — `const snap = await participant.snapshot({ clauses: [id] })`. Flat shape: `snap.clauses[id]` (typed from schema via `InferModel`, not `unknown`), `snap.stamp`, `snap.signal` (AbortSignal).
- **Async iterables** — `for await (const peers of participant.presence)`, `for await (const openIntents of participant.intents)`, `for await (const delta of participant.deltas)`.

### Env / config

- `ABLO_API_KEY` — required for server-side use.
- `ABLO_BASE_URL` — optional override for staging / local-dev (defaults to `https://mesh.ablo.finance`). Not a customer-facing self-hosting path.
- `organizationId` — **no longer required** in `createMesh`. The API key or session binds the caller to one org; the capability mint response echoes it back.
- `createMeshFromEnv` — removed. `new Ablo({ schema })` auto-reads env.

### Test coverage

- 53 mesh unit tests across 8 suites (`__tests__/unit/mesh/`)
- New E2E test `e2e-browser-capability-token.ts` proves the Stripe-shaped browser flow end-to-end
- Existing 12 mesh E2E tests (token refresh, watermark, chinese wall, etc.) still pass

---

## 0.1.0 (2026-04-10)

Initial release.

### Features

- **Schema DSL**: Zero-codegen schema definition with full TypeScript inference (`defineSchema`, `field`, `relation`)
- **React Hooks**: `useModels`, `useModel`, `useMutations`, `withSync` for reactive data binding
- **Consumer API**: `createSyncEngine()` — one-liner setup that hides all internal wiring
- **Offline-first**: IndexedDB persistence with automatic offline mutation queue and FK-safe flush
- **Real-time sync**: WebSocket delta streaming with optimistic updates and rollback
- **AI Agent SDK**: `SyncAgent` for backend/AI agent participation as first-class sync citizens
- **Pluggable auth**: `AuthProvider` interface with built-in API key, JWT, and session providers
- **Security**: IndexedDB cleanup on session expiry and sync group revocation
- **Testing utilities**: `@ablo/sync-engine/testing` subpath with mocks, fixtures, and harness

### Test Coverage

- 231 unit/integration/property/contract tests
- 50 E2E tests against real Go server + PostgreSQL + Redis
- Property-based testing via fast-check
