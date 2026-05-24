/**
 * @ablo/sync-engine/react — React bindings (v0.3.0)
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
 *   useAblo((ablo) => ablo.tasks.retrieve(id)) — primary React read API
 *   useAblo()                                  — typed client for callbacks/effects
 *   useQuery/useOne/useReader/useMutate        — compatibility helpers for older
 *                                                string-keyed integrations
 *   useMutators(defs, opts?)                   — Zero-style custom mutators
 *   useUndoScope(name)                         — per-surface undo/redo
 *
 * Status + errors:
 *   useSyncStatus()           — tagged-union lifecycle snapshot
 *   useErrorListener(cb)      — imperative error callback (Sentry/Datadog)
 *   useCurrentUserId()        — the provider's userId prop
 *
 * Multiplayer (always available — `<AbloProvider>` always constructs a client):
 *   useAblo((ablo) => ablo.intents.list(...)) — reactive coordination reads
 *   useParticipant({ scope }) — join multiplayer for a scope, get peers/claims
 *   usePresence()             — typed presence view
 *   useIntent(name)           — typed intent dispatcher
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
  ResolveIntents,
  ResolveUserMeta,
  ResolveModelKey,
} from '../types/global.js';

// ── Umbrella provider + lifecycle hooks ────────────────────────────
export {
  AbloProvider,
  useParticipant,
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
export { useQuery, useOne, type QueryOptions } from './useQuery.js';
export { useMutate, type MutateActions } from './useMutate.js';
export { useReader, type ReaderActions, type ReaderFindOptions } from './useReader.js';
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

// ── Presence + intent (typed via AbloSync global augmentation) ─────
export { usePresence } from './usePresence.js';
export { useIntent } from './useIntent.js';

// ── ModelScope re-export ───────────────────────────────────────────
export { ModelScope } from '../types/index.js';
