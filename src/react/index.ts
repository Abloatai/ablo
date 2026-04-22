/**
 * @ablo/sync-engine/react — React bindings (v0.3.0)
 *
 * Umbrella provider:
 *   <AbloProvider schema={schema} url={...} userId={...} orgId={...} />
 *     — owns sync engine + mesh client lifecycle.
 *   <SyncGroupProvider id="matter:...">         — per-entity scope
 *   <ClientSideSuspense fallback={<Skeleton/>}> — gate children on isReady
 *
 * Data hooks (no wrapper required — self-subscribing via useSyncExternalStore):
 *   useQuery(key, options?)   — reactive collection (IVM-backed)
 *   useOne(key, id)           — reactive single entity
 *   useReader(key)            — imperative typed reads (findById/findMany/...)
 *   useMutate(key)            — CRUD + batch writes
 *   useMutators(defs, opts?)  — Zero-style custom mutators
 *   useUndoScope(name)        — per-surface undo/redo
 *
 * Status + errors:
 *   useSyncStatus()           — tagged-union lifecycle snapshot
 *   useErrorListener(cb)      — imperative error callback (Sentry/Datadog)
 *   useCurrentUserId()        — the provider's userId prop
 *
 * Mesh (always available — `<AbloProvider>` always constructs a client):
 *   useAblo()                 — raw AbloClient
 *   useParticipant({ scope }) — join mesh for a scope, get peers/claims
 *   usePresence()             — typed presence view
 *   useIntent(name)           — typed intent dispatcher
 *
 * ── Breaking changes from v0.2.x ───────────────────────────────────
 * Removed: <SyncProvider>, SyncContext, useSyncContext — folded into
 *   <AbloProvider>. Access the raw engine with `useSync()`.
 * Removed: createAbloContext() factory + its returned AbloProvider —
 *   mesh is now always-on inside <AbloProvider>. Schema-typed
 *   participant hooks ship in a follow-up release.
 * Removed: withSync (no-op alias of observer). Import observer
 *   from mobx-react-lite directly if you still need it.
 * Changed: useSyncStatus() now returns a discriminated union. See the
 *   migration notes in CHANGELOG.md.
 */

// ── Typed-global resolvers ─────────────────────────────────────────
export type {
  DefaultSyncShape,
  ResolveSchema,
  ResolvePresence,
  ResolveIntents,
  ResolveUserMeta,
  ResolveModelKey,
} from '../types/global';

// ── Umbrella provider + lifecycle hooks ────────────────────────────
export {
  AbloProvider,
  useAblo,
  useParticipant,
  useSync,
  useSyncStore,
  type AbloProviderProps,
  type UseParticipantOptions,
  type UseParticipantReturn,
  type MeshParticipantStatus,
} from './AbloProvider';

export {
  SyncGroupProvider,
  useSyncGroup,
  type SyncGroupProviderProps,
} from './SyncGroupProvider';

export {
  ClientSideSuspense,
  type ClientSideSuspenseProps,
} from './ClientSideSuspense';

// ── Context types (for test doubles) ───────────────────────────────
export type { SyncStoreContract } from './context';

// ── Status + errors + identity ─────────────────────────────────────
export {
  useSyncStatus,
  type SyncStatusSnapshot,
} from './useSyncStatus';

export { useErrorListener } from './useErrorListener';
export { useCurrentUserId } from './useCurrentUserId';

// ── Primitive for building custom reactive hooks ──────────────────
//
// Consumers building bespoke hooks on top of the SDK should call
// `useReactive(() => compute())` instead of reaching for React's
// lower-level `useSyncExternalStore`. Hides the cached-snapshot
// contract and handles default structural equality for arrays.
export { useReactive } from './useReactive';

// ── Data hooks ─────────────────────────────────────────────────────
export { useQuery, useOne, type QueryOptions } from './useQuery';
export { useMutate, type MutateActions } from './useMutate';
export { useReader, type ReaderActions, type ReaderFindOptions } from './useReader';
export {
  useMutators,
  type MutatorInvokers,
  type InvokerFor,
  type UseMutatorsOptions,
} from './useMutators';
export { useUndoScope, type UseUndoScopeResult } from './useUndoScope';

// ── Presence + intent (typed via AbloSync global augmentation) ─────
export { usePresence } from './usePresence';
export { useIntent } from './useIntent';

// ── ModelScope re-export ───────────────────────────────────────────
export { ModelScope } from '../types';
