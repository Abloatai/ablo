/**
 * @abloatai/ablo/react — React bindings (v0.3.0)
 *
 * Umbrella provider:
 *   <AbloProvider schema={...} userId={...} orgId={...} fallback={<Skeleton/>}>
 *     — owns sync engine + multiplayer lifecycle; the `fallback` prop
 *     gates children on first bootstrap. Pass `fallback="passthrough"`
 *     to disable the gate.
 *   <SyncGroupProvider id="matter:...">         — per-entity scope
 *   <ClientSideSuspense fallback={<Skeleton/>}> — NESTED gate inside an
 *     already-ready provider. Use only when you need a separate gate
 *     for a heavy subtree (e.g. a canvas) while app chrome renders
 *     immediately. The provider-level `fallback` is the default path.
 *
 * Data hooks:
 *   useAblo((ablo) => ablo.tasks.get(id))     — primary React read API (sync local snapshot)
 *   useAblo()                                  — typed client for callbacks/effects
 *                                                (sync local reads: ablo.<model>.get/getAll;
 *                                                 async server reads: ablo.<model>.retrieve/list;
 *                                                 writes: ablo.<model>.create/update/delete)
 *   useMutators(defs, opts?)                   — Zero-style custom mutators
 *   useUndoScope(name)                         — per-surface undo/redo
 *
 * Status + errors:
 *   useSyncStatus()           — tagged-union lifecycle snapshot
 *   useErrorListener(cb)      — imperative error callback (Sentry/Datadog)
 *   useCurrentUserId()        — the provider's userId prop
 *
 * Multiplayer (always available — `<AbloProvider>` always constructs a client):
 *   useAblo((ablo) => ablo.<model>.claim.state(...)) — reactive coordination reads
 *   useParticipant({ scope }) — join multiplayer for a scope, get peers/claims
 *   usePresence()             — typed presence view
 *   useClaim(name)           — typed claim dispatcher
 *
 * ── Breaking changes from v0.2.x ───────────────────────────────────
 * Removed: <SyncProvider>, SyncContext, useSyncContext — folded into
 *   <AbloProvider>. Access the raw engine with `useSync()`.
 * Removed: createAbloContext() factory + its returned AbloProvider —
 *   multiplayer is now always-on inside <AbloProvider>. Schema-typed
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
  ResolveClaims,
  ResolveUserMeta,
  ResolveModelKey,
} from '../types/global.js';

// ── Umbrella provider + lifecycle hooks ────────────────────────────
export {
  AbloProvider,
  useParticipant,
  usePeers,
  useSync,
  useSyncStore,
  type AbloProviderProps,
  type ParticipantScope,
  type ParticipantStatus,
  type UseParticipantOptions,
  type UseParticipantReturn,
  type MeshParticipantStatus,
} from './AbloProvider.js';

export {
  SyncGroupProvider,
  useSyncGroup,
  type SyncGroupProviderProps,
} from './SyncGroupProvider.js';

export {
  ClientSideSuspense,
  type ClientSideSuspenseProps,
} from './ClientSideSuspense.js';

export { DefaultFallback } from './DefaultFallback.js';

// ── Context types (for test doubles) ───────────────────────────────
export type { SyncStoreContract } from './context.js';

// ── Status + errors + identity ─────────────────────────────────────
export {
  useSyncStatus,
  type SyncStatusSnapshot,
} from './useSyncStatus.js';

export { useErrorListener } from './useErrorListener.js';
export {
  useMutationFailureListener,
  type MutationFailurePayload,
} from './useMutationFailureListener.js';
export { useCurrentUserId } from './useCurrentUserId.js';

// ── Primitive for building custom reactive hooks ──────────────────
//
// Consumers building bespoke hooks on top of the SDK should call
// `useReactive(() => compute())` instead of reaching for React's
// lower-level `useSyncExternalStore`. Hides the cached-snapshot
// contract and handles default structural equality for arrays.
export { useReactive } from './useReactive.js';

// ── Data hooks ─────────────────────────────────────────────────────
// CRUD/read action types live in the React-free core now (the legacy
// useQuery/useOne/useMutate/useReader hooks were removed — use `useAblo` +
// `ablo.<model>.*`). Re-exported here for callers that referenced the types.
export type { MutateActions } from '../mutators/mutateActions.js';
export type { ReaderActions, ReaderFindOptions } from '../mutators/readerActions.js';
export {
  useMutators,
  type MutatorInvokers,
  type InvokerFor,
  type UseMutatorsOptions,
} from './useMutators.js';
export { useUndoScope, type UseUndoScopeResult } from './useUndoScope.js';
export {
  useAblo,
  type UseAbloHydratedModelResult,
  type UseAbloModelOptions,
  type UseAbloModelResult,
} from './useAblo.js';

// ── Presence + claim (typed via Register module augmentation) ─────
export { usePresence } from './usePresence.js';
export { useClaim } from './useClaim.js';

// ── ModelScope re-export ───────────────────────────────────────────
export { ModelScope } from '../types/index.js';
