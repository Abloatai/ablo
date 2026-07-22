/**
 * React bindings for `@abloatai/ablo`.
 *
 * # Provider
 *
 * Build a client once — at module scope or with `useMemo` — and wrap your tree:
 *
 *   const ablo = Ablo({ schema, apiKey })
 *   <AbloProvider client={ablo} fallback={<Skeleton/>}>
 *
 * `client` is the only required prop; you construct it, and the provider is the
 * thin reactive binding around it. The provider owns the sync-engine and
 * multiplayer lifecycle. Its `fallback` gates children until the first sync
 * bootstrap completes — pass `fallback="passthrough"` to render children
 * immediately. `userId` is optional and informational.
 *
 * {@link ClientSideSuspense} adds a nested gate inside an already-ready
 * provider. Reach for it only when a heavy subtree, such as a canvas, needs its
 * own gate while the rest of the app renders right away; the provider-level
 * `fallback` is the usual path.
 *
 * # Data hooks
 *
 *   useAblo((ablo) => ablo.tasks.local.retrieve(id))  — subscribe to a local snapshot (the main read API)
 *   useAblo()                              — the typed client, for callbacks and effects:
 *                                            synchronous local reads (`ablo.<model>.local.retrieve`/`local.list`),
 *                                            async server reads (`retrieve`/`list`),
 *                                            and writes (`create`/`update`/`delete`)
 *   useMutators(defs, opts?)               — define custom mutators
 *   useUndoScope(name)                     — per-surface undo and redo
 *
 * # Status and errors
 *
 *   useSyncStatus()       — a discriminated-union snapshot of the sync lifecycle
 *   useErrorListener(cb)  — an imperative error callback, for telemetry or toasts
 *   useCurrentUserId()    — the provider's `userId` prop
 *
 * # Multiplayer
 *
 * Multiplayer is always available, because `<AbloProvider>` always constructs a
 * client:
 *
 *   useAblo((ablo) => ablo.<model>.claim.state(...))  — reactive coordination reads
 *   useJoin({ scope })                                — join a scope to get its peers and claims
 */

// ── Typed-global resolvers ─────────────────────────────────────────
export type {
  DefaultSyncShape,
  ResolveSchema,
  ResolveUserMeta,
  ResolveClaimMeta,
  ResolveModelKey,
} from '../transaction/types/global.js';

// ── Umbrella provider + lifecycle hooks ────────────────────────────
export {
  AbloProvider,
  useJoin,
  usePeers,
  useSync,
  useSyncStore,
  type AbloProviderProps,
  type ParticipantScope,
  type ParticipantStatus,
  type UseJoinOptions,
  type UseJoinReturn,
} from './AbloProvider.js';

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
// The CRUD and read action types are defined in a React-free module and
// re-exported here. Read and write through `useAblo` and `ablo.<model>.*`.
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

// ── ModelScope re-export ───────────────────────────────────────────
export { ModelScope } from '../transaction/types/index.js';
